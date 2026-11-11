// Spike S2 — the plan §6 framing grammar: [type: u8][length: u32 BE][payload].
import { Buffer } from 'node:buffer';

export const FRAME_JSON = 0x01;
export const FRAME_SCREENCAST = 0x02;
export const HEADER_BYTES = 5;
export const MAX_BY_TYPE = { [FRAME_JSON]: 1024 * 1024, [FRAME_SCREENCAST]: 4 * 1024 * 1024 };
export const MAX_HELLO_BYTES = 16 * 1024;

export function encodeJson(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_BY_TYPE[FRAME_JSON]) throw new Error('json frame over limit');
  return encodeRaw(FRAME_JSON, payload);
}

export function encodeRaw(type, payload) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder: fragment- and coalesce-safe, validates headers before buffering. */
export class FrameDecoder {
  constructor(limit = null) {
    this.chunks = [];
    this.size = 0;
    this.limit = limit;
    this.dead = false;
    this.utf8 = new TextDecoder('utf-8', { fatal: true });
  }

  setLimit(limit) {
    this.limit = limit;
  }

  get buffered() {
    return this.size;
  }

  push(chunk) {
    if (this.dead) return [];
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out = [];
    let buf = Buffer.concat(this.chunks);
    while (buf.length >= HEADER_BYTES) {
      const type = buf.readUInt8(0);
      const length = buf.readUInt32BE(1);
      const typeMax = MAX_BY_TYPE[type];
      if (typeMax === undefined)
        return this.fatal(out, `unknown frame type 0x${type.toString(16)}`);
      const max = this.limit === null ? typeMax : Math.min(typeMax, this.limit);
      if (length > max) return this.fatal(out, `frame length ${length} over limit ${max}`);
      if (buf.length < HEADER_BYTES + length) break;
      const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + length);
      buf = buf.subarray(HEADER_BYTES + length);
      if (type === FRAME_JSON) {
        try {
          out.push({ kind: 'json', message: JSON.parse(this.utf8.decode(payload)) });
        } catch {
          return this.fatal(out, 'malformed UTF-8 or JSON');
        }
      } else {
        out.push({ kind: 'screencast', bytes: payload.length });
      }
    }
    this.chunks = buf.length > 0 ? [Buffer.from(buf)] : [];
    this.size = buf.length;
    return out;
  }

  fatal(out, reason) {
    this.dead = true;
    this.chunks = [];
    this.size = 0;
    out.push({ kind: 'fatal', reason });
    return out;
  }
}
