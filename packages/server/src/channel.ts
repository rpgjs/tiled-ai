import { randomBytes } from "node:crypto";
import { ClientChannel } from "../../protocol/src/auth";
import { RpcError } from "../../protocol/src/index";
import { nodeCrypto } from "./auth";
/** Authenticated HTTP to the loopback bridge; handshakes lazily and re-handshakes once on expiry. */
export class BridgeChannel {
  private channel?: ClientChannel;
  constructor(
    private port: number,
    private token: string,
  ) {}
  private url(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }
  private async handshake(timeout: number) {
    const clientNonce = randomBytes(16).toString("hex");
    const response = await fetch(this.url("/handshake"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientNonce }),
      signal: AbortSignal.timeout(timeout),
    });
    let channel: ClientChannel | undefined;
    try {
      if (response.ok)
        channel = ClientChannel.accept(
          nodeCrypto,
          this.token,
          clientNonce,
          await response.json(),
        );
    } catch {
      /* Not JSON: treated like any other failed proof. */
    }
    if (!channel)
      throw new RpcError(
        "BRIDGE_INCOMPATIBLE",
        "The configured port did not prove knowledge of the bridge secret (older server, another secret, or an impostor). No request was sent. Identify the owner of the port before stopping anything.",
      );
    return channel;
  }
  async post(path: string, body: unknown, timeout = 40000): Promise<Response> {
    const text = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const channel = (this.channel ??= await this.handshake(timeout));
      const response = await fetch(this.url(path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...channel.sign("POST", path, text),
        },
        body: text,
        signal: AbortSignal.timeout(timeout),
      });
      // An expired channel is rejected before the request runs, so one retry
      // on a fresh channel cannot repeat a mutation.
      if (response.status === 401 && attempt === 0) {
        this.channel = undefined;
        continue;
      }
      return response;
    }
  }
}
