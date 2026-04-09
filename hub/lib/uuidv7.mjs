// hub/lib/uuidv7.mjs — UUIDv7 generator (RFC 9562, monotonic)
import { randomBytes } from "node:crypto";

let _rndPool = Buffer.alloc(0),
  _rndOff = 0;

function pooledRandom(n) {
  if (_rndOff + n > _rndPool.length) {
    _rndPool = randomBytes(256);
    _rndOff = 0;
  }
  const out = Buffer.from(_rndPool.subarray(_rndOff, _rndOff + n));
  _rndOff += n;
  return out;
}

let _lastMs = 0n;
let _seq = 0;

/** UUIDv7 생성 (RFC 9562, 단조 증가 보장) */
export function uuidv7() {
  let now = BigInt(Date.now());
  if (now <= _lastMs) {
    _seq++;
    if (_seq > 0xfff) {
      now = _lastMs + 1n;
      _seq = 0;
    }
  } else {
    _seq = 0;
  }
  _lastMs = now;
  const buf = pooledRandom(16);
  buf[0] = Number((now >> 40n) & 0xffn);
  buf[1] = Number((now >> 32n) & 0xffn);
  buf[2] = Number((now >> 24n) & 0xffn);
  buf[3] = Number((now >> 16n) & 0xffn);
  buf[4] = Number((now >> 8n) & 0xffn);
  buf[5] = Number(now & 0xffn);
  buf[6] = ((_seq >> 8) & 0x0f) | 0x70;
  buf[7] = _seq & 0xff;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
