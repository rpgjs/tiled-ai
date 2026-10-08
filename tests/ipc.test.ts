import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  createEndpoint,
  ipcPost,
  validateEndpoint,
} from "../packages/server/src/ipc";
import { Bridge } from "../packages/server/src/bridge";
import { SharedBridge } from "../packages/server/src/shared";
import { build } from "esbuild";
import vm from "node:vm";

const relayCode = (
  await build({
    entryPoints: ["packages/server/src/relay.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
  })
).outputFiles[0].text;
async function relay(
  socketPath: string,
  path = "/connect",
  body = { version: 1 },
) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    relayCode,
    "relay.mjs",
    socketPath,
    path,
  ]);
  let output = "";
  child.stdout.on("data", (part) => (output += part));
  child.stdin.end(JSON.stringify(body));
  const [code] = await once(child, "exit");
  return { code, response: JSON.parse(output) };
}

test("private IPC rejects unsafe directories, endpoint symlinks and legacy TCP addresses before sending", async () => {
  const socketPath = await createEndpoint("/tmp"),
    directory = dirname(socketPath);
  const bridge = new Bridge();
  bridge.clientCall = async () => ({ sessions: [] });
  try {
    await bridge.listen(socketPath);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(socketPath)).mode & 0o777, 0o600);
    assert.equal((await ipcPost(socketPath, "/health", {})).body.version, 2);
    assert.equal((await relay(socketPath)).response.status, 200);
    await chmod(directory, 0o755);
    await assert.rejects(
      ipcPost(socketPath, "/health", {}),
      /Unsafe IPC directory/,
    );
    assert.equal((await relay(socketPath)).code, 1);
    await chmod(directory, 0o700);
    const alias = join(directory, "alias.sock");
    await symlink(socketPath, alias);
    await assert.rejects(validateEndpoint(alias), /Unsafe IPC endpoint/);
    await symlink(directory, join(directory, "alias"));
    await assert.rejects(
      validateEndpoint(join(directory, "alias", "bridge.sock")),
      /Unsafe IPC directory/,
    );
    await writeFile(join(directory, "file"), "not a socket");
    await assert.rejects(
      validateEndpoint(join(directory, "file")),
      /Unsafe IPC endpoint/,
    );
    await assert.rejects(
      ipcPost("http://127.0.0.1:32123", "/connect", {}),
      /Invalid private socket/,
    );
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("starting a second bridge never deletes a live listener", async () => {
  const socketPath = await createEndpoint("/tmp"),
    first = new Bridge(),
    second = new Bridge();
  first.clientCall = async () => "original service";
  try {
    await first.listen(socketPath);
    const inode = (await lstat(socketPath)).ino;
    await assert.rejects(second.listen(socketPath), { code: "EADDRINUSE" });
    assert.equal((await lstat(socketPath)).ino, inode);
    assert.equal(
      await new SharedBridge(socketPath).call("test", {}),
      "original service",
    );
  } finally {
    await first.close();
    await rm(dirname(socketPath), { recursive: true, force: true });
  }
});

test("crashed endpoints fail closed without unlinking or replacing them", async () => {
  const socketPath = await createEndpoint("/tmp");
  const child = spawn(process.execPath, [
    "-e",
    'process.umask(0o177);require("node:net").createServer().listen(process.argv[1],()=>console.log("ready"))',
    socketPath,
  ]);
  try {
    await once(child.stdout, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    const inode = (await lstat(socketPath)).ino;
    await assert.rejects(new SharedBridge(socketPath).health(), {
      code: "BRIDGE_STALE_SOCKET",
    });
    await assert.rejects(new Bridge().listen(socketPath), {
      code: "EADDRINUSE",
    });
    assert.equal((await lstat(socketPath)).ino, inode);
  } finally {
    child.kill();
    await rm(dirname(socketPath), { recursive: true, force: true });
  }
});

test("an impostor TCP endpoint receives nothing from MCP, relay, or a legacy-configured extension", async () => {
  let received = 0;
  const impostor = createServer((req, res) => {
    received++;
    res.end('{"service":"tiled-ai-shared-bridge","version":2}');
  });
  await new Promise<void>((r) => impostor.listen(0, "127.0.0.1", r));
  const address = impostor.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(new SharedBridge(url).health(), {
      code: "BRIDGE_UNAVAILABLE",
    });
    assert.equal((await relay(url)).code, 1);
    const output = await build({
      entryPoints: ["packages/extension/src/index.ts"],
      bundle: true,
      write: false,
      format: "iife",
      target: "es2016",
    });
    const logs: string[] = [];
    let processes = 0;
    vm.runInNewContext(output.outputFiles[0].text, {
      __filename: "extension.mjs",
      TextFile: class {
        static ReadOnly = 0;
        readAll() {
          return JSON.stringify({
            url,
            token: "synthetic-legacy-secret",
            autoConnect: true,
          });
        }
        close() {}
      },
      Process: class {
        constructor() {
          processes++;
        }
      },
      tiled: {
        registerAction: () => ({}),
        extendMenu() {},
        log: (s: string) => logs.push(s),
      },
    });
    assert.match(logs.join("\n"), /Legacy or invalid configuration/);
    assert.equal(processes, 0);
    assert.equal(received, 0);
  } finally {
    await new Promise<void>((r) => impostor.close(() => r()));
  }
});

test("captured old bearer authority is rejected by the private bridge", async () => {
  const socketPath = await createEndpoint("/tmp"),
    bridge = new Bridge();
  let calls = 0;
  bridge.clientCall = async () => ++calls;
  try {
    await bridge.listen(socketPath);
    assert.equal(
      (
        await ipcPost(socketPath, "/mcp-call", {}, 1000, {
          authorization: "Bearer synthetic-legacy-secret",
        })
      ).status,
      403,
    );
    assert.equal(calls, 0);
    assert.equal(await new SharedBridge(socketPath).call("test", {}), 1);
  } finally {
    await bridge.close();
    await rm(dirname(socketPath), { recursive: true, force: true });
  }
});
