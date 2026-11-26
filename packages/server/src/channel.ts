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
    if (channel) return channel;
    // A pre-v2 bridge has no /handshake and answers 403/404. It cannot be
    // stopped remotely: that would mean sending the secret to an unverified
    // listener, which is exactly what this handshake prevents.
    if (response.status === 403 || response.status === 404)
      throw new RpcError(
        "BRIDGE_INCOMPATIBLE",
        `Port ${this.port} is held by a service without the v2 handshake, most likely an older Tiled AI bridge. bridge-stop cannot stop it because it would have to send the secret. Find the process listening on that port, confirm it is the old Tiled AI bridge, stop it by PID, then restart the MCP integration.`,
      );
    throw new RpcError(
      "BRIDGE_INCOMPATIBLE",
      `The service on port ${this.port} failed to prove knowledge of the bridge secret (another secret or an impostor). Nothing was sent to it. Identify the owner of the port before stopping anything.`,
    );
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
        await response.body?.cancel();
        this.channel = undefined;
        continue;
      }
      return response;
    }
  }
}
