import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const socket = createServer();
await new Promise((r) => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const root = await mkdtemp(join(tmpdir(), "tiled-shared-")),
  config = join(root, "config.json"),
  token = randomBytes(32).toString("hex");
await writeFile(config, JSON.stringify({ port, token }));
const clients = [];
let running = true,
  pollLoop,
  mutations = 0;
const post = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: JSON.stringify(body),
  });
  return res.json();
};
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
  await rm(root, { recursive: true, force: true });
}
