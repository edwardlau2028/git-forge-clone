// gitwire.ts — the git smart-HTTP wire: pkt-lines, packfiles, upload-pack (v2 + v0) and
// receive-pack (v0). Speaks exactly the dialect program/env/src/git-client.ts speaks.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash as nodeCreateHash } from 'node:crypto';
import {
  Forge,
  Repo,
  ZERO_OID,
  isOid,
  hashObject,
  parseTree,
  parseCommit,
  parseTag,
  buildTree,
  type GitObject,
  type ObjectType,
} from './store.ts';

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const flushPacket = (): Buffer => Buffer.from('0000', 'ascii');
export const delimPacket = (): Buffer => Buffer.from('0001', 'ascii');

/** Encode lines ('flush'/'delim' for control packets) as one pkt-line stream. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(flushPacket());
    else if (line === 'delim') parts.push(delimPacket());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from `buf`. Returns the packets and the bytes left over after the first
 * flush packet (a push's pack follows its command list's flush). Throws on malformed input.
 */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`malformed pkt-line header ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new Error('truncated pkt-line header');
  return { packets, rest: Buffer.alloc(0) };
}

/** The data payloads of a packet list, as text lines (without trailing newlines). */
function packetLines(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a version-2 pack of plain objects (no deltas), with the SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    const typeId = PACK_TYPE_IDS[object.type];
    const data = object.data;
    // Object header varint: size low 4 bits in the first byte with the type, then 7 bits/byte.
    let size = data.length;
    const header: number[] = [];
    let first = (size & 0x0f) | (typeId << 4);
    size >>= 4;
    if (size > 0) first |= 0x80;
    header.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  const trailer = hashObjectRaw(body);
  return Buffer.concat([body, trailer]);
}

function hashObjectRaw(data: Buffer): Buffer {
  return nodeCreateHash('sha1').update(data).digest();
}

interface PackEntry {
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data?: Buffer; // plain objects
  baseOffset?: number; // ofs-delta
  baseOid?: string; // ref-delta
  delta?: Buffer; // delta instructions
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos] as number;
    value |= (byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: pos };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    const { value, next } = readVarint(delta, pos);
    pos = next;
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] as number) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA. `resolveBase` supplies thin-pack bases
 * (objects the sender assumes the receiver already holds). Throws on a bad checksum or
 * malformed entries.
 */
export function readPack(
  buf: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (buf.length < 32) throw new Error('pack too short');
  const trailer = buf.subarray(buf.length - 20);
  const actual = hashObjectRaw(buf.subarray(0, buf.length - 20));
  if (!trailer.equals(actual)) throw new Error('pack trailer checksum mismatch');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const offsets: number[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    offsets.push(entryStart);
    const first = buf[offset] as number;
    offset += 1;
    const typeId = (first >> 4) & 0x07;
    // Size varint: low 4 bits in the first byte, then 7 bits per following byte.
    let byte = first;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: offset encoding.
      let b = buf[offset] as number;
      offset += 1;
      let baseOffset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const base = entryStart - baseOffset;
      const length = compressedLength(buf, offset);
      const delta = inflateSync(buf.subarray(offset, offset + length));
      offset += length;
      entries.push({ type: 'ofs-delta', baseOffset: base, delta });
    } else if (typeId === 7) {
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const length = compressedLength(buf, offset);
      const delta = inflateSync(buf.subarray(offset, offset + length));
      offset += length;
      entries.push({ type: 'ref-delta', baseOid, delta });
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const length = compressedLength(buf, offset);
      const data = inflateSync(buf.subarray(offset, offset + length));
      offset += length;
      if (data.length !== size) throw new Error('pack object size mismatch');
      entries.push({ type, data });
    }
  }
  // Resolve entries. Plain entries first (their oids are known up front); deltas resolve
  // recursively with memoisation, so a delta may base on any entry in the pack.
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const byIndex = new Map<number, GitObject>();
  let deltaCount = 0;
  const resolveEntry = (index: number): GitObject => {
    const cached = byIndex.get(index);
    if (cached !== undefined) return cached;
    const entry = entries[index] as PackEntry;
    let object: GitObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseIndex = offsets.indexOf(entry.baseOffset as number);
        if (baseIndex < 0) throw new Error('ofs-delta base outside the pack');
        base = resolveEntry(baseIndex);
      } else {
        // The base may be a plain entry, an already-resolved delta, or a delta not yet
        // resolved: try the known objects first, then resolve the remaining entries.
        for (const candidate of objects.values()) {
          if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
            base = candidate;
            break;
          }
        }
        if (base === undefined) {
          for (let candidateIndex = 0; candidateIndex < entries.length; candidateIndex += 1) {
            if (candidateIndex === index || byIndex.has(candidateIndex)) continue;
            const candidate = resolveEntry(candidateIndex);
            if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
              base = candidate;
              break;
            }
          }
        }
        if (base === undefined) base = resolveBase(entry.baseOid as string);
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      }
      const data = applyDelta(base.data, entry.delta as Buffer);
      object = { type: base.type, data };
    } else {
      object = { type: entry.type as ObjectType, data: entry.data as Buffer };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(offsets[index] as number, object);
    byIndex.set(index, object);
    return object;
  };
  for (let index = 0; index < entries.length; index += 1) resolveEntry(index);
  return { objects, deltaCount };
}

/** Adler-32, the checksum a zlib stream ends with (its last four bytes). */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The length of the zlib stream starting at `offset`. Node's inflateSync ignores
 * trailing bytes, so the stream is found in two inflates: inflate the whole rest
 * once (which yields exactly this stream's data and ignores everything after
 * it), then pin down the stream's end with its own trailer — the last four
 * bytes are the Adler-32 of the uncompressed data, so the smallest end whose
 * trailing four bytes match the checksum, and whose slice inflates cleanly to
 * the same bytes, is the stream.
 */
function compressedLength(buf: Buffer, offset: number): number {
  const limit = buf.length - 20;
  let data: Buffer;
  try {
    data = inflateSync(buf.subarray(offset, limit));
  } catch {
    throw new Error('unterminated zlib stream in pack');
  }
  const adler = adler32(data);
  for (let e = offset + 4; e <= limit; e += 1) {
    if (buf.readUInt32BE(e - 4) !== adler) continue;
    try {
      const check = inflateSync(buf.subarray(offset, e));
      if (check.equals(data)) return e - offset;
    } catch {
      // Not a clean stream end; keep scanning.
    }
  }
  throw new Error('unterminated zlib stream in pack');
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects for the pack, in a deterministic order. */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * All objects a fetch sends for a set of commits: the commits themselves, their
 * trees and the blobs those trees name — but never a parent commit. (The
 * generic reachableObjects follows parents, which would send the whole history
 * on a shallow fetch.)
 */
function fetchClosure(repo: Repo, roots: readonly string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      stack.push(parseCommit(object.data).tree);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

/**
 * What the client already holds: everything reachable from its haves, except
 * that a shallow boundary commit's parents are NOT held — that is the point of
 * a shallow clone. (Subtracting the server's full have-closure instead would
 * wrongly withhold the parent commit and its tree on a deepen, where the
 * client is re-opening exactly that history.)
 */
function clientHeldObjects(repo: Repo, haves: readonly string[], clientShallow: readonly string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const shallowSet = new Set(clientShallow);
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | null,
): FetchPlan {
  const haveSet = new Set<string>();
  for (const have of haves) if (repo.objects.has(have)) haveSet.add(have);
  // What the client already holds (shallow-aware: a boundary's parents are not held).
  const haveClosure = clientHeldObjects(repo, [...haveSet], clientShallow);

  // Roots: tag wants peel to their target commit; other wants are used as-is.
  const directObjects: GitObject[] = [];
  const roots: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      directObjects.push(object);
      const target = repo.peelToCommit(want);
      if (target !== null) roots.push(target);
    } else if (object.type === 'commit') {
      roots.push(want);
    } else {
      directObjects.push(object);
    }
  }

  // Walk commits from the roots, tracking depth from the nearest want.
  const includedCommits = new Set<string>();
  const queue: Array<[string, number]> = roots.map((root) => [root, 0] as [string, number]);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const [current, depth] = queue.shift() as [string, number];
    if (seen.has(current)) continue;
    seen.add(current);
    if (deepen !== null && depth >= deepen) continue;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    const isHave = haveSet.has(current);
    if (!isHave) includedCommits.add(current);
    // Descend: through a have only when a depth limit is in force (a deepen re-opens history
    // below the have); without one the have's ancestors are excluded by the have-closure.
    if (isHave && deepen === null) continue;
    const parents = parseCommit(object.data).parents;
    for (const parent of parents) queue.push([parent, depth + 1]);
  }

  // Object closure of the included commits (their trees and blobs only — never
  // a parent commit that is not itself included), plus tag objects, minus what
  // the client already holds.
  const directOids = directObjects.map((object) => hashObject(object.type, object.data));
  const closure = fetchClosure(repo, [...includedCommits, ...directOids]);
  const objects: GitObject[] = [];
  const seenOids = new Set<string>();
  for (const [oid, object] of closure) {
    if (seenOids.has(oid)) continue;
    seenOids.add(oid);
    if (haveClosure.has(oid) && !includedCommits.has(oid) && !directObjects.some((o) => hashObject(o.type, o.data) === oid)) {
      continue;
    }
    objects.push(object);
  }
  // Deterministic order: commits, then trees, then blobs, then tags, each by oid.
  const typeOrder: Record<ObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => {
    const byType = typeOrder[a.type] - typeOrder[b.type];
    if (byType !== 0) return byType;
    return hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1;
  });

  // Shallow boundaries: included commits whose parent is not in the pack-or-haves set, plus
  // client shallow boundaries that stay boundaries; unshallow = client boundaries now complete.
  const held = new Set<string>([...includedCommits, ...haveSet]);
  const inPack = new Set<string>(objects.map((object) => hashObject(object.type, object.data)));
  const available = new Set<string>([...held, ...inPack]);
  const shallowSet = new Set<string>();
  for (const commit of includedCommits) {
    const object = repo.objects.get(commit);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !available.has(parent))) shallowSet.add(commit);
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    if (!held.has(boundary) && !inPack.has(boundary)) continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => available.has(parent))) unshallow.push(boundary);
    else shallowSet.add(boundary);
  }
  return { objects, shallow: [...shallowSet].sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const AGENT = 'github-core-clone-forge/1.0.0';

function refLinesV0(repo: Repo): string[] {
  const lines: string[] = [];
  const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  const headTip = repo.headOid();
  if (headTip === null) return lines; // empty repo: caller emits the capabilities pseudo-ref
  lines.push(`${headTip} HEAD`);
  for (const ref of branches) lines.push(`${repo.refs.get(ref) as string} ${ref}`);
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    lines.push(`${oid} ${ref}`);
    const peeled = repo.peelToCommit(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'tag' && peeled !== null && peeled !== oid) lines.push(`${peeled} ${ref}^{}`);
  }
  return lines;
}

function uploadCapsV0(): string {
  return `symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack agent=${AGENT}`;
}

function receiveCapsV0(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

function advertisementV2(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'fetch=shallow\n',
    'ls-refs=unborn\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCapsV0() : receiveCapsV0();
  const serviceLine = `# service=${service}\n`;
  const lines: Array<string | 'flush'> = [serviceLine, 'flush'];
  const refs = refLinesV0(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const first = refs[0] as string;
    lines.push(`${first}\0${caps}\n`);
    for (const line of refs.slice(1)) lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------
// Handlers: each returns {status, contentType, body}
// ---------------------------------------------------------------------------

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitReply(status: number, contentType: string, body: Buffer): GitReply {
  return { status, contentType, body };
}

function notFound(): GitReply {
  return gitReply(404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(forge: Forge, owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitReply {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return gitReply(200, 'application/x-git-upload-pack-advertisement', advertisementV2());
    }
    return gitReply(200, 'application/x-git-upload-pack-advertisement', advertisementV0(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return gitReply(200, 'application/x-git-receive-pack-advertisement', advertisementV0(repo, 'git-receive-pack'));
  }
  return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'unknown service' }), 'utf8'));
}

