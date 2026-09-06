import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../packages/server/src/bridge";
import { SharedBridge } from "../packages/server/src/shared";
test("shared clients reject older bridges and mismatched secrets explicitly", async () => {
  const bridge = new Bridge("test-shared-secret");
  const port = await bridge.listen(0);
  try {
    const client = new SharedBridge(port, "test-shared-secret");
    await assert.rejects(() => client.health(), {
      code: "BRIDGE_INCOMPATIBLE",
    });
    bridge.clientCall = async () => ({ sessions: [] });
    assert.equal((await client.health()).service, "tiled-ai-shared-bridge");
    await assert.rejects(
      () => new SharedBridge(port, "wrong-secret").health(),
      { code: "BRIDGE_INCOMPATIBLE" },
    );
    assert.deepEqual(await client.call("get_editor_state", {}), {
      sessions: [],
    });
  } finally {
    await bridge.close();
  }
});
