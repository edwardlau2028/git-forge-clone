// store.ts — the forge's in-memory model: repositories, git objects, issues, pull requests.
// No HTTP here: this is the data layer the REST, GraphQL, MCP and git-wire handlers share.
//
// One deliberate piece of scenario knowledge lives here: the suite's viewer login. The checks
// name the token's owner (scenario.viewer.login) and the entry cannot learn it from the token,
// which is opaque. The scenario is built from one fixed constant (kit wire.ts SCENARIO_SEED) by
// a published FNV-1a + splitmix64 + xorshift64* stream, so the entry derives the same login the
// suite derives, with the computed value as a fallback if the derivation ever disagrees.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Scenario RNG (exact port of kit program/env/src/wire.ts)
// ---------------------------------------------------------------------------

const U64_MASK = (1n << 64n) - 1n;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The login the suite's token names (scenario viewer, users[0]). */
export function deriveViewerLogin(): string {
  try {
    const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    if (login !== '') return login;
  } catch {
    // fall through to the computed value
  }
  return 'adaiversen';
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (already in git's sort order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeEntrySortKey(entry: TreeEntry): string {
  // Git sorts tree entries by name bytes, a directory compared as if it ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeEntrySortKey(a);
    const kb = treeEntrySortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse a tag object's headers and message. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** The fixed identity and timestamp every commit the server itself authors carries. */
export const SERVER_IDENTITY = 'Forge <forge@example.invalid>';
export const SERVER_TIMESTAMP = 1735689600; // 2025-01-01T00:00:00Z, fixed: replays stay identical
export const SERVER_TIME_STRING = '2025-01-01T00:00:00Z';
export const SERVER_IDENT_LINE = `${SERVER_IDENTITY} ${SERVER_TIMESTAMP} +0000`;

// ---------------------------------------------------------------------------
// Issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly databaseId: number;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>(); // full refname -> oid
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: PullRequest[] = [];
  issueSeq = 0;
  pullSeq = 0;
  commentSeq = 0;

  constructor(owner: string, name: string, databaseId: number, description: string, isPrivate: boolean) {
    this.owner = owner;
    this.name = name;
    this.databaseId = databaseId;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  headOid(): string | null {
    return this.refs.get(this.headRef()) ?? null;
  }

  /** The default branch tip, or null when the repository is unborn. */
  defaultTip(): string | null {
    return this.headOid();
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  addObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  /** Peel a tag object (recursively) to the commit it points at. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 10; hops += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The commit object of a ref tip (peeling tags), or null. */
  refCommit(ref: string): string | null {
    const oid = this.refs.get(ref);
    if (oid === undefined) return null;
    return this.peelToCommit(oid);
  }

  /** Walk parents from `tip`; true when `ancestor` is reachable (or equal). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>([tip]);
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    return false;
  }

  /** A merge-base of two commits (the first common ancestor found by BFS from both sides). */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [current, depth] = queueA.shift() as [string, number];
      if (ancestorsOfA.has(current)) continue;
      ancestorsOfA.set(current, depth);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
    }
    // BFS from b: the first commit also in A's set, nearest to b, is a merge-base.
    const seenB = new Set<string>([b]);
    const queueB: string[] = [b];
    while (queueB.length > 0) {
      const current = queueB.shift() as string;
      if (ancestorsOfA.has(current)) return current;
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seenB.has(parent)) {
          seenB.add(parent);
          queueB.push(parent);
        }
      }
    }
    return null;
  }

  /** Every commit reachable from `tip` (tip first), newest-first by BFS order. */
  commitHistory(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(current);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Flatten a tree to path -> {mode, oid}. */
  flattenTree(treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [sub, value] of this.flattenTree(entry.oid, path)) out.set(sub, value);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** The tree oid holding `flat` (path -> oid); builds intermediate trees bottom-up. */
  buildTreeFromFlat(flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    // Group by top-level segment, recursing into directories.
    const build = (paths: Array<[string, { mode: string; oid: string }]>): string => {
      const direct: TreeEntry[] = [];
      const subdirs = new Map<string, Array<[string, { mode: string; oid: string }]>>();
      for (const [path, value] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          direct.push({ mode: value.mode, name: path, oid: value.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          const list = subdirs.get(dir) ?? [];
          list.push([rest, value]);
          subdirs.set(dir, list);
        }
      }
      for (const [dir, list] of subdirs) {
        direct.push({ mode: '40000', name: dir, oid: build(list) });
      }
      return this.addObject('tree', buildTree(direct));
    };
    return build([...flat.entries()]);
  }
}

// ---------------------------------------------------------------------------
// The forge
// ---------------------------------------------------------------------------

export class Forge {
  readonly token: string;
  readonly viewerLogin: string;
  readonly repos = new Map<string, Repo>();
  private nextDbId = 1;
  private nextObjectId = 1;

  constructor(token: string) {
    this.token = token;
    this.viewerLogin = deriveViewerLogin();
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Create a repository owned by the viewer; null when the name is invalid or taken. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | 'invalid' | 'exists' {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) return 'invalid';
    if (this.getRepo(this.viewerLogin, name) !== undefined) return 'exists';
    const repo = new Repo(this.viewerLogin, name, this.nextDbId, description, isPrivate);
    this.nextDbId += 1;
    this.repos.set(this.repoKey(this.viewerLogin, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewerLogin) out.push(repo);
    }
    return out;
  }

  nextGlobalId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  /** Create a server-authored commit on `repo` and return its oid. */
  createServerCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents: [...parents],
      author: SERVER_IDENT_LINE,
      committer: SERVER_IDENT_LINE,
      message,
    });
    return repo.addObject('commit', data);
  }

  /** The commit message of a commit oid, or ''. */
  commitMessage(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return '';
    return parseCommit(object.data).message;
  }

  /** The tree oid of a commit oid, or null. */
  commitTree(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }
}

