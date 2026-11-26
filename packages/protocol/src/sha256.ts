// Dependency-free SHA-256/HMAC for Tiled's Qt script engine, which has no
// crypto module. Node uses node:crypto; tests keep both in agreement.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
// Matches Buffer.from(s, "utf8"): lone surrogates become U+FFFD.
function utf8(s: string, out: { byte(b: number): void }) {
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out.byte(c);
      continue;
    }
    if (c >= 0xd800 && c < 0xe000) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c < 0xdc00 && d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else c = 0xfffd;
    }
    if (c < 0x800) out.byte(0xc0 | (c >> 6));
    else {
      if (c < 0x10000) out.byte(0xe0 | (c >> 12));
      else {
        out.byte(0xf0 | (c >> 18));
        out.byte(0x80 | ((c >> 12) & 63));
      }
      out.byte(0x80 | ((c >> 6) & 63));
    }
    out.byte(0x80 | (c & 63));
  }
}
const INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
// Streams input through one 64-byte block, so hashing a multi-megabyte result
// body allocates nothing proportional to its size.
class Sha256 {
  private h = new Int32Array(INIT);
  private w = new Int32Array(64);
  private block = new Uint8Array(64);
  private used = 0;
  /** Bytes in completed blocks; `used` holds the rest. */
  private length = 0;
  byte(b: number) {
    this.block[this.used++] = b;
    if (this.used === 64) {
      this.length += 64;
      this.compress();
      this.used = 0;
    }
  }
  bytes(list: ArrayLike<number>) {
    for (let i = 0; i < list.length; i++) this.byte(list[i]);
    return this;
  }
  text(s: string) {
    // ASCII fast path: JSON bodies are mostly ASCII (base64 images), and
    // Tiled's engine may run without a JIT, where per-byte calls dominate.
    const block = this.block;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x80) {
        utf8(s.slice(i), this);
        return this;
      }
      block[this.used++] = c;
      if (this.used === 64) {
        this.length += 64;
        this.compress();
        this.used = 0;
      }
    }
    return this;
  }
  digest() {
    // Messages stay far below 2^53 bits; the high word is exact.
    const bits = (this.length + this.used) * 8,
      high = Math.floor(bits / 0x100000000),
      low = bits >>> 0;
    this.byte(0x80);
    while (this.used !== 56) this.byte(0);
    for (const word of [high, low])
      for (let shift = 24; shift >= 0; shift -= 8)
        this.byte((word >>> shift) & 255);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 4; j++)
        out[4 * i + j] = (this.h[i] >>> (24 - 8 * j)) & 255;
    return out;
  }
  private compress() {
    const w = this.w,
      b8 = this.block,
      h = this.h;
    for (let i = 0; i < 16; i++)
      w[i] =
        (b8[4 * i] << 24) |
        (b8[4 * i + 1] << 16) |
        (b8[4 * i + 2] << 8) |
        b8[4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15],
        y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
}
function hex(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++)
    s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return s;
}
export function sha256Hex(message: string) {
  return hex(new Sha256().text(message).digest());
}
export function hmacSha256Hex(key: string, message: string) {
  const raw: number[] = [];
  utf8(key, { byte: (b) => raw.push(b) });
  const k = raw.length > 64 ? new Sha256().bytes(raw).digest() : raw;
  const pad = (x: number) => {
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) out[i] = (i < k.length ? k[i] : 0) ^ x;
    return out;
  };
  const inner = new Sha256().bytes(pad(0x36)).text(message).digest();
  return hex(new Sha256().bytes(pad(0x5c)).bytes(inner).digest());
}
