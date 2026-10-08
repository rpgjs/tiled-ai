import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createEndpoint, ipcPost } from "../dist/ipc.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "tiled-shared-")),
  config = join(root, "config.json"),
  socketPath = await createEndpoint("/tmp");
await writeFile(config, JSON.stringify({ version: 2, socketPath }));
const clients = [];
let running = true,
  pollLoop,
  mutations = 0;
const post = async (path, body) => (await ipcPost(socketPath, path, body)).body;
async function start() {
  const c = new Client({ name: "shared-test", version: "1" });
  clients.push(c);
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.mjs"), "serve", "--config", config],
      stderr: "ignore",
    }),
  );
  return c;
}
async function call(c, name, args = {}) {
  const result = await c.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
try {
  const [first, second] = await Promise.all([start(), start()]);
  for (const c of [first, second])
    assert.ok((await c.listTools()).tools.some((t) => t.name === "create_map"));
  const original = await post("/health", {});
  const started = JSON.parse(
    execFileSync(
      process.execPath,
      [resolve("dist/cli.mjs"), "bridge-start", "--config", config],
      { encoding: "utf8" },
    ),
  );
  assert.equal(started.started, true);
  assert.equal(started.pid, original.pid);
  const { sessionId } = await post("/connect", { version: 1 });
  pollLoop = (async () => {
    while (running) {
      const { command } = await post("/poll", { sessionId });
      if (!command) continue;
      let result;
      if (command.method === "get_editor_state")
        result = { sessionId, documents: [] };
      else {
        mutations++;
        result = { documentId: "map-created", fileCreated: true };
      }
      await post("/result", { sessionId, id: command.id, ok: true, result });
    }
  })().catch((e) => {
    if (running) throw e;
  });
  const states = await Promise.all([
    call(first, "get_editor_state"),
    call(second, "get_editor_state"),
  ]);
  assert.equal(
    states[0].sessions[0].sessionId,
    states[1].sessions[0].sessionId,
  );
  const input = {
    sessionId,
    requestId: randomUUID(),
    outputPath: join(root, "map.tmx"),
    width: 4,
    height: 4,
    tileWidth: 32,
    tileHeight: 32,
  };
  const results = await Promise.all([
    call(first, "create_map", input),
    call(second, "create_map", input),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(mutations, 1);
  await first.close();
  assert.equal((await post("/health", {})).pid, original.pid);
  assert.equal(
    (await call(second, "get_editor_state")).sessions[0].sessionId,
    sessionId,
  );
  const third = await start();
  assert.deepEqual(await call(third, "create_map", input), results[0]);
  assert.equal(mutations, 1);
  assert.equal(
    (
      await call(third, "get_request_status", {
        sessionId,
        requestId: input.requestId,
      })
    ).state,
    "completed",
  );
  const reused = await third.callTool({
    name: "create_map",
    arguments: { ...input, width: 5 },
  });
  assert.equal(reused.isError, true);
  assert.equal(JSON.parse(reused.content[0].text).code, "REQUEST_ID_REUSED");
  console.log(
    "Shared MCP passed: concurrent startup, tools in both clients, common session, cross-client deduplication, first client exit and third client recovery.",
  );
} finally {
  running = false;
  await Promise.allSettled(clients.map((c) => c.close()));
  await post("/stop", {}).catch(() => {});
  await pollLoop;
  await rm(dirname(socketPath), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
