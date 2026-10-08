import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(join(await realpath("/tmp"), "tiled-config-"));
const config = join(root, "config.json"),
  extensions = join(root, "extensions");
async function run(...args) {
  const child = spawn(
    process.execPath,
    [resolve("dist/cli.mjs"), ...args, "--config", config],
    { env: { ...process.env, HOME: root } },
  );
  let output = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (output += v));
  const [code] = await once(child, "exit");
  return { code, output };
}
try {
  const token = "synthetic-legacy-secret-do-not-send";
  await writeFile(config, JSON.stringify({ port: 32123, token }));
  for (const command of [
    "init",
    "doctor",
    "bridge-start",
    "bridge-stop",
    "serve",
  ]) {
    const result = await run(command);
    assert.equal(result.code, 1);
    assert.match(result.output, /init --migrate/);
    assert.ok(!result.output.includes(token));
  }
  await writeFile(config, '{"token":"' + token + '" INVALID}');
  const malformed = await run("doctor");
  assert.equal(malformed.code, 1);
  assert.match(malformed.output, /Invalid configuration JSON/);
  assert.ok(!malformed.output.includes(token));
  await writeFile(config, JSON.stringify({ port: 32123, token }));
  assert.equal((await run("init", "--migrate")).code, 0);
  const migrated = JSON.parse(await readFile(config, "utf8"));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.token, undefined);
  assert.equal(migrated.port, undefined);
  assert.equal((await run("init")).code, 0);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")), migrated);
  assert.equal((await run("install", "--extensions", extensions)).code, 0);
  const installed = JSON.parse(
    await readFile(join(extensions, "tiled-ai.config.json"), "utf8"),
  );
  assert.equal(installed.socketPath, migrated.socketPath);
  assert.equal(installed.version, 2);
  assert.equal(installed.node, process.execPath);
  assert.equal(installed.relay, resolve("dist/relay.mjs"));
  assert.equal(installed.token, undefined);
  assert.equal(installed.url, undefined);
  assert.equal((await run("doctor")).code, 0);
  console.log(
    "Configuration passed: legacy commands fail without secrets, explicit migration, idempotent init, private-IPC extension installation.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
