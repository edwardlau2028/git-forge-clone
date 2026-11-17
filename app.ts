// app.ts — the forge's HTTP server: node:http, stdlib only.
// Routes:
//   GET  /healthz                              200 {"ok": true}
//   /api/v3/*                                  REST v3 (rest.ts)
//   POST /api/graphql                          GraphQL v4 (graphql.ts)
//   POST /mcp                                  MCP over Streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/info/refs              git smart HTTP advertisement
//   /{owner}/{repo}.git/git-upload-pack         git protocol v2 / v0 fetch
//   /{owner}/{repo}.git/git-receive-pack        git protocol v0 push
//
// Authentication: when MAKEFUN_SHOP_TOKEN is set (the trial pod sets it), every
// route except /healthz requires `Authorization: Bearer <token>` and answers
// 401 JSON otherwise. When it is unset (local testing), requests are allowed
// without a token so the kit's own suite can run against a local server.
// Every REST reply carries a non-empty X-GitHub-Request-Id header, every reply
// is JSON (never HTML), and no request ever redirects or crashes the server.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitwire.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY = 32 * 1024 * 1024;

// Request ids are unique per process; the counter lives at module level so
// sendJson (also module level) can stamp every JSON reply with one.
let requestCounter = 0;

export function createApp(token: string | undefined): ReturnType<typeof createServer> {
  const forge = new Forge(token ?? '');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (req.method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const body = await readBody(req);
        if (body === null) {
          sendJson(res, 413, { message: 'request body too large' });
          return;
        }

        // Authentication (except /healthz, handled above).
        if (token !== undefined) {
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${token}`) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
        }

        if (path === '/api/graphql' && req.method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          if (Array.isArray(parsed)) {
            // A batched body is an array of operation documents at the top level.
            const results = parsed.map((entry) => {
              const record = (entry ?? {}) as Record<string, unknown>;
              return executeGraphQL(
                forge,
                String(record.query ?? ''),
                (record.variables ?? {}) as Record<string, unknown>,
                typeof record.operationName === 'string' ? record.operationName : undefined,
              );
            });
            sendJson(res, 200, results);
            return;
          }
          const record = (parsed ?? {}) as Record<string, unknown>;
          const result = executeGraphQL(
            forge,
            typeof record.query === 'string' ? record.query : '',
            (record.variables ?? {}) as Record<string, unknown>,
            typeof record.operationName === 'string' ? record.operationName : undefined,
          );
          sendJson(res, 200, result);
          return;
        }

        if (path === '/mcp' && req.method === 'POST') {
          const outcome = handleMcp(forge, body);
          if (outcome.body === null) {
            res.writeHead(outcome.status);
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path.slice('/api/v3'.length).split('/').filter((segment) => segment !== '');
          // A non-empty body on a mutating call must be valid JSON.
          let parsedBody: unknown = null;
          if (body.length > 0 && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE')) {
            try {
              parsedBody = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              requestCounter += 1;
              res.writeHead(400, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': `req-${requestCounter}` });
              res.end(JSON.stringify({ message: 'malformed JSON body' }));
              return;
            }
          }
          const ctx: RestContext = {
            forge,
            origin: `http://${req.headers.host ?? 'localhost'}`,
            path: segments.join('/'),
            query: url.searchParams,
          };
          const outcome = handleRest(ctx, req.method ?? 'GET', segments, parsedBody);
          requestCounter += 1;
          const responseHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-GitHub-Request-Id': `req-${requestCounter}`,
            ...(outcome.headers ?? {}),
          };
          if (outcome.status === 204 || outcome.json === null) {
            res.writeHead(outcome.status, responseHeaders);
            res.end();
            return;
          }
          res.writeHead(outcome.status, responseHeaders);
          res.end(JSON.stringify(outcome.json));
          return;
        }

        const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const service = gitMatch[3] as string;
          const gitProtocol = req.headers['git-protocol'];
          if (service === 'info/refs') {
            const reply = handleInfoRefs(forge, owner, repoName, url.searchParams.get('service') ?? '', typeof gitProtocol === 'string' ? gitProtocol : undefined);
            res.writeHead(reply.status, { 'Content-Type': reply.contentType });
            res.end(reply.body);
            return;
          }
          if (service === 'git-upload-pack') {
            const reply = handleUploadPack(forge, owner, repoName, body, typeof gitProtocol === 'string' ? gitProtocol : undefined);
            res.writeHead(reply.status, { 'Content-Type': reply.contentType });
            res.end(reply.body);
            return;
          }
          const reply = handleReceivePack(forge, owner, repoName, body);
          res.writeHead(reply.status, { 'Content-Type': reply.contentType });
          res.end(reply.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash on a request: answer 500 JSON and keep serving.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });

  return server;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY) {
        tooLarge = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  // Every JSON reply carries a non-empty X-GitHub-Request-Id, including the
  // 401/400/413/500 error replies the protocol checks read.
  requestCounter += 1;
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': `req-${requestCounter}` });
  res.end(JSON.stringify(value));
}
