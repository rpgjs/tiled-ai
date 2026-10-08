import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../packages/server/src/bridge";
import { createEndpoint } from "../packages/server/src/ipc";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SharedBridge } from "../packages/server/src/shared";
test("shared clients reject incompatible bridges and attach to the private service", async () => {
  const bridge = new Bridge();
  const socketPath = await createEndpoint("/tmp");
  await bridge.listen(socketPath);
  try {
    const client = new SharedBridge(socketPath);
    await assert.rejects(() => client.health(), {
      code: "BRIDGE_INCOMPATIBLE",
    });
    bridge.clientCall = async () => ({ sessions: [] });
    assert.equal((await client.health()).service, "tiled-ai-shared-bridge");
    assert.deepEqual(await client.call("get_editor_state", {}), {
      sessions: [],
    });
  } finally {
    await bridge.close();
    await rm(dirname(socketPath), { recursive: true, force: true });
  }
});
