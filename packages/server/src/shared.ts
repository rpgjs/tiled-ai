import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { RpcError } from "../../protocol/src/index";
import { ipcPost } from "./ipc";
export class SharedBridge {
  constructor(private socketPath: string) {}
  private post(path: string, body: unknown, timeout = 40000) {
    return ipcPost(this.socketPath, path, body, timeout);
  }
  async health() {
    let response: Awaited<ReturnType<typeof ipcPost>>;
    try {
      response = await this.post("/health", {}, 1000);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      if (e.code === "ECONNREFUSED")
        throw new RpcError(
          "BRIDGE_STALE_SOCKET",
          "Socket is not accepting connections. Stop all bridge clients and verify no bridge is running before manually removing the stale socket. No automatic deletion is performed.",
        );
      throw new RpcError(
        "BRIDGE_UNAVAILABLE",
        "Cannot reach the shared bridge; inspect the private socket path and permissions",
      );
    }
    if (response.status !== 200)
      throw new RpcError(
        "BRIDGE_INCOMPATIBLE",
        "Unexpected service on the private socket. Stop the older bridge and reinstall the extension.",
      );
    const health = response.body;
    if (health.service !== "tiled-ai-shared-bridge" || health.version !== 2)
      throw new RpcError(
        "BRIDGE_INCOMPATIBLE",
        "Incompatible service on the configured private socket",
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
    let response: Awaited<ReturnType<typeof ipcPost>>;
    try {
      response = await this.post("/mcp-call", { method, input });
    } catch {
      throw new RpcError(
        "BRIDGE_UNAVAILABLE",
        "Bridge response lost. Do not replay mutations; inspect get_request_status with the original request ID after reconnecting.",
      );
    }
    if (response.status !== 200)
      throw new RpcError("BRIDGE_UNAVAILABLE", "Bridge rejected the request");
    const result = response.body;
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
    if (response.status !== 200)
      throw new RpcError(
        "BRIDGE_UNAVAILABLE",
        "Could not stop the shared bridge",
      );
  }
}
