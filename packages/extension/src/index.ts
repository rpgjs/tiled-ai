import "./compat";
import { Editor } from "./editor";
import {
  envelopeSchema,
  toolSchemas,
  RpcError,
  type RpcResult,
} from "../../protocol/src/index";
declare class XMLHttpRequest {
  readyState: number;
  status: number;
  responseText: string;
  onreadystatechange: () => void;
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: string): void;
  abort(): void;
}
const extensionFile = __filename;
// The installer writes the configuration next to the extension, named after
// it. Deriving the name keeps a differently named copy reading its own
// configuration instead of an unrelated installation's secret.
const configFile = extensionFile.replace(/\.m?js$/, ".config.json");
interface Config {
  url: string;
  token: string;
  autoConnect?: boolean;
}
let connected = false,
  status = "Disconnected",
  sessionId = "",
  editor: Editor | undefined;
let config: Config;
const pending = new Set<XMLHttpRequest>();
let generation = 0;
const cache = new Map<string, { signature: string; result: RpcResult }>();
function disconnect() {
  connected = false;
  generation++;
  for (const r of pending) r.abort();
  pending.clear();
  status = "Disconnected";
}
function request(path: string, body: unknown, done: (value: any) => void) {
  const g = generation,
    r = new XMLHttpRequest();
  pending.add(r);
  r.open("POST", config.url + path, true);
  r.setRequestHeader("Authorization", "Bearer " + config.token);
  r.setRequestHeader("Content-Type", "application/json");
  r.onreadystatechange = () => {
    if (r.readyState !== 4 || g !== generation) return;
    pending.delete(r);
    if (r.status !== 200) {
      disconnect();
      status = "Connection lost: HTTP " + r.status;
      tiled.log("Tiled AI: " + status);
      return;
    }
    try {
      done(JSON.parse(r.responseText));
    } catch (e) {
      disconnect();
      status = String(e);
      tiled.log("Tiled AI: " + status);
    }
  };
  r.send(JSON.stringify(body));
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
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url) ||
      config.token.length < 32
    )
      throw Error("Invalid local bridge configuration");
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
    status = String(e);
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
