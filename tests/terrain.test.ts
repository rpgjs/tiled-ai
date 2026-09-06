import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  gridSchema,
  validateGrid,
  wangDefinitionSchema,
  grassDefinition,
  suggestedGrids,
  GRASS_SHA256,
} from "../packages/protocol/src/terrain";
import { imageUrl, loadImage, AssetTools } from "../packages/server/src/assets";
import { findings } from "../scripts/check-public.mjs";

test("grid validates margins, spacing, incompatible dimensions and tile count limits", () => {
  assert.deepEqual(
    validateGrid(
      70,
      36,
      gridSchema.parse({
        tileWidth: 32,
        tileHeight: 32,
        margin: 2,
        spacing: 2,
      }),
    ),
    { columns: 2, rows: 1, tileCount: 2 },
  );
  for (const [w, h, g] of [
    [69, 36, { tileWidth: 32, tileHeight: 32, margin: 2, spacing: 2 }],
    [16, 16, { tileWidth: 32, tileHeight: 32 }],
    [64, 64, { tileWidth: 32, tileHeight: 32, margin: 32 }],
    [1024, 1024, { tileWidth: 1, tileHeight: 1 }],
  ] as const)
    assert.throws(() => validateGrid(w, h, gridSchema.parse(g)));
  assert.equal(
    gridSchema.safeParse({ tileWidth: 0, tileHeight: 32 }).success,
    false,
  );
});
test("recognition requires the exact image, unknown grids remain suggestions", () => {
  assert.equal(
    suggestedGrids(256, 2112, GRASS_SHA256).profile,
    "pipoya-grass-48",
  );
  const unknown = suggestedGrids(256, 2112, "different");
  assert.equal(unknown.recognition, "unknown");
  assert.equal(unknown.profile, null);
  assert.deepEqual(suggestedGrids(17, 19, "different").candidates, []);
});
test("Wang validation rejects invalid indices, missing colors, duplicate tiles and inactive positions", () => {
  const d = {
    name: "Terrain",
    type: "mixed",
    colors: [{ name: "Grass" }],
    assignments: [{ tileId: 0, wangId: [1, 1, 1, 1, 1, 1, 1, 1] }],
  };
  for (const wangId of [
    [1],
    [-1, 0, 0, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0, 0, 0],
    [256, 0, 0, 0, 0, 0, 0, 0],
  ])
    assert.equal(
      wangDefinitionSchema.safeParse({
        ...d,
        assignments: [{ tileId: 0, wangId }],
      }).success,
      false,
    );
  assert.equal(
    wangDefinitionSchema.safeParse({
      ...d,
      assignments: [...d.assignments, ...d.assignments],
    }).success,
    false,
  );
  for (const type of ["edge", "corner"])
    assert.equal(wangDefinitionSchema.safeParse({ ...d, type }).success, false);
  assert.equal(
    wangDefinitionSchema.safeParse({
      ...d,
      type: "edge",
      assignments: [{ tileId: 0, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }],
    }).success,
    true,
  );
  assert.equal(
    wangDefinitionSchema.safeParse({
      ...d,
      type: "corner",
      assignments: [{ tileId: 0, wangId: [0, 1, 0, 1, 0, 1, 0, 1] }],
    }).success,
    true,
  );
  // Variants and incomplete definitions are legal metadata; paint checks completeness for the footprint.
  assert.equal(
    wangDefinitionSchema.safeParse({
      ...d,
      assignments: [...d.assignments, { ...d.assignments[0], tileId: 1 }],
    }).success,
    true,
  );
  assert.equal(
    wangDefinitionSchema.parse(grassDefinition()).assignments.length,
    506,
  );
});
test("HTTPS sources normalize GitHub blob links and reject insecure or credentialed URLs", () => {
  assert.equal(
    imageUrl(
      "https://github.com/rpgjs/starter/blob/v5/src/tiled/%5BA%5DGrass_pipo.png",
    ),
    "https://raw.githubusercontent.com/rpgjs/starter/v5/src/tiled/%5BA%5DGrass_pipo.png",
  );
  assert.throws(() => imageUrl("http://example.com/a.png"));
  assert.throws(() => imageUrl("https://user:password@example.com/a.png"));
});
test("local image inspection returns the pinned hash and refuses invalid input", async () => {
  const image = await loadImage(resolve("examples/grass/grass.png"));
  assert.equal(image.sha256, GRASS_SHA256);
  assert.equal(image.height, 2112);
  await assert.rejects(() => loadImage("relative.png"));
  const dir = await mkdtemp(join(tmpdir(), "tiled-ai-image-"));
  try {
    const file = join(dir, "bad.png");
    await writeFile(file, "not an image");
    await assert.rejects(() => loadImage(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("creation stages an image once and refuses a request ID with different inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tiled-ai-create-"));
  const calls: any[] = [];
  const assets = new AssetTools({
    call: async (method: string, input: any) => {
      calls.push({ method, input });
      return { fileCreated: true };
    },
  } as any);
  try {
    const request = {
      sessionId: "session",
      requestId: "request-001",
      source: resolve("examples/grass/grass.png"),
      name: "Grass",
      outputPath: join(dir, "grass.tsx"),
      grid: { tileWidth: 32, tileHeight: 32 },
    };
    await assets.call("create_tileset_from_image", request);
    await assets.call("create_tileset_from_image", request);
    assert.equal(calls[0].input.source, calls[1].input.source);
    assert.equal((await loadImage(calls[0].input.source)).sha256, GRASS_SHA256);
    await assert.rejects(
      () =>
        assets.call("create_tileset_from_image", { ...request, name: "Other" }),
      { code: "REQUEST_ID_REUSED" },
    );
    await writeFile(request.outputPath, "existing");
    await assert.rejects(
      () =>
        assets.call("create_tileset_from_image", {
          ...request,
          requestId: "request-002",
        }),
      { code: "FILE_EXISTS" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("public-file guard detects personal paths, keys and runtime files", () => {
  assert.deepEqual(
    findings("README.md", "Use /path/to/project and $HOME."),
    [],
  );
  assert.ok(
    findings("example.tmx", "/" + "home/" + "private-user/project").length,
  );
  assert.ok(
    findings("example.json", '"secret": "' + "x".repeat(40) + '"').length,
  );
  assert.ok(
    findings("anything.txt", "-----BEGIN " + "PRIVATE KEY-----").length,
  );
  assert.ok(findings(".env", "").length);
});

test("map creation requires dimensions, destination and a deduplicatable request", async () => {
  const { toolSchemas } = await import("../packages/protocol/src/index");
  const input = {
    sessionId: "session",
    requestId: "create-map-1",
    outputPath: "/path/to/map.tmx",
    width: 24,
    height: 20,
    tileWidth: 32,
    tileHeight: 32,
  };
  const parsed = toolSchemas.create_map.parse(input);
  assert.equal(parsed.orientation, "orthogonal");
  assert.deepEqual(parsed.layers, ["Ground"]);
  for (const patch of [
    { width: 0 },
    { height: 1.5 },
    { tileWidth: 0 },
    { layers: [] },
    { orientation: "unknown" },
    { requestId: "x" },
    { outputPath: "" },
  ])
    assert.equal(
      toolSchemas.create_map.safeParse({ ...input, ...patch }).success,
      false,
    );
  assert.equal(
    toolSchemas.save_map.safeParse({
      sessionId: "s",
      documentId: "d",
      requestId: "save-map-1",
    }).success,
    false,
  );
  assert.equal(
    toolSchemas.save_map.safeParse({
      sessionId: "s",
      documentId: "d",
      requestId: "save-map-1",
      expectedRevision: "r",
    }).success,
    true,
  );
});