/** All refs for ls-refs, in advertisement order. */
function allRefs(repo: Repo): Array<{ oid: string; name: string; unborn?: boolean; symrefTarget?: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; unborn?: boolean; symrefTarget?: string; peeled?: string }> = [];
  const headTip = repo.headOid();
  if (headTip === null) {
    out.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    out.push({ oid: headTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  for (const ref of branches) out.push({ oid: repo.refs.get(ref) as string, name: ref });
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name: ref };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = repo.peelToCommit(oid);
      if (peeled !== null && peeled !== oid) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 (ls-refs/fetch) or v0 (fetch). */
export function handleUploadPack(forge: Forge, owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): GitReply {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let decoded: { packets: Packet[]; rest: Buffer };
  try {
    decoded = decodePktLines(body);
  } catch {
    return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8'));
  }
  const lines = packetLines(decoded.packets);
  if (gitProtocol === 'version=2') {
    const command = lines[0] ?? '';
    if (command === 'command=ls-refs') return uploadLsRefs(repo, lines);
    if (command === 'command=fetch') return uploadFetchV2(repo, lines);
    return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'unknown v2 command' }), 'utf8'));
  }
  return uploadFetchV0(repo, lines);
}

function uploadLsRefs(repo: Repo, lines: readonly string[]): GitReply {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const line of lines.slice(1)) {
    if (line === '') continue; // delim/flush markers are not in `lines`
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('agent=') || line.startsWith('object-format=')) { /* ignore */ }
    else if (line === 'command=ls-refs') { /* ignore */ }
    void pastDelim;
  }
  const out: string[] = [];
  for (const ref of allRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn === true && !unborn) continue;
    if (ref.unborn === true) {
      out.push(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return gitReply(200, 'application/x-git-upload-pack-result', encodePktLines(out));
}

function parseFetchArgs(lines: readonly string[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
  }
  return { wants, haves, shallow, deepen };
}

function sidebandPackets(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
    return parts;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function uploadFetchV2(repo: Repo, lines: readonly string[]): GitReply {
  const args = parseFetchArgs(lines);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.deepen);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // The acknowledgment section is only sent when the client sent at least one
  // `have` line: a client with no haves (a fresh clone) expects the packfile
  // section next, and rejects an unexpected `acknowledgments` section. The
  // kit's own client accepts sections in any order, so omitting it is safe
  // there too.
  if (args.haves.length > 0) {
    parts.push(encodePktLines(['acknowledgments\n']));
    const acks: string[] = [];
    for (const have of args.haves) {
      if (repo.objects.has(have)) acks.push(`ACK ${have}\n`);
    }
    if (acks.length === 0) acks.push('NAK\n');
    else acks.push('ready\n');
    parts.push(encodePktLines(acks));
    parts.push(delimPacket());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLines(['shallow-info\n']));
    const info: string[] = [];
    for (const oid of plan.shallow) info.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) info.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(info));
    parts.push(delimPacket());
  }
  parts.push(encodePktLines(['packfile\n']));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(flushPacket());
  return gitReply(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function uploadFetchV0(repo: Repo, lines: readonly string[]): GitReply {
  const args = parseFetchArgs(lines);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.deepen);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const acks: string[] = [];
  if (args.haves.length === 0) acks.push('NAK\n');
  else {
    for (const have of args.haves) {
      if (repo.objects.has(have)) acks.push(`ACK ${have}\n`);
    }
    if (acks.length === 0) acks.push('NAK\n');
  }
  parts.push(encodePktLines(acks));
  const info: string[] = [];
  for (const oid of plan.shallow) info.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) info.push(`unshallow ${oid}\n`);
  if (info.length > 0) parts.push(encodePktLines(info));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(flushPacket());
  return gitReply(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST /{owner}/{repo}.git/git-receive-pack — v0 only. */
export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let decoded: { packets: Packet[]; rest: Buffer };
  try {
    decoded = decodePktLines(body);
  } catch {
    return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed pkt-line' }), 'utf8'));
  }
  const lines = packetLines(decoded.packets);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length !== 3) {
      return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed push command' }), 'utf8'));
    }
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'malformed push command' }), 'utf8'));
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return gitReply(400, 'application/json', Buffer.from(JSON.stringify({ message: 'no push commands' }), 'utf8'));
  }
  // Unpack the pack (if any) before judging the refs.
  const packBytes = decoded.rest;
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) repo.putObject(oid, object.type, object.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push(`ng ${command.ref} stale info\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      report.push(`ng ${command.ref} unable to find object ${command.newOid}\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push(`ng ${command.ref} stale info\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.oldOid !== current) {
      report.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    const newCommit = repo.peelToCommit(command.newOid);
    if (newCommit === null || !repo.isAncestor(current, newCommit)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }
  // The report-status stream is itself pkt-lined inside sideband band 1, and it
  // ends with its own flush packet: real git's report reader treats a stream
  // that ends without one as a hung-up connection. (The kit's client filters
  // control packets out of the report, so the inner flush is harmless there.)
  const inner = encodePktLines([...report, 'flush']);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += 65515) {
    const chunk = inner.subarray(offset, Math.min(offset + 65515, inner.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(flushPacket());
  return gitReply(200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
