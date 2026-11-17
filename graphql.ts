// graphql.ts — a small GraphQL v4 executor for the documents gh / github-mcp-server send:
// queries, mutations, variables, aliases, inline fragments, __type introspection and batched
// operation arrays. Unknown fields answer HTTP 200 with an `errors` array naming the field.

import {
  Forge,
  Repo,
  type Issue,
  type PullRequest,
  parseGlobalId,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  createIssue,
  createPullRequest,
  mergePullRequest,
  pullMergeable,
  diffTrees,
  parseCommit,
} from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += input[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      let variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      variables.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('variable in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueFromAst(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueFromAst(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function argsFromAst(args: readonly { name: string; value: ValueNode }[], variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = valueFromAst(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema (the fields this executor serves) and introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export class GraphQLError extends Error {
  readonly path: Array<string | number>;
  constructor(message: string, path: Array<string | number> = []) {
    super(message);
    this.name = 'GraphQLError';
    this.path = path;
  }
}

interface GqlContext {
  forge: Forge;
  viewerLogin: string;
}

type AnyRecord = Record<string, unknown>;

function typenameOf(value: unknown): string {
  if (value !== null && typeof value === 'object' && '__typename' in (value as AnyRecord)) {
    return String((value as AnyRecord).__typename);
  }
  return '';
}

function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Resolve one field on a parent value. Returns the raw value (or null). */
function resolveField(
  typeName: string,
  field: string,
  parent: unknown,
  args: Record<string, unknown>,
  ctx: GqlContext,
): unknown {
  const fields = TYPE_FIELDS[typeName];
  if (fields === undefined || !fields.includes(field)) {
    throw new GraphQLError(`Cannot query field "${field}" on type "${typeName}".`);
  }
  const record = (parent ?? {}) as AnyRecord;

  if (typeName === 'Query') {
    if (field === 'viewer') return { __typename: 'User', login: ctx.viewerLogin };
    if (field === 'repository') {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : wrapRepo(repo);
    }
    if (field === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (parsed === null) return null;
      const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
      if (repo === undefined) return null;
      if (parsed.kind === 'Repository') return wrapRepo(repo);
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.find((entry) => entry.number === parsed.number);
        return issue === undefined ? null : wrapIssue(repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.find((entry) => entry.number === parsed.number);
        return pull === undefined ? null : wrapPull(repo, pull);
      }
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined) return { __typename: '__Type', name, fields: TYPE_FIELDS[name] };
      if (ENUM_VALUES[name] !== undefined) return { __typename: '__Type', name, enumValues: ENUM_VALUES[name] };
      return null;
    }
  }

  if (typeName === '__Type') {
    if (field === 'fields') {
      const names = (record.fields as string[] | undefined) ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    }
    if (field === 'enumValues') {
      const names = (record.enumValues as string[] | undefined) ?? [];
      return names.map((name) => ({ __typename: '__EnumValue', name }));
    }
    if (field === 'name') return record.name ?? null;
  }

  if (typeName === 'Repository') {
    const repo = (record.__repo as Repo | undefined) ?? (parent as Repo);
    if (repo === undefined) return null;
    if (field === 'id') return repoGlobalId(repo);
    if (field === 'databaseId') return repo.databaseId;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return repo.fullName;
    if (field === 'owner') return { __typename: 'User', login: repo.owner };
    if (field === 'defaultBranchRef') {
      return repo.defaultTip() === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue === undefined ? null : wrapIssue(repo, issue);
    }
    if (field === 'issues') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
      const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
      let list = [...repo.issues];
      if (states !== null) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      if (after !== null) {
        list = list.filter((issue) => (direction === 'asc' ? issue.number > after : issue.number < after));
      }
      const total = list.length;
      const nodes = first === undefined ? list : list.slice(0, first);
      const hasNextPage = first !== undefined ? total > nodes.length : false;
      const endCursor = nodes.length === 0 ? null : issueCursor(nodes[nodes.length - 1]!.number);
      return {
        __typename: 'IssueConnection',
        nodes: nodes.map((issue) => wrapIssue(repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
      };
    }
    if (field === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const nodes = first === undefined ? repo.pulls : repo.pulls.slice(0, first);
      return { __typename: 'PullRequestConnection', nodes: nodes.map((pull) => wrapPull(repo, pull)) };
    }
    if (field === 'pullRequest') {
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pull === undefined ? null : wrapPull(repo, pull);
    }
  }

  if (typeName === 'Issue') {
    const issue = (record.__issue as Issue | undefined) ?? (parent as Issue);
    if (issue === undefined) return null;
    if (field === 'id') return issueGlobalId((record.__repo as Repo), issue);
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field === 'body') return issue.body;
  }

  if (typeName === 'PullRequest') {
    const pull = (record.__pull as PullRequest | undefined) ?? (parent as PullRequest);
    const repo = record.__repo as Repo;
    if (pull === undefined || repo === undefined) return null;
    if (field === 'id') return pullGlobalId(repo, pull);
    if (field === 'number') return pull.number;
    if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
    if (field === 'merged') return pull.merged;
    if (field === 'headRefName') return pull.headRef;
    if (field === 'baseRefName') return pull.baseRef;
    if (field === 'mergeable') return pullMergeable(ctx.forge, repo, pull);
    if (field === 'title') return pull.title;
    if (field === 'body') return pull.body;
    if (field === 'files') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const headTip = repo.refCommit(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refCommit(`refs/heads/${pull.baseRef}`);
      if (headTip === null || baseTip === null) {
        return { __typename: 'PullRequestChangedFileConnection', nodes: [] };
      }
      const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
      const baseTree = repo.objects.get(base)?.type === 'commit' ? parseCommit(repo.objects.get(base)!.data).tree : null;
      const headTree = repo.objects.get(headTip)?.type === 'commit' ? parseCommit(repo.objects.get(headTip)!.data).tree : null;
      const changes = diffTrees(repo, baseTree, headTree);
      const nodes = changes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path }));
      return { __typename: 'PullRequestChangedFileConnection', nodes: first === undefined ? nodes : nodes.slice(0, first) };
    }
  }

  if (typeName === 'Mutation') {
    if (field === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') throw new GraphQLError('createIssue: unknown repositoryId');
      const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
      if (repo === undefined) throw new GraphQLError('createIssue: unknown repositoryId');
      const issue = createIssue(ctx.forge, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
    }
    if (field === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') throw new GraphQLError('closeIssue: unknown issueId');
      const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
      const issue = repo?.issues.find((entry) => entry.number === parsed.number);
      if (repo === undefined || issue === undefined) throw new GraphQLError('closeIssue: unknown issueId');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(repo, issue) };
    }
    if (field === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      if (parsed === null || parsed.kind !== 'Repository') throw new GraphQLError('createPullRequest: unknown repositoryId');
      const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
      if (repo === undefined) throw new GraphQLError('createPullRequest: unknown repositoryId');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const pull = createPullRequest(ctx.forge, repo, String(input.title ?? ''), '', head, base);
      if (pull === null) throw new GraphQLError(`createPullRequest: head ${JSON.stringify(head)} or base ${JSON.stringify(base)} does not exist`);
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    }
    if (field === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed === null || parsed.kind !== 'PullRequest') throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
      const pull = repo?.pulls.find((entry) => entry.number === parsed.number);
      if (repo === undefined || pull === undefined) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      const merged = mergePullRequest(ctx.forge, repo, pull);
      if (merged === null) throw new GraphQLError('mergePullRequest: pull request cannot be merged');
      if (merged === 'conflict') throw new GraphQLError('mergePullRequest: merge conflict');
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    }
    if (field === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (parsed === null || parsed.kind !== 'Issue') throw new GraphQLError('addComment: unknown subjectId');
      const repo = ctx.forge.getRepo(parsed.owner, parsed.name);
      const issue = repo?.issues.find((entry) => entry.number === parsed.number);
      if (repo === undefined || issue === undefined) throw new GraphQLError('addComment: unknown subjectId');
      repo.commentSeq += 1;
      const comment = { id: repo.commentSeq, body: String(input.body ?? '') };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'IssueComment', id: commentGlobalId(repo, issue, comment), body: comment.body },
        },
      };
    }
  }

  // Plain record fields (User.login, Ref.name, PageInfo.*, payload wrappers, __Field.name...).
  if (field in record) return record[field];
  return null;
}

