import "./compat";
import { Editor } from "./editor";
import {
  envelopeSchema,
  toolSchemas,
  RpcError,
  type RpcResult,
} from "../../protocol/src/index";
// Qt.callLater is provided by the QQmlEngine used by Tiled.
declare const Qt: { callLater(callback: () => void): void };
const extensionFile = __filename;
// The installer writes the configuration next to the extension, named after
// it. Deriving the name keeps a differently named copy reading its own
// configuration instead of an unrelated installation's endpoint.
const configFile = extensionFile.replace(/\.m?js$/, ".config.json");
interface Config {
  version: 2;
  socketPath: string;
  node: string;
  relay: string;
  autoConnect?: boolean;
}
let connected = false,
  status = "Disconnected",
  sessionId = "",
  editor: Editor | undefined;
let config: Config;
const pending = new Set<Process>();
let generation = 0;
const cache = new Map<string, { signature: string; result: RpcResult }>();
function disconnect() {
  connected = false;
  generation++;
  for (const r of pending) {
    r.kill();
    r.close();
  }
  pending.clear();
  status = "Disconnected";
}
function request(path: string, body: unknown, done: (value: any) => void) {
  const g = generation,
    child = new Process();
  child.codec = "UTF-8";
  pending.add(child);
  const fail = () => {
    disconnect();
    status =
      "Private bridge request failed. Check the bridge, then reconnect; inspect request status before retrying edits.";
    tiled.log("Tiled AI: " + status);
  };
  try {
    if (!child.start(config.node, [config.relay, config.socketPath, path])) {
      fail();
      return;
    }
    child.write(JSON.stringify(body));
    child.closeWriteChannel();
  } catch {
    fail();
    return;
  }
  const deadline = Date.now() + 45000;
  let output = "";
  function check() {
    if (g !== generation) return;
    // Process exposes no completion signal. Yield to Qt between bounded 5ms
    // checks; never wait for the bridge's long poll on the editor thread.
    const finished = child.waitForFinished(5);
    output += child.readStdOut();
    if (output.length > 32 * 1024 * 1024 || Date.now() > deadline) {
      fail();
      return;
    }
    if (!finished && !output.endsWith("\n")) {
      Qt.callLater(check);
      return;
    }
    const code = child.exitCode;
    pending.delete(child);
    child.close();
    if (code !== 0) {
      fail();
      return;
    }
    try {
      const response = JSON.parse(output);
      if (response.status !== 200) {
        fail();
        return;
      }
      done(response.body);
    } catch {
      fail();
    }
  }
  Qt.callLater(check);
}
function poll() {
  if (!connected) return;
  request("/poll", { sessionId }, (value: { command?: unknown }) => {
    if (!value.command) {
      poll();
      return;
    }
    let result: RpcResult;
    let id = "invalid";
    try {
      const cmd = envelopeSchema.parse(value.command);
      id = cmd.id;
      const schema = toolSchemas[cmd.method];
      if (!schema) throw new RpcError("UNKNOWN_METHOD", cmd.method);
      const params = schema.parse(cmd.params);
      const signature = JSON.stringify(cmd);
      const prior = cache.get(id);
      if (prior) {
        if (prior.signature !== signature)
          throw new RpcError(
            "REQUEST_ID_REUSED",
            "Request ID has different content",
          );
        result = prior.result;
      } else {
        try {
          result = { id, ok: true, result: editor!.handle(cmd.method, params) };
        } catch (e) {
          result = errorResult(id, e);
        }
        if (params.requestId)
          cache.set(id, {
            signature,
            result,
          }); /* Never evict mutation IDs within a session. */
      }
    } catch (e) {
      result = errorResult(id, e);
    }
    request("/result", { sessionId, ...result }, () => poll());
  });
}
function errorResult(id: string, e: unknown): RpcResult {
  return {
    id,
    ok: false,
    error: {
      code: e instanceof RpcError ? e.code : "INVALID_REQUEST",
      message: String(e instanceof Error ? e.message : e),
      details:
        e instanceof RpcError
          ? e.details
          : e instanceof Error
            ? e.stack
            : undefined,
    },
  };
}
function connect() {
  disconnect();
  try {
    const f = new TextFile(configFile, TextFile.ReadOnly);
    try {
      config = JSON.parse(f.readAll());
    } finally {
      f.close();
    }
    if (
      config.version !== 2 ||
      typeof config.socketPath !== "string" ||
      !config.socketPath.startsWith("/") ||
      typeof config.node !== "string" ||
      !config.node.startsWith("/") ||
      typeof config.relay !== "string" ||
      !config.relay.startsWith("/")
    )
      throw Error(
        "Legacy or invalid configuration. Re-run CLI install for private IPC; TCP is disabled.",
      );
    status = "Connecting";
    request(
      "/connect",
      {
        version: 1,
        tiledVersion: tiled.version,
        previousSessionId: sessionId || undefined,
      },
      (v: { sessionId: string }) => {
        if (sessionId !== v.sessionId) {
          sessionId = v.sessionId;
          editor?.dispose();
          editor = new Editor(sessionId);
          cache.clear();
        }
        connected = true;
        status = "Connected: " + sessionId;
        poll();
      },
    );
  } catch (e) {
    status =
      "Legacy or invalid configuration. Re-run CLI install for private IPC; TCP is disabled.";
    tiled.log("Tiled AI: " + status);
  }
}
tiled.registerAction("TiledAIConnect", connect).text = "Tiled AI: Connect";
tiled.registerAction("TiledAIDisconnect", disconnect).text =
  "Tiled AI: Disconnect";
tiled.registerAction("TiledAIStatus", () => tiled.alert(status)).text =
  "Tiled AI: Status";
tiled.extendMenu("Map", [
  { action: "TiledAIConnect" },
  { action: "TiledAIDisconnect" },
  { action: "TiledAIStatus" },
]);
// Automatic startup is opt-in and generated by the install command.
try {
  const f = new TextFile(configFile, TextFile.ReadOnly);
  const c = JSON.parse(f.readAll());
  f.close();
  if (c.autoConnect) connect();
} catch {
  /* Configuration is created by the CLI installer. */
}
