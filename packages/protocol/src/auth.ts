// Mutual authentication for the loopback bridge. The shared secret is never
// sent: the server first proves it knows it, then every request carries a MAC
// bound to a per-handshake session key. A process that merely occupies the
// port cannot produce the proof, so a client never talks to it.
import { hmacSha256Hex, sha256Hex } from "./sha256";
export interface Crypto {
  hmac(key: string, message: string): string;
  sha256(message: string): string;
}
export const pureCrypto: Crypto = {
  hmac: hmacSha256Hex,
  sha256: sha256Hex,
};
export const AUTH_VERSION = "tiled-ai v2";
export const HEADERS = {
  client: "x-tiled-ai-client",
  server: "x-tiled-ai-server",
  seq: "x-tiled-ai-seq",
  mac: "x-tiled-ai-mac",
} as const;
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
export function serverProof(
  c: Crypto,
  token: string,
  clientNonce: string,
  serverNonce: string,
) {
  return c.hmac(
    token,
    [AUTH_VERSION, "server", clientNonce, serverNonce].join("\n"),
  );
}
export function sessionKey(
  c: Crypto,
  token: string,
  clientNonce: string,
  serverNonce: string,
) {
  return c.hmac(
    token,
    [AUTH_VERSION, "session", clientNonce, serverNonce].join("\n"),
  );
}
export function requestMac(
  c: Crypto,
  key: string,
  seq: number,
  method: string,
  path: string,
  body: string,
) {
  return c.hmac(
    key,
    [AUTH_VERSION, "request", seq, method, path, c.sha256(body)].join("\n"),
  );
}
// Not constant-time in the engine's JIT, but the compared proof is a fresh
// per-handshake value, so there is nothing reusable to learn from timing.
export function sameHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// Weak engines lack a CSPRNG. The nonce only has to be unpredictable enough
// that an impostor cannot replay a proof recorded for the same value.
export function weakNonce(c: Crypto) {
  let seed = String(Date.now());
  for (let i = 0; i < 16; i++) seed += ":" + Math.random();
  return c.sha256(seed).slice(0, 32);
}
export interface HandshakeResponse {
  serverNonce: string;
  proof: string;
}
export class ClientChannel {
  private seq = 0;
  private constructor(
    private c: Crypto,
    private key: string,
    private clientNonce: string,
    private serverNonce: string,
  ) {}
  /** Returns a channel only when the server proved knowledge of the secret. */
  static accept(
    c: Crypto,
    token: string,
    clientNonce: string,
    response: unknown,
  ): ClientChannel | undefined {
    const r = response as Partial<HandshakeResponse> | null;
    if (
      !r ||
      typeof r.serverNonce !== "string" ||
      r.serverNonce.length > 256 ||
      typeof r.proof !== "string" ||
      !sameHex(r.proof, serverProof(c, token, clientNonce, r.serverNonce))
    )
      return undefined;
    return new ClientChannel(
      c,
      sessionKey(c, token, clientNonce, r.serverNonce),
      clientNonce,
      r.serverNonce,
    );
  }
  sign(method: string, path: string, body: string): Record<string, string> {
    const seq = ++this.seq;
    return {
      [HEADERS.client]: this.clientNonce,
      [HEADERS.server]: this.serverNonce,
      [HEADERS.seq]: String(seq),
      [HEADERS.mac]: requestMac(this.c, this.key, seq, method, path, body),
    };
  }
}
