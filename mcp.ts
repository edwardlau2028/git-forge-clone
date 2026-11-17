// mcp.ts — Model Context Protocol over Streamable HTTP, revision 2026-07-28.
// JSON-RPC 2.0: server/discover, initialize, notifications/initialized,
// tools/list, tools/call. Every tool delegates to the same store REST uses.

import {
  Forge,
  createIssue,
  createPullRequest,
  mergePullRequest,
  issueGlobalId,
  pullGlobalId,
} from './store.ts';

export interface McpRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };
const PROTOCOL_VERSION = '2026-07-28';

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The repository name.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** A tool result: human-readable text plus a machine-readable payload. */
function toolResult(text: string, structured: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Fill in `full_name` from owner/repo when the caller only gave the parts. */
function fillFullName(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.full_name !== 'string' && typeof args.owner === 'string' && typeof args.repo === 'string') {
    return { ...args, full_name: `${args.owner}/${args.repo}` };
  }
  return args;
}

function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  if (typeof args.owner === 'string' && typeof args.repo === 'string') {
    return { owner: args.owner, repo: args.repo };
  }
  if (typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) return { owner: args.full_name.slice(0, slash), repo: args.full_name.slice(slash + 1) };
  }
  return null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Execute one named tool against the forge. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase();
  const base = normalized.replace(/^github__/, '');
  if (base === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : null;
    if (repoName === null) return toolError('create_repo requires "name"');
    const created = forge.createRepo(repoName, '', true);
    if (created === 'invalid') return toolError(`create_repo: invalid repository name ${JSON.stringify(repoName)}`);
    const repo = created === 'exists' ? forge.getRepo(forge.viewerLogin, repoName) : created;
    if (repo === undefined) return toolError(`create_repo: repository ${JSON.stringify(repoName)} could not be created`);
    const payload = { id: repo.databaseId, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner } };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (base === 'get_repo') {
    const pair = ownerRepoOf(args);
    if (pair === null) return toolError('get_repo requires "owner" and "repo"');
    const repo = forge.getRepo(pair.owner, pair.repo);
    if (repo === undefined) return toolError(`get_repo: repository ${pair.owner}/${pair.repo} not found`);
    const payload = { id: repo.databaseId, name: repo.name, full_name: repo.fullName, owner: { login: repo.owner } };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (base === 'create_issue') {
    const pair = ownerRepoOf(args);
    const title = typeof args.title === 'string' ? args.title : null;
    if (pair === null || title === null) return toolError('create_issue requires "owner", "repo" and "title"');
    const repo = forge.getRepo(pair.owner, pair.repo);
    if (repo === undefined) return toolError(`create_issue: repository ${pair.owner}/${pair.repo} not found`);
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = createIssue(forge, repo, title, body, []);
    if (issue === null) return toolError('create_issue: issue could not be created');
    const payload = { id: issueGlobalId(repo, issue), number: issue.number, title: issue.title, state: issue.state, body: issue.body };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (base === 'list_issues') {
    const pair = ownerRepoOf(args);
    if (pair === null) return toolError('list_issues requires "owner" and "repo"');
    const repo = forge.getRepo(pair.owner, pair.repo);
    if (repo === undefined) return toolError(`list_issues: repository ${pair.owner}/${pair.repo} not found`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
    const payload = list.map((issue) => ({
      id: issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body,
    }));
    return toolResult(JSON.stringify(payload), payload);
  }
  if (base === 'create_pull_request') {
    const pair = ownerRepoOf(args);
    const title = typeof args.title === 'string' ? args.title : null;
    const head = typeof args.head === 'string' ? args.head : null;
    const baseRef = typeof args.base === 'string' ? args.base : null;
    if (pair === null || title === null || head === null || baseRef === null) {
      return toolError('create_pull_request requires "owner", "repo", "title", "head" and "base"');
    }
    const repo = forge.getRepo(pair.owner, pair.repo);
    if (repo === undefined) return toolError(`create_pull_request: repository ${pair.owner}/${pair.repo} not found`);
    const body = typeof args.body === 'string' ? args.body : '';
    const pull = createPullRequest(forge, repo, title, body, head, baseRef);
    if (pull === null) return toolError(`create_pull_request: head ${JSON.stringify(head)} or base ${JSON.stringify(baseRef)} does not exist`);
    const payload = { id: pullGlobalId(repo, pull), number: pull.number, title: pull.title, state: pull.state, head: { ref: pull.headRef }, base: { ref: pull.baseRef } };
    return toolResult(JSON.stringify(payload), payload);
  }
  if (base === 'merge_pull_request') {
    const pair = ownerRepoOf(args);
    const pullNumber = numeric(args.pull_number);
    if (pair === null || pullNumber === null) return toolError('merge_pull_request requires "owner", "repo" and "pull_number"');
    const repo = forge.getRepo(pair.owner, pair.repo);
    if (repo === undefined) return toolError(`merge_pull_request: repository ${pair.owner}/${pair.repo} not found`);
    const pull = repo.pulls.find((entry) => entry.number === pullNumber);
    if (pull === undefined) return toolError(`merge_pull_request: pull request ${pullNumber} not found`);
    const merged = mergePullRequest(forge, repo, pull);
    if (merged === null) return toolError(`merge_pull_request: pull request ${pullNumber} not found`);
    if (merged === 'conflict') return toolError(`merge_pull_request: pull request ${pullNumber} has a merge conflict`);
    const payload = { id: pullGlobalId(repo, pull), number: pull.number, merged: true, sha: merged.sha, message: merged.message };
    return toolResult(JSON.stringify(payload), payload);
  }
  return toolError(`unknown tool ${JSON.stringify(name)}`);
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Handle one decoded JSON-RPC request. */
function handleRpc(forge: Forge, request: McpRequest): McpOutcome {
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'initialize') {
    const params = request.params ?? {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const version = ['2026-07-28', '2025-11-25', '2025-06-18'].includes(requested) ? requested : PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }),
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and expects no response body; answer 202 with no content.
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    // Byte-for-byte identical on every call: the same array, same order.
    return {
      status: 200,
      body: rpcResult(id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) }),
    };
  }
  if (method === 'tools/call') {
    const params = request.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === name.toLowerCase() || `github__${tool.name}` === name.toLowerCase());
    if (!known) {
      return { status: 200, body: rpcError(id, -32601, `unknown tool ${JSON.stringify(name)}`) };
    }
    const tool = TOOLS.find((entry) => entry.name === name.toLowerCase() || `github__${entry.name}` === name.toLowerCase()) as ToolDef;
    const args = fillFullName(rawArgs);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null) {
        return { status: 200, body: rpcResult(id, toolError(`tools/call ${tool.name}: missing required argument ${JSON.stringify(required)}`)) };
      }
    }
    const result = callTool(forge, name, args);
    return { status: 200, body: rpcResult(id, result) };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  return { status: 200, body: rpcError(id, -32601, `method not found: ${JSON.stringify(method)}`) };
}

/**
 * Handle a POST /mcp body. `rawBody` is the request bytes as received.
 * Returns the HTTP status and the JSON value to answer with (null = no body).
 */
export function handleMcp(forge: Forge, rawBody: Buffer): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: body is not valid JSON' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: body is not a JSON-RPC object' } } };
  }
  const request = parsed as McpRequest;
  if (typeof request.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'invalid request: missing method' } } };
  }
  return handleRpc(forge, request);
}
