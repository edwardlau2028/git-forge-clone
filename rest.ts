// rest.ts — the GitHub REST v3 surface under /api/v3. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry {"message": string}; unknown routes are 404.

import {
  Forge,
  Repo,
  SERVER_TIME_STRING,
  isOid,
  parseCommit,
  repoJson,
  issueJson,
  pullJson,
  putContents,
  deleteContents,
  createIssue,
  createPullRequest,
  mergePullRequest,
  diffTrees,
  blobLineCount,
} from './store.ts';

export interface RestReply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestReply {
  return { status, json, headers };
}
function err(status: number, message: string): RestReply {
  return { status, json: { message } };
}

export interface RestContext {
  forge: Forge;
  /** The request origin (scheme + host), for absolute Link pagination URLs. */
  origin: string;
  /** The raw path after /api/v3 (no leading slash), for Link URLs. */
  path: string;
  query: URLSearchParams;
}

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], ctx: RestContext): { page: T[]; link: string | null } {
  const { perPage, page } = pageOf(ctx.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(ctx.query);
    next.set('per_page', String(perPage));
    next.set('page', String(page + 1));
    const last = new URLSearchParams(ctx.query);
    last.set('per_page', String(perPage));
    last.set('page', String(Math.ceil(items.length / perPage)));
    link = `<${ctx.origin}/api/v3/${ctx.path}?${next.toString()}>; rel="next", <${ctx.origin}/api/v3/${ctx.path}?${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeaders(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

/** Resolve a repo from the path; null when absent (any owner other than the viewer is 404). */
function findRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.forge.getRepo(owner, name);
  return repo ?? null;
}

function repoRef(ctx: RestContext, segments: readonly string[]): Repo | RestReply {
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return err(404, 'Not Found');
  return repo;
}

/** Resolve a ref name / sha to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.defaultTip();
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (direct !== undefined) return repo.peelToCommit(direct);
  if (isOid(ref)) return repo.peelToCommit(ref);
  return null;
}

function decodePath(segments: readonly string[]): string {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

/** Author/committer JSON for a commit object. */
function personJson(line: string): Record<string, string> {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: SERVER_TIME_STRING };
  const timestamp = Number(match[3]);
  const date = Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : SERVER_TIME_STRING;
  return { name: match[1] as string, email: match[2] as string, date };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha,
    commit: {
      message: info?.message ?? '',
      author: info === null ? { name: '', email: '', date: SERVER_TIME_STRING } : personJson(info.author),
      committer: info === null ? { name: '', email: '', date: SERVER_TIME_STRING } : personJson(info.committer),
    },
  };
}

/** Entry point: method + path segments after /api/v3 + a parsed JSON body (or null). */
export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  body: unknown,
): RestReply {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // GET /api/v3/ — the API root.
  if (segments.length === 0 && method === 'GET') {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return ok(200, { installed_version: '1.0.0' });
  }
  // GET /api/v3/user — the token owner's login.
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return ok(200, { login: ctx.forge.viewerLogin, id: 1000, name: ctx.forge.viewerLogin, email: `${ctx.forge.viewerLogin}@example.invalid` });
  }
  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(ctx.forge.listViewerRepos(), ctx);
      return ok(200, page.map(repoJson), linkHeaders(link));
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'name is required');
      const created = ctx.forge.createRepo(
        name,
        typeof b.description === 'string' ? b.description : '',
        b.private === true,
      );
      if (created === 'invalid') return err(422, `invalid repository name ${JSON.stringify(name)}`);
      if (created === 'exists') return err(422, `Repository ${ctx.forge.viewerLogin}/${name} already exists`);
      return ok(201, repoJson(created));
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const repoOrErr = repoRef(ctx, segments);
    if ('status' in repoOrErr) return repoOrErr;
    const repo = repoOrErr;
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        ctx.forge.deleteRepo(repo.owner, repo.name);
        return { status: 204, json: null };
      }
    }

    // POST /repos/{o}/{r}/git/refs — create a branch.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, `invalid ref ${JSON.stringify(ref)}`);
      if (!isOid(sha) || repo.objects.get(sha) === undefined) return err(422, `invalid sha ${JSON.stringify(sha)}`);
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const ref = decodePath(rest.slice(2));
      const oid = repo.refs.get(ref);
      if (oid === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha: oid } });
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string } }));
      return ok(200, branches);
    }
    // GET /repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = decodePath(rest.slice(1));
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha: oid } });
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const tip = resolveRef(repo, ctx.query.get('sha'));
      if (tip === null) return ok(200, []);
      const history = repo.commitHistory(tip);
      return ok(200, history.map((sha) => commitJson(repo, sha)));
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const path = decodePath(rest.slice(1));
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : '';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        if (path === '') return err(422, 'a file path is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          return err(400, 'content is not valid base64');
        }
        const existed = (() => {
          const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.defaultTip();
          if (tip === null) return false;
          const tree = repo.objects.get(tip)?.type === 'commit' ? parseCommit(repo.objects.get(tip)!.data).tree : null;
          if (tree === null) return false;
          return repo.flattenTree(tree).has(path);
        })();
        const result = putContents(ctx.forge, repo, path, content, message, branch, sha);
        if (result === 'stale') return err(409, `sha mismatch for ${path}`);
        return ok(existed ? 200 : 201, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.contentSha,
            size: result.size,
            encoding: 'base64',
            content: content.toString('base64'),
          },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'GET') {
        const tip = resolveRef(repo, ctx.query.get('ref'));
        if (tip === null) return err(404, 'Not Found');
        const treeOid = repo.objects.get(tip)?.type === 'commit' ? parseCommit(repo.objects.get(tip)!.data).tree : null;
        if (treeOid === null) return err(404, 'Not Found');
        if (path === '') {
          const flat = repo.flattenTree(treeOid);
          const top = new Map<string, { type: string; oid: string }>();
          for (const [p, value] of flat) {
            const slash = p.indexOf('/');
            if (slash < 0) top.set(p, { type: 'file', oid: value.oid });
            else top.set(p.slice(0, slash), { type: 'dir', oid: '' });
          }
          const entries = [...top.entries()].sort().map(([name, value]) => {
            if (value.type === 'dir') {
              const tree = repo.buildTreeFromFlat(new Map([...flat.entries()].filter(([p]) => p.startsWith(`${name}/`)).map(([p, v]) => [p.slice(name.length + 1), v])));
              return { type: 'dir', name, path: name, sha: tree };
            }
            const entry = flat.get(name) as { oid: string };
            return { type: 'file', name, path: name, sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 };
          });
          return ok(200, entries);
        }
        const flat = repo.flattenTree(treeOid);
        const file = flat.get(path);
        if (file !== undefined) {
          const object = repo.objects.get(file.oid);
          const data = object?.data ?? Buffer.alloc(0);
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            sha: file.oid,
            size: data.length,
            name: path.split('/').pop() ?? path,
            path,
          });
        }
        // A directory: entries directly under `path/`.
        const prefix = `${path}/`;
        const children = new Map<string, { type: string; oid: string; size: number }>();
        for (const [p, value] of flat) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            children.set(restPath, { type: 'file', oid: value.oid, size: repo.objects.get(value.oid)?.data.length ?? 0 });
          } else {
            children.set(restPath.slice(0, slash), { type: 'dir', oid: '', size: 0 });
          }
        }
        if (children.size === 0) return err(404, 'Not Found');
        const entries = [...children.entries()].sort().map(([name, value]) => {
          if (value.type === 'dir') {
            const sub = new Map([...flat.entries()].filter(([p]) => p.startsWith(`${prefix}${name}/`)).map(([p, v]) => [p.slice(prefix.length + name.length + 1), v]));
            return { type: 'dir', name, path: `${path}/${name}`, sha: repo.buildTreeFromFlat(sub) };
          }
          return { type: 'file', name, path: `${path}/${name}`, sha: value.oid, size: value.size };
        });
        return ok(200, entries);
      }
      if (method === 'DELETE') {
        const message = typeof b.message === 'string' ? b.message : '';
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        const commitSha = deleteContents(ctx.forge, repo, path, message, sha);
        if (commitSha === null) return err(404, 'Not Found');
        return ok(200, { commit: { sha: commitSha } });
      }
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok(201, { name: existing.name, color: existing.color });
      const color = typeof b.color === 'string' ? b.color : 'ededed';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color });
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest.length >= 1 && rest[0] === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        const title = typeof b.title === 'string' ? b.title : '';
        if (title === '') return err(422, 'title is required');
        const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `Label "${label}" does not exist`);
        }
        const issue = createIssue(ctx.forge, repo, title, typeof b.body === 'string' ? b.body : '', labels);
        return ok(201, issueJson(issue));
      }
      if (rest.length === 1 && method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, link } = paginate(list, ctx);
        return ok(200, page.map(issueJson), linkHeaders(link));
      }
      if (rest.length === 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(issue));
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return ok(200, issueJson(issue));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const number = Number(rest[1]);
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          repo.commentSeq += 1;
          const comment = { id: repo.commentSeq, body: bodyText };
          issue.comments.push(comment);
          return ok(201, { id: comment.id, body: comment.body });
        }
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
        }
      }
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        const head = typeof b.head === 'string' ? b.head : '';
        const base = typeof b.base === 'string' ? b.base : '';
        const title = typeof b.title === 'string' ? b.title : '';
        if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
        if (repo.refs.get(`refs/heads/${head}`) === undefined) return err(422, `head branch ${JSON.stringify(head)} does not exist`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return err(422, `base branch ${JSON.stringify(base)} does not exist`);
        const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
        if (existing !== undefined) return err(422, 'A pull request already exists for this head and base');
        const pull = createPullRequest(ctx.forge, repo, title, typeof b.body === 'string' ? b.body : '', head, base);
        if (pull === null) return err(422, 'could not create the pull request');
        return ok(201, pullJson(repo, pull));
      }
      if (rest.length === 1 && method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        const { page, link } = paginate(list, ctx);
        return ok(200, page.map((pull) => pullJson(repo, pull)), linkHeaders(link));
      }
      if (rest.length === 2) {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return err(404, 'Not Found');
        const headTip = repo.refCommit(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refCommit(`refs/heads/${pull.baseRef}`);
        if (headTip === null || baseTip === null) return ok(200, []);
        const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
        const baseTree = repo.objects.get(base)?.type === 'commit' ? parseCommit(repo.objects.get(base)!.data).tree : null;
        const headTree = repo.objects.get(headTip)?.type === 'commit' ? parseCommit(repo.objects.get(headTip)!.data).tree : null;
        const changes = diffTrees(repo, baseTree, headTree);
        return ok(200, changes.map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return err(404, 'Not Found');
        const merged = mergePullRequest(ctx.forge, repo, pull);
        if (merged === null) return err(405, 'Pull request is already merged or closed');
        if (merged === 'conflict') return err(405, 'Merge conflict');
        return ok(200, { sha: merged, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
      }
    }
  }

  return err(404, 'Not Found');
}