function wrapRepo(repo: Repo): AnyRecord {
  return { __typename: 'Repository', __repo: repo };
}
function wrapIssue(repo: Repo, issue: Issue): AnyRecord {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}
function wrapPull(repo: Repo, pull: PullRequest): AnyRecord {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

/** The GraphQL return type of a field, for recursing into sub-selections. */
function fieldReturnType(typeName: string, field: string): string {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection',
      pullRequest: 'PullRequest',
    },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
    PullRequest: { files: 'PullRequestChangedFileConnection' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge' },
    CommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[typeName]?.[field] ?? 'String';
}

function executeSelectionSet(
  typeName: string,
  parent: unknown,
  selections: readonly SelectionNode[],
  variables: Variables,
  ctx: GqlContext,
  fragments: ReadonlyMap<string, FragmentNode>,
  errors: GraphQLError[],
  path: Array<string | number>,
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(new GraphQLError(`Unknown fragment "${selection.name}".`, path));
        continue;
      }
      if (fragment.typeCondition !== typeName && typenameOf(parent) !== fragment.typeCondition) {
        // A named fragment applies when its condition matches the runtime type.
        if (typenameOf(parent) !== fragment.typeCondition) continue;
      }
      const sub = executeSelectionSet(typeName, parent, fragment.selections, variables, ctx, fragments, errors, path);
      Object.assign(out, sub);
      continue;
    }
    if (selection.kind === 'inline') {
      const runtime = typenameOf(parent);
      if (selection.typeCondition !== null && selection.typeCondition !== typeName && selection.typeCondition !== runtime) continue;
      const sub = executeSelectionSet(typeName, parent, selection.selections, variables, ctx, fragments, errors, path);
      Object.assign(out, sub);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      const args = argsFromAst(selection.args, variables);
      value = resolveField(typeName, selection.name, parent, args, ctx);
    } catch (err) {
      if (err instanceof GraphQLError) {
        errors.push(new GraphQLError(err.message, fieldPath));
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (selection.selections === null || selection.selections.length === 0) {
      out[key] = value ?? null;
      continue;
    }
    const returnType = fieldReturnType(typeName, selection.name);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item === null || item === undefined) return null;
        const itemType = typenameOf(item) || returnType;
        return executeSelectionSet(itemType, item, selection.selections as SelectionNode[], variables, ctx, fragments, errors, fieldPath);
      });
      continue;
    }
    const itemType = typenameOf(value) || returnType;
    out[key] = executeSelectionSet(itemType, value, selection.selections, variables, ctx, fragments, errors, fieldPath);
  }
  return out;
}

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

/** Execute one operation document. Returns the {data, errors?} envelope. */
export function executeGraphQL(forge: Forge, query: string, variables: Variables, operationName?: string): GraphQLResult {
  const ctx: GqlContext = { forge, viewerLogin: forge.viewerLogin };
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = operations.find((entry) => entry.name === operationName);
  }
  if (operation === undefined) operation = operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'no operation in the document' }] };
  }
  const mergedVariables: Variables = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== null) {
      mergedVariables[variable.name] = valueFromAst(variable.defaultValue, {});
    }
  }
  const errors: GraphQLError[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, {}, operation.selections, mergedVariables, ctx, fragments, errors, []);
  if (errors.length > 0) {
    return { data, errors: errors.map((error) => ({ message: error.message, path: error.path })) };
  }
  return { data };
}