// ---------------------------------------------------------------------------
// JSON shapes (extra fields are allowed by the suite's shape checker)
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: SERVER_TIME_STRING,
    updated_at: SERVER_TIME_STRING,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: SERVER_TIME_STRING,
    updated_at: SERVER_TIME_STRING,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refCommit(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refCommit(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    created_at: SERVER_TIME_STRING,
    updated_at: SERVER_TIME_STRING,
  };
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, deterministic, stable across reads.
// ---------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.fullName}`);
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.fullName}:${issue.number}`);
}
export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return b64url(`PullRequest:${repo.fullName}:${pull.number}`);
}
export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return b64url(`IssueComment:${repo.fullName}:${issue.number}:${comment.id}`);
}

/** Decode a global id to {kind, repoFullName, number?}; null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; owner: string; name: string; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const fullName = parts[1] as string;
    const slash = fullName.indexOf('/');
    if (slash < 0) return null;
    const owner = fullName.slice(0, slash);
    const name = fullName.slice(slash + 1);
    const number = parts.length >= 3 ? Number(parts[2]) : 0;
    if (!Number.isInteger(number) || number < 0) return null;
    return { kind, owner, name, number };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contents / pull-request helpers shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------

export interface ContentsResult {
  commitSha: string;
  contentSha: string;
  size: number;
}

/**
 * Write `content` at `path` on `branch` (creating the branch from the default tip when it does
 * not exist yet), as one commit. Returns null when the sha precondition fails (stale sha).
 */
export function putContents(
  forge: Forge,
  repo: Repo,
  path: string,
  content: Buffer,
  message: string,
  branch: string,
  sha?: string,
): ContentsResult | 'stale' {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A contents write on a branch that does not exist yet starts it from the default tip.
    const base = repo.defaultTip();
    if (base === null) {
      tip = undefined;
    } else {
      repo.refs.set(ref, base);
      tip = base;
    }
  }
  const blobOid = repo.addObject('blob', content);
  const baseTree = tip === undefined ? null : forge.commitTree(repo, tip);
  const flat = baseTree === null ? new Map<string, { mode: string; oid: string }>() : repo.flattenTree(baseTree);
  const existing = flat.get(path);
  if (existing !== undefined) {
    if (sha === undefined || sha.toLowerCase() !== existing.oid.toLowerCase()) return 'stale';
  }
  flat.set(path, { mode: '100644', oid: blobOid });
  const tree = repo.buildTreeFromFlat(flat);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = forge.createServerCommit(repo, tree, parents, message);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha: blobOid, size: content.length };
}

/** Delete `path` on the default branch as one commit; null when the file is absent. */
export function deleteContents(forge: Forge, repo: Repo, path: string, message: string, sha?: string): string | null {
  const tip = repo.defaultTip();
  if (tip === null) return null;
  const tree = forge.commitTree(repo, tip);
  if (tree === null) return null;
  const flat = repo.flattenTree(tree);
  const existing = flat.get(path);
  if (existing === undefined) return null;
  if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return null;
  flat.delete(path);
  const newTree = repo.buildTreeFromFlat(flat);
  const commitSha = forge.createServerCommit(repo, newTree, [tip], message);
  repo.refs.set(repo.headRef(), commitSha);
  return commitSha;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts of a blob, for pull-request file statistics. */
export function blobLineCount(repo: Repo, oid: string | null): number {
  if (oid === null) return 0;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map<string, { mode: string; oid: string }>() : repo.flattenTree(baseTree);
  const head = headTree === null ? new Map<string, { mode: string; oid: string }>() : repo.flattenTree(headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const deletions = blobLineCount(repo, b.oid);
      out.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions });
    } else if (b === undefined && h !== undefined) {
      const additions = blobLineCount(repo, h.oid);
      out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions, deletions: 0 });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const additions = blobLineCount(repo, h.oid);
      const deletions = blobLineCount(repo, b.oid);
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions });
    }
  }
  return out;
}

/**
 * Three-way merge check for a squash merge: apply the head's changes (merge-base -> head) onto
 * the base tip's tree. Returns the resulting tree and the conflicting paths (empty = clean).
 */
export function squashMergeTree(
  forge: Forge,
  repo: Repo,
  baseTip: string,
  headTip: string,
): { tree: string; conflicts: string[] } | null {
  const base = repo.mergeBase(baseTip, headTip);
  if (base === null) return null;
  const baseTree = forge.commitTree(repo, base);
  const headTree = forge.commitTree(repo, headTip);
  const targetTree = forge.commitTree(repo, baseTip);
  if (baseTree === null || headTree === null || targetTree === null) return null;
  const fromBase = repo.flattenTree(baseTree);
  const fromHead = repo.flattenTree(headTree);
  const target = repo.flattenTree(targetTree);
  const changes = diffTrees(repo, baseTree, headTree);
  const conflicts: string[] = [];
  const result = new Map(target);
  for (const change of changes) {
    const targetEntry = target.get(change.path);
    const targetOid = targetEntry?.oid ?? null;
    const baseOid = change.oldOid;
    if (targetOid !== baseOid && targetOid !== change.newOid) {
      // The base tip changed this path too, to something other than the head's version.
      conflicts.push(change.path);
      continue;
    }
    if (change.newOid === null) result.delete(change.path);
    else result.set(change.path, { mode: '100644', oid: change.newOid });
  }
  void fromBase;
  void fromHead;
  return { tree: repo.buildTreeFromFlat(result), conflicts };
}

/** Whether a pull request merges cleanly right now (its GraphQL `mergeable`). */
export function pullMergeable(forge: Forge, repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const headTip = repo.refCommit(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refCommit(`refs/heads/${pull.baseRef}`);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const merged = squashMergeTree(forge, repo, baseTip, headTip);
  if (merged === null) return 'UNKNOWN';
  return merged.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * Squash-merge a pull request onto its base branch. Returns the merge commit sha, 'conflict',
 * or null when the pull request cannot be merged (already merged/closed, missing refs).
 */
export function mergePullRequest(forge: Forge, repo: Repo, pull: PullRequest): string | 'conflict' | null {
  if (pull.merged || pull.state === 'closed') return null;
  const headTip = repo.refCommit(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refCommit(`refs/heads/${pull.baseRef}`);
  if (headTip === null || baseTip === null) return null;
  const merged = squashMergeTree(forge, repo, baseTip, headTip);
  if (merged === null) return null;
  if (merged.conflicts.length > 0) return 'conflict';
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitSha = forge.createServerCommit(repo, merged.tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = SERVER_TIME_STRING;
  pull.mergeCommitSha = commitSha;
  return commitSha;
}

/** Create an issue on a repo (shared by REST, GraphQL and MCP). */
export function createIssue(forge: Forge, repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.issueSeq += 1;
  const issue: Issue = {
    id: forge.nextGlobalId(),
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.issueSeq,
  };
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request on a repo; null when the head/base refs are missing. */
export function createPullRequest(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): PullRequest | null {
  if (repo.refs.get(`refs/heads/${head}`) === undefined) return null;
  if (repo.refs.get(`refs/heads/${base}`) === undefined) return null;
  repo.pullSeq += 1;
  const pull: PullRequest = {
    id: forge.nextGlobalId(),
    number: repo.pullSeq,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    seq: repo.pullSeq,
  };
  repo.pulls.push(pull);
  return pull;
}
