// Runs the shipped extension and relay in real Tiled, using a dialog solely to
// keep --evaluate's Qt event loop alive. No global extensions are installed.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createEndpoint, ipcPost } from "../dist/ipc.mjs";
const app = process.env.TILED_APPIMAGE || "tiled";
const socketPath = await createEndpoint("/tmp"),
  root = dirname(socketPath);
const configPath = join(root, "bridge.json"),
  extension = join(root, "probe.mjs"),
  control = join(root, "control");
await writeFile(configPath, JSON.stringify({ version: 2, socketPath }));
await writeFile(
  join(root, "probe.config.json"),
  JSON.stringify({
    version: 2,
    socketPath,
    node: process.execPath,
    relay: resolve("dist/relay.mjs"),
    autoConnect: true,
  }),
);
const source = await readFile("dist/tiled-ai.mjs", "utf8");
// --evaluate has no Map menu. Suppress only that registration in the test
// copy; request/response, Process, Qt callbacks and editor code run unchanged.
assert.equal(source.split('tiled.extendMenu("Map",').length, 2);
const headlessSource = source.replace(
  'tiled.extendMenu("Map",',
  'if (false) tiled.extendMenu("Map",',
);
await writeFile(
  extension,
  headlessSource +
    `
const probeDialog = new Dialog("Tiled AI private IPC verification");
const probeDeadline = Date.now() + 30000;
function probeTick() {
  if (Date.now() > probeDeadline) { tiled.trigger("TiledAIDisconnect"); probeDialog.reject(); return; }
  if (File.exists(${JSON.stringify(control)})) {
    const f = new TextFile(${JSON.stringify(control)}, TextFile.ReadOnly);
    const command = f.readAll(); f.close(); File.remove(${JSON.stringify(control)});
    if (command === "reconnect") { tiled.trigger("TiledAIConnect"); }
    if (command === "stop") { tiled.trigger("TiledAIDisconnect"); probeDialog.accept(); return; }
  }
  Qt.callLater(probeTick);
}
Qt.callLater(probeTick);
probeDialog.exec();
`,
);
let logs = "",
  tiled;
const bridge = spawn(process.execPath, [
  resolve("dist/cli.mjs"),
  "bridge",
  "--config",
  configPath,
]);
bridge.stderr.on("data", (v) => (logs += v));
const post = async (path, body) => {
  const response = await ipcPost(socketPath, path, body);
  assert.equal(response.status, 200);
  return response.body;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function state() {
  const reply = await post("/mcp-call", {
    method: "get_editor_state",
    input: {},
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      await post("/health", {});
      break;
    } catch {
      await sleep(50);
    }
  }
  tiled = spawn(app, ["--evaluate", extension], {
    env: {
      ...process.env,
      QT_LOGGING_RULES: "qt.qml.usedbeforedeclared=false",
    },
  });
  tiled.on("error", (e) => (logs += e));
  tiled.stdout.on("data", (v) => (logs += v));
  tiled.stderr.on("data", (v) => (logs += v));
  let session;
  for (let i = 0; i < 100; i++) {
    session = (await state()).sessions[0];
    if (session) break;
    await sleep(100);
  }
  assert.ok(
    session && !session.error,
    "Extension failed to connect/poll/reply: " + logs,
  );
  assert.deepEqual(session.documents, []);
  await writeFile(control, "reconnect");
  await sleep(500);
  const reconnected = (await state()).sessions[0];
  assert.equal(reconnected.sessionId, session.sessionId);
  assert.deepEqual(reconnected.documents, []);
  await post("/stop", {});
  await sleep(300);
  await writeFile(control, "stop");
  const [code] = await once(tiled, "exit");
  assert.equal(code, 0, logs);
  console.log(
    "Real Tiled private IPC passed: bundled extension, child relay, connect, poll/reply, same-session reconnect, bridge shutdown, editor disconnect.",
  );
} finally {
  tiled?.kill();
  bridge.kill();
  await rm(root, { recursive: true, force: true });
}
