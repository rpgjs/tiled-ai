import { build } from "esbuild";
import { mkdir, chmod } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["packages/extension/src/index.ts"],
  outfile: "dist/tiled-ai.mjs",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2016",
});
await build({
  entryPoints: ["packages/server/src/cli.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/cli.mjs", 0o755);

await build({
  entryPoints: ["packages/server/src/relay.ts"],
  outfile: "dist/relay.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
});

await build({
  entryPoints: ["packages/server/src/ipc.ts"],
  outfile: "dist/ipc.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
});
