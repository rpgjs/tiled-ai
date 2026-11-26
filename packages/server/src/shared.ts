import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { RpcError } from "../../protocol/src/index";
import { BridgeChannel } from "./channel";
export class SharedBridge {
  private channel: BridgeChannel;
  constructor(port: number, token: string) {
    this.channel = new BridgeChannel(port, token);
  }
  private post(path: string, body: unknown, timeout = 40000) {
    return this.channel.post(path, body, timeout);
  }
  async health() {
    let response: Response;
    try {
      response = await this.post("/health", {}, 1000);
    } catch (e: any) {
      if (e instanceof RpcError) throw e;
      if (e.cause?.code === "ECONNREFUSED") return null;
      throw new RpcError(
        "BRIDGE_UNAVAILABLE",
        "Cannot reach the shared bridge; inspect the configured port",
      );
    }
    if (!response.ok)
      throw new RpcError(
        "BRIDGE_INCOMPATIBLE",
        "The port belongs to an older Tiled AI server. Stop the older server, then restart the MCP integration.",
      );
    const health = (await response.json()) as any;
    if (health.service !== "tiled-ai-shared-bridge" || health.version !== 2)
      throw new RpcError(
        "BRIDGE_INCOMPATIBLE",
        "Incompatible service on the configured bridge port",
      );
    return health;
  }
  async ensure(cliPath: string, configPath: string) {
    if (await this.health()) return;
    // Concurrent starters compete for the socket. The losing daemon exits;
    // every client then connects to the same authenticated winner.
    const child = spawn(
      process.execPath,
      [cliPath, "bridge", "--config", configPath],
      { detached: true, stdio: "ignore" },
    );
    let failure: Error | undefined;
    child.on("error", (e) => {
      failure = e;
    });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await delay(100);
      if (failure) throw failure;
      if (await this.health()) return;
    }
    throw new RpcError(
      "BRIDGE_START_FAILED",
      "Shared bridge did not start. Run cli.mjs bridge --config <config> in a terminal to inspect the error.",
    );
  }
  async call(method: string, input: unknown) {
    let response: Response;
    try {
      response = await this.post("/mcp-call", { method, input });
    } catch {
      throw new RpcError(
        "BRIDGE_UNAVAILABLE",
        "Bridge response lost. Do not replay mutations; inspect get_request_status with the original request ID after reconnecting.",
      );
    }
    if (!response.ok)
      throw new RpcError("BRIDGE_UNAVAILABLE", "Bridge rejected the request");
    const result = (await response.json()) as any;
    if (!result.ok)
      throw new RpcError(
        result.error.code,
        result.error.message,
        result.error.details,
      );
    return result.result;
  }
  async stop() {
    const response = await this.post("/stop", {});
    if (!response.ok)
      throw new RpcError(
        "BRIDGE_UNAVAILABLE",
        "Could not stop the shared bridge",
      );
  }
}
