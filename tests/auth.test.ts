import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Bridge } from "../packages/server/src/bridge";
import { BridgeChannel } from "../packages/server/src/channel";
import { SharedBridge } from "../packages/server/src/shared";
import { ServerAuth, nodeCrypto } from "../packages/server/src/auth";
import { hmacSha256Hex, sha256Hex } from "../packages/protocol/src/sha256";
import {
  ClientChannel,
  HEADERS,
  weakNonce,
  pureCrypto,
} from "../packages/protocol/src/auth";
import { createServer } from "node:http";
const token = "0123456789abcdef0123456789abcdef";
test("pure SHA-256/HMAC match node:crypto, including UTF-8 and block boundaries", () => {
  const samples = [
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(65),
    "é€😀 mixed",
    "lone \ud800 surrogate",
    JSON.stringify({ nested: { list: [1, 2, 3], text: "x".repeat(1000) } }),
    "z".repeat(100_000),
  ];
  for (const m of samples) {
    const bytes = Buffer.from(m, "utf8");
    assert.equal(
      sha256Hex(m),
      createHash("sha256").update(bytes).digest("hex"),
    );
    for (const key of ["k", token, "K".repeat(64), "K".repeat(200), "ключ"])
      assert.equal(
        hmacSha256Hex(key, m),
        createHmac("sha256", Buffer.from(key, "utf8"))
          .update(bytes)
          .digest("hex"),
      );
  }
});
async function fixture() {
  const bridge = new Bridge(token, 500),
    port = await bridge.listen(0);
  return { bridge, port };
}
const hello = (port: number, clientNonce: string) =>
  fetch(`http://127.0.0.1:${port}/handshake`, {
    method: "POST",
    body: JSON.stringify({ clientNonce }),
  }).then((r) => r.json() as Promise<any>);
test("the extension-side client and the server agree through a real handshake and signed request", async () => {
  const { bridge, port } = await fixture();
  try {
    const cn = weakNonce(pureCrypto);
    const channel = ClientChannel.accept(
      pureCrypto,
      token,
      cn,
      await hello(port, cn),
    );
    assert.ok(channel);
    const body = JSON.stringify({ version: 1 });
    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      method: "POST",
      headers: channel.sign("POST", "/connect", body),
      body,
    });
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as any).sessionId);
  } finally {
    await bridge.close();
  }
});
test("a client refuses a server that cannot prove the secret and sends nothing", async () => {
  const requests: string[] = [];
  const impostor = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    // Plausible reply with a proof made from a guessed secret.
    res.end(
      JSON.stringify({
        serverNonce: "abc",
        proof: createHmac("sha256", "guess").update("x").digest("hex"),
      }),
    );
  });
  await new Promise<void>((r) => impostor.listen(0, "127.0.0.1", () => r()));
  const port = (impostor.address() as { port: number }).port;
  try {
    await assert.rejects(() => new SharedBridge(port, token).health(), {
      code: "BRIDGE_INCOMPATIBLE",
    });
    assert.deepEqual(requests, ["/handshake"]);
    assert.ok(
      !JSON.stringify(requests).includes(token),
      "the secret is never transmitted",
    );
  } finally {
    impostor.close();
  }
});
test("wrong secrets fail on both sides", async () => {
  const { bridge, port } = await fixture();
  try {
    await assert.rejects(
      () => new BridgeChannel(port, "x".repeat(32)).post("/connect", {}),
      { code: "BRIDGE_INCOMPATIBLE" },
    );
    // A forged client with the right handshake but the wrong key is denied.
    const cn = weakNonce(pureCrypto),
      server = await hello(port, cn);
    const forged = ClientChannel.accept(
      { ...pureCrypto, hmac: (_k, m) => pureCrypto.hmac("wrong", m) },
      "wrong",
      cn,
      {
        serverNonce: server.serverNonce,
        proof: pureCrypto.hmac(
          "wrong",
          ["tiled-ai v2", "server", cn, server.serverNonce].join("\n"),
        ),
      },
    )!;
    const res = await fetch(`http://127.0.0.1:${port}/connect`, {
      method: "POST",
      headers: forged.sign("POST", "/connect", "{}"),
      body: "{}",
    });
    assert.equal(res.status, 403);
  } finally {
    await bridge.close();
  }
});
test("replays, tampered bodies and altered paths are denied", async () => {
  const { bridge, port } = await fixture();
  try {
    const cn = weakNonce(pureCrypto);
    const channel = ClientChannel.accept(
      pureCrypto,
      token,
      cn,
      await hello(port, cn),
    )!;
    const body = JSON.stringify({ version: 1 });
    const send = (
      path: string,
      text: string,
      headers: Record<string, string>,
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers,
        body: text,
      });
    const signed = channel.sign("POST", "/connect", body);
    assert.equal((await send("/connect", body, signed)).status, 200);
    assert.equal((await send("/connect", body, signed)).status, 403, "replay");
    const next = channel.sign("POST", "/connect", body);
    assert.equal(
      (await send("/connect", JSON.stringify({ version: 2 }), next)).status,
      403,
      "body",
    );
    assert.equal(
      (await send("/stop", body, channel.sign("POST", "/connect", body)))
        .status,
      403,
      "path",
    );
    const noMac = { ...channel.sign("POST", "/connect", body) };
    delete (noMac as any)[HEADERS.mac];
    assert.equal((await send("/connect", body, noMac)).status, 403);
  } finally {
    await bridge.close();
  }
});
test("channels survive reuse but a restarted bridge forces a fresh handshake", async () => {
  const first = await fixture();
  const client = new BridgeChannel(first.port, token);
  assert.equal((await client.post("/connect", { version: 1 })).status, 200);
  assert.equal((await client.post("/connect", { version: 1 })).status, 200);
  await first.bridge.close();
  const second = new Bridge(token);
  await second.listen(first.port);
  try {
    // The old channel's server nonce carries the previous boot key's tag: the
    // bridge answers "expired" and the client transparently re-handshakes.
    assert.equal((await client.post("/connect", { version: 1 })).status, 200);
  } finally {
    await second.close();
  }
});
test("server channels expire after the handshake window and idle time", () => {
  let now = 1_000_000;
  const auth = new ServerAuth(token, () => now);
  const cn = weakNonce(pureCrypto);
  const channel = ClientChannel.accept(
    pureCrypto,
    token,
    cn,
    auth.handshake(cn),
  )!;
  const verify = (seqBody = "{}") => {
    const h = channel.sign("POST", "/p", seqBody);
    return auth.verify("POST", "/p", seqBody, (n) => h[n]);
  };
  assert.equal(verify(), "ok");
  now += 14 * 60_000;
  assert.equal(verify(), "ok", "activity keeps the channel alive");
  now += 16 * 60_000;
  assert.equal(verify(), "expired", "idle channel");
  const late = ClientChannel.accept(pureCrypto, token, cn, auth.handshake(cn))!;
  now += 61_000;
  const h = late.sign("POST", "/p", "{}");
  assert.equal(
    auth.verify("POST", "/p", "{}", (n) => h[n]),
    "expired",
    "unused handshake",
  );
  assert.equal(auth.handshake("not-a-nonce"), undefined);
  void nodeCrypto;
});
