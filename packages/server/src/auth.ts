import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  HEADERS,
  NONCE_PATTERN,
  requestMac,
  sameHex,
  serverProof,
  sessionKey,
  type Crypto,
} from "../../protocol/src/auth";
export const nodeCrypto: Crypto = {
  hmac: (key, message) =>
    createHmac("sha256", key).update(message).digest("hex"),
  sha256: (message) => createHash("sha256").update(message).digest("hex"),
};
const HANDSHAKE_WINDOW_MS = 60_000,
  IDLE_MS = 15 * 60_000,
  MAX_CHANNELS = 64,
  MAX_REQUESTS = 100_000;
interface Channel {
  lastUsed: number;
  seen: Set<number>;
}
export type Verdict = "ok" | "denied" | "expired";
/**
 * Server half of the handshake. Nothing is stored for unauthenticated peers:
 * the server nonce carries its own issue time and a tag under a per-process
 * key, so a restart invalidates every earlier channel and recorded request.
 */
export class ServerAuth {
  private bootKey = randomBytes(32).toString("hex");
  private channels = new Map<string, Channel>();
  constructor(
    private token: string,
    private now: () => number = Date.now,
  ) {}
  private tag(issued: string) {
    return nodeCrypto.hmac(this.bootKey, issued);
  }
  handshake(clientNonce: unknown) {
    if (typeof clientNonce !== "string" || !NONCE_PATTERN.test(clientNonce))
      return undefined;
    const issued =
      this.now().toString(16) + "." + randomBytes(16).toString("hex");
    const serverNonce = issued + "." + this.tag(issued);
    return {
      serverNonce,
      proof: serverProof(nodeCrypto, this.token, clientNonce, serverNonce),
    };
  }
  verify(
    method: string,
    path: string,
    body: string,
    header: (name: string) => string | undefined,
  ): Verdict {
    const cn = header(HEADERS.client),
      sn = header(HEADERS.server),
      seqText = header(HEADERS.seq),
      mac = header(HEADERS.mac);
    if (
      !cn ||
      !NONCE_PATTERN.test(cn) ||
      !sn ||
      sn.length > 256 ||
      !seqText ||
      !/^[1-9]\d{0,9}$/.test(seqText) ||
      !mac
    )
      return "denied";
    const seq = Number(seqText);
    const key = sessionKey(nodeCrypto, this.token, cn, sn);
    if (!sameHex(mac, requestMac(nodeCrypto, key, seq, method, path, body)))
      return "denied";
    // The caller knows the secret from here on; failures only mean "redo the
    // handshake", and the request has not been executed.
    const parts = sn.split(".");
    if (
      parts.length !== 3 ||
      !sameHex(parts[2], this.tag(parts[0] + "." + parts[1]))
    )
      return "expired";
    const id = cn + sn,
      now = this.now();
    let channel = this.channels.get(id);
    if (!channel) {
      const age = now - parseInt(parts[0], 16);
      if (!(age >= -5000 && age <= HANDSHAKE_WINDOW_MS)) return "expired";
      this.prune(now);
      channel = { lastUsed: now, seen: new Set() };
      this.channels.set(id, channel);
    } else if (now - channel.lastUsed > IDLE_MS) {
      this.channels.delete(id);
      return "expired";
    }
    if (channel.seen.has(seq)) return "denied";
    if (channel.seen.size >= MAX_REQUESTS) {
      this.channels.delete(id);
      return "expired";
    }
    channel.seen.add(seq);
    channel.lastUsed = now;
    return "ok";
  }
  private prune(now: number) {
    for (const [id, c] of this.channels)
      if (now - c.lastUsed > IDLE_MS) this.channels.delete(id);
    while (this.channels.size >= MAX_CHANNELS)
      this.channels.delete(this.channels.keys().next().value!);
  }
}
