import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../packages/server/src/bridge";
const token = "0123456789abcdef0123456789abcdef";
async function fixture(timeout = 1000) {
  const bridge = new Bridge(token, timeout),
    port = await bridge.listen(0);
  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${port}` + path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const connected = (await (
    await post("/connect", { version: 1 })
  ).json()) as any;
  return { bridge, post, sessionId: connected.sessionId };
}
const mutation = (sessionId: string) => ({
  sessionId,
  documentId: "doc-1",
  requestId: "request-0001",
  expectedRevision: "revision",
  operations: [
    {
      op: "set_properties",
      target: "document",
      properties: { name: { type: "string", value: "test" } },
    },
  ],
});
test("local bridge rejects invalid tokens, browser origins and protocol versions", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.post("/connect", { version: 1 }, { authorization: "wrong" }))
        .status,
      403,
    );
    assert.equal(
      (
        await f.post(
          "/connect",
          { version: 1 },
          { origin: "https://example.org" },
        )
      ).status,
      403,
    );
    assert.equal((await f.post("/connect", { version: 2 })).status, 400);
  } finally {
    await f.bridge.close();
  }
});
test("dispatch, completion, deduplication and conflicting request IDs", async () => {
  const f = await fixture();
  try {
    const p = mutation(f.sessionId),
      pending = f.bridge.call("apply_operations", p);
    const { command } = (await (
      await f.post("/poll", { sessionId: f.sessionId })
    ).json()) as any;
    assert.equal(command.id, p.requestId);
    await f.post("/result", {
      sessionId: f.sessionId,
      id: command.id,
      ok: true,
      result: { applied: true },
    });
    assert.deepEqual(await pending, { applied: true });
    assert.deepEqual(await f.bridge.call("apply_operations", p), {
      applied: true,
    });
    assert.equal(f.bridge.status(f.sessionId, p.requestId).state, "completed");
    await assert.rejects(
      f.bridge.call("apply_operations", { ...p, documentId: "another" }),
      /Reuse requires identical/,
    );
  } finally {
    await f.bridge.close();
  }
});
test("dispatched timeout is ambiguous until the actual response arrives", async () => {
  const f = await fixture(50);
  try {
    const p = mutation(f.sessionId);
    const pending = assert.rejects(
      f.bridge.call("apply_operations", p),
      /Check get_request_status/,
    );
    const { command } = (await (
      await f.post("/poll", { sessionId: f.sessionId })
    ).json()) as any;
    await pending;
    assert.equal(f.bridge.status(f.sessionId, p.requestId).state, "dispatched");
    await f.post("/result", {
      sessionId: f.sessionId,
      id: command.id,
      ok: true,
      result: { applied: true },
    });
    assert.deepEqual(await f.bridge.call("apply_operations", p), {
      applied: true,
    });
  } finally {
    await f.bridge.close();
  }
});
test("expired queued mutations never dispatch after a late poll", async () => {
  const f = await fixture(40);
  try {
    await assert.rejects(
      f.bridge.call("apply_operations", mutation(f.sessionId)),
      /Check get_request_status/,
    );
    const pending = f.post("/poll", { sessionId: f.sessionId });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      f.bridge.status(f.sessionId, "request-0001").state,
      "completed",
    );
    await assert.rejects(
      f.bridge.call("apply_operations", mutation(f.sessionId)),
      /expired before dispatch/,
    );
    await f.bridge.close();
    await pending;
  } finally {
    if (f.bridge.server.listening) await f.bridge.close();
  }
});
test("unknown sessions and unknown outcomes remain explicit", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.bridge.call("get_map_info", { sessionId: "bad", documentId: "doc" }),
      /Connect Tiled first/,
    );
    assert.equal(f.bridge.status(f.sessionId, "never-seen").state, "unknown");
  } finally {
    await f.bridge.close();
  }
});
test("same-session reconnect redelivers an ambiguous request with the identical ID", async () => {
  const f = await fixture();
  try {
    const p = mutation(f.sessionId),
      pending = f.bridge.call("apply_operations", p);
    const first = (await (
      await f.post("/poll", { sessionId: f.sessionId })
    ).json()) as any;
    await f.post("/connect", { version: 1, previousSessionId: f.sessionId });
    const second = (await (
      await f.post("/poll", { sessionId: f.sessionId })
    ).json()) as any;
    assert.deepEqual(second.command, first.command);
    await f.post("/result", {
      sessionId: f.sessionId,
      id: p.requestId,
      ok: true,
      result: { recovered: true },
    });
    assert.deepEqual(await pending, { recovered: true });
  } finally {
    await f.bridge.close();
  }
});
