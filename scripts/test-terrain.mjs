import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
export async function testTerrain({
  json,
  call,
  rejected,
  ctl,
  root,
  checks,
  saveDemo,
}) {
  const state = (await json("get_editor_state")).sessions[0],
    sessionId = state.sessionId;
  const source = resolve("examples/grass/grass.png"),
    outputPath = join(root, "grass.tsx");
  const inspected = await json("inspect_tileset_image", { source });
  assert.equal(inspected.layout.profile, "pipoya-grass-48");
  assert.equal(inspected.width, 256);
  assert.equal(inspected.height, 2112);
  const create = {
    sessionId,
    requestId: randomUUID(),
    source,
    outputPath,
    name: "Grass",
    grid: { tileWidth: 32, tileHeight: 32 },
  };
  console.log("Terrain: creating TSX");
  const created = await json("create_tileset_from_image", create);
  assert.equal(created.fileCreated, true);
  assert.equal(created.documentOpened, true);
  assert.deepEqual(await json("create_tileset_from_image", create), created);
  await rejected(
    "create_tileset_from_image",
    { ...create, requestId: randomUUID() },
    "FILE_EXISTS",
  );
  const target = { sessionId, documentId: created.documentId };
  const revision = async (t) => (await json("get_map_info", t)).revision;
  const mutation = async (name, args, t = target) =>
    json(name, {
      ...t,
      requestId: randomUUID(),
      expectedRevision: await revision(t),
      ...args,
    });
  console.log("Terrain: creating Wang set");
  const wang = await mutation("create_wang_set", {
    profile: "pipoya-grass-48",
  });
  const wangSetId = wang.result.wangSetId;
  const sets = await json("list_wang_sets", target);
  assert.equal(sets.items[0].colors.length, 11);
  assert.equal(sets.items[0].assignments.length, 506);
  // Reference is read only after generation and only by the test oracle.
  const reference = await readFile(
    "tests/fixtures/grass-reference.tsx",
    "utf8",
  );
  const ref = [
    ...reference.matchAll(/<wangtile tileid="(\d+)" wangid="([\d,]+)"/g),
  ].map((m) => ({ tileId: Number(m[1]), wangId: m[2].split(",").map(Number) }));
  assert.deepEqual(sets.items[0].assignments, ref);
  console.log("Terrain: Undo Wang");
  await ctl("undo");
  assert.equal((await json("list_wang_sets", target)).items.length, 0);
  await ctl("redo");
  const restored = (await json("list_wang_sets", target)).items[0];
  const definition = {
    name: restored.name,
    type: restored.type,
    colors: restored.colors.map((c) => ({ name: c.name })),
    assignments: restored.assignments,
  };
  const before = await revision(target);
  await mutation("update_wang_set", {
    wangSetId: restored.id,
    definition: { ...definition, name: "Grass updated" },
  });
  await rejected(
    "save_tileset",
    { ...target, requestId: randomUUID(), expectedRevision: before },
    "CONFLICT",
  );
  await ctl("undo");
  // Resizing and renaming must also survive Undo/Redo (native color-name commands crash here).
  await mutation("update_wang_set", {
    wangSetId: restored.id,
    definition: {
      name: "Reduced",
      type: "edge",
      colors: [{ name: 'Grass & <green> "$&"' }],
      assignments: [{ tileId: 14, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }],
    },
  });
  await ctl("undo");
  await ctl("redo");
  assert.equal(
    (await json("list_wang_sets", target)).items[0].colors.length,
    1,
  );
  await mutation("save_tileset", {});
  assert.match(
    await readFile(outputPath, "utf8"),
    /Grass &amp; &lt;green&gt; &quot;\$&amp;&quot;/,
  );
  await ctl("undo");
  await rejected(
    "update_wang_set",
    {
      ...target,
      requestId: randomUUID(),
      expectedRevision: await revision(target),
      wangSetId: restored.id,
      definition: {
        ...definition,
        assignments: [{ tileId: 9999, wangId: [1, 1, 1, 1, 1, 1, 1, 1] }],
      },
    },
    "TILE_NOT_FOUND",
  );
  console.log("Terrain: saving tileset");
  await mutation("save_tileset", {});
  await ctl("close");
  const reopened = await json("open_tileset", {
    sessionId,
    requestId: randomUUID(),
    path: outputPath,
  });
  const ts = { sessionId, documentId: reopened.documentId };
  const ws = (await json("list_wang_sets", ts)).items[0];
  assert.equal(ws.assignments.length, 506);
  checks.push(
    "PNG-only TSX creation, overwrite refusal, idempotency, Wang profile/reference equivalence, update conflict, Undo and saved reload",
  );
  const mapPath = join(root, "terrain-map.tmx");
  const mapRequest = {
    sessionId,
    requestId: randomUUID(),
    outputPath: mapPath,
    width: 24,
    height: 20,
    tileWidth: 32,
    tileHeight: 32,
    layers: ["Ground", "Terrain"],
  };
  await rejected(
    "create_map",
    {
      ...mapRequest,
      requestId: randomUUID(),
      outputPath: join(root, "invalid.tmx"),
      orientation: "hexagonal",
    },
    "INVALID_GEOMETRY",
  );
  await rejected(
    "save_map",
    { ...ts, requestId: randomUUID(), expectedRevision: await revision(ts) },
    "WRONG_DOCUMENT",
  );
  for (const [orientation, index] of [
    ["orthogonal", 1],
    ["isometric", 2],
    ["staggered", 3],
    ["hexagonal", 4],
  ]) {
    const file = join(root, "orientations", orientation + ".tmx");
    const made = await json("create_map", {
      ...mapRequest,
      requestId: randomUUID(),
      outputPath: file,
      width: 4,
      height: 4,
      orientation,
      infinite: true,
      staggerAxis: "x",
      staggerIndex: "even",
      hexSideLength: 16,
    });
    const info = await json("get_map_info", {
      sessionId,
      documentId: made.documentId,
    });
    assert.equal(info.orientation, index);
    assert.equal(info.infinite, true);
    if (orientation === "hexagonal") assert.equal(info.hexSideLength, 16);
    assert.match(
      await readFile(file, "utf8"),
      new RegExp('orientation="' + orientation + '"'),
    );
    await ctl("close");
  }
  const newMap = await json("create_map", mapRequest);
  assert.equal(newMap.fileCreated, true);
  assert.equal(newMap.documentOpened, true);
  assert.deepEqual(await json("create_map", mapRequest), newMap);
  await rejected(
    "create_map",
    { ...mapRequest, requestId: randomUUID() },
    "FILE_EXISTS",
  );
  const map = { sessionId, documentId: newMap.documentId };
  await mutation("attach_tileset", { tilesetDocumentId: ts.documentId }, map);
  await ctl("undo");
  assert.equal((await json("list_tilesets", map)).items.length, 0);
  await ctl("redo");
  const tilesetId = (await json("list_tilesets", map)).items[0].id;
  const paint = async (extra) =>
    mutation(
      "paint_terrain",
      {
        layerId: 2,
        tilesetId,
        wangSetId: ws.id,
        colorId: 1,
        region: { x: 2, y: 2, width: 8, height: 8 },
        ...extra,
      },
      map,
    );
  console.log("Terrain: painting");
  await ctl("select", { x: 2, y: 2, width: 8, height: 8 });
  await paint({});
  assert.notEqual((await ctl("cell", { layer: 1, x: 2, y: 2 })).id, null);
  await ctl("undo");
  assert.equal((await ctl("cell", { layer: 1, x: 2, y: 2 })).id, null);
  await ctl("redo");
  await rejected(
    "paint_terrain",
    {
      ...map,
      requestId: randomUUID(),
      expectedRevision: await revision(map),
      layerId: 2,
      tilesetId,
      wangSetId: ws.id,
      colorId: 1,
      region: { x: 0, y: 0, width: 24, height: 20 },
      cells: [{ x: 0, y: 0 }],
    },
    "OUTSIDE_SELECTION",
  );
  // The existing center has nonzero connections which an isolated repaint cannot break.
  await rejected(
    "paint_terrain",
    {
      ...map,
      requestId: randomUUID(),
      expectedRevision: await revision(map),
      layerId: 2,
      tilesetId,
      wangSetId: ws.id,
      colorId: 2,
      region: { x: 4, y: 4, width: 1, height: 1 },
    },
    "BOUNDARY_CONFLICT",
  );
  const saveRequest = {
    ...map,
    requestId: randomUUID(),
    expectedRevision: await revision(map),
  };
  const saved = await json("save_map", saveRequest);
  assert.equal(saved.saved, true);
  assert.equal(saved.modified, false);
  assert.deepEqual(await json("save_map", saveRequest), saved);
  const disk = await readFile(mapPath, "utf8");
  assert.match(disk, /source="grass.tsx"/);
  await ctl("undo");
  assert.equal((await ctl("cell", { layer: 1, x: 2, y: 2 })).id, null);
  assert.equal(await readFile(mapPath, "utf8"), disk);
  await rejected(
    "save_map",
    { ...saveRequest, requestId: randomUUID() },
    "CONFLICT",
  );
  await ctl("redo");
  const copyPath = join(root, "copies", "terrain.tmx");
  const copy = await mutation("save_map", { outputPath: copyPath }, map);
  assert.equal(copy.savedCopy, true);
  assert.equal(copy.documentFilePath, mapPath);
  await rejected(
    "save_map",
    {
      ...map,
      requestId: randomUUID(),
      expectedRevision: await revision(map),
      outputPath: copyPath,
    },
    "FILE_EXISTS",
  );
  await mutation("save_map", {}, map);
  await ctl("close");
  const openedMap = await json("open_map", {
    sessionId,
    requestId: randomUUID(),
    path: mapPath,
  });
  map.documentId = openedMap.documentId;
  assert.notEqual((await ctl("cell", { layer: 1, x: 2, y: 2 })).id, null);
  checks.push(
    "MCP creates four map orientations, deduplicates creation/save, refuses overwrite, saves relative TSX links, preserves Undo and reopens the saved map",
  );
  // All four orientations have an explicit, tested result; unsupported topology does not mutate.
  for (const value of [1, 2, 3, 4]) {
    await ctl("orientation", { value, infinite: true });
    if (value <= 2) {
      await paint({ region: { x: -8, y: -8, width: 4, height: 4 } });
      assert.notEqual((await ctl("cell", { layer: 1, x: -8, y: -8 })).id, null);
    } else
      await rejected(
        "paint_terrain",
        {
          ...map,
          requestId: randomUUID(),
          expectedRevision: await revision(map),
          layerId: 2,
          tilesetId,
          wangSetId: ws.id,
          colorId: 1,
          region: { x: -8, y: -8, width: 4, height: 4 },
        },
        "UNSUPPORTED_TERRAIN_ORIENTATION",
      );
  }
  await ctl("orientation", { value: 1, infinite: false });
  // Start with an empty terrain layer for irregular footprints.
  await mutation(
    "apply_operations",
    {
      operations: [
        {
          op: "fill_region",
          layerId: 2,
          region: { x: 0, y: 0, width: 24, height: 20 },
          tile: null,
        },
      ],
    },
    map,
  );
  await ctl("select", {
    x: 2,
    y: 2,
    width: 8,
    height: 8,
    hole: { x: 5, y: 5, width: 2, height: 2 },
  });
  await paint({});
  assert.equal((await ctl("cell", { layer: 1, x: 5, y: 5 })).id, null);
  assert.notEqual((await ctl("cell", { layer: 1, x: 4, y: 5 })).id, null);
  await ctl("lock", { layer: 1, value: true });
  await rejected(
    "paint_terrain",
    {
      ...map,
      requestId: randomUUID(),
      expectedRevision: await revision(map),
      layerId: 2,
      tilesetId,
      wangSetId: ws.id,
      colorId: 1,
      region: { x: 2, y: 2, width: 8, height: 8 },
    },
    "LAYER_LOCKED",
  );
  await ctl("lock", { layer: 1, value: false });
  await ctl("select", { x: 12, y: 2, width: 8, height: 8 });
  await paint({
    colorId: 2,
    region: { x: 12, y: 2, width: 8, height: 8 },
    cells: [
      ...Array.from({ length: 3 }, (_, y) =>
        Array.from({ length: 3 }, (_, x) => ({ x: x + 12, y: y + 2 })),
      ).flat(),
      ...Array.from({ length: 3 }, (_, y) =>
        Array.from({ length: 3 }, (_, x) => ({ x: x + 17, y: y + 7 })),
      ).flat(),
    ],
  });
  await rejected(
    "paint_terrain",
    {
      ...map,
      requestId: randomUUID(),
      expectedRevision: await revision(map),
      layerId: 2,
      tilesetId,
      wangSetId: ws.id,
      colorId: 2,
      region: { x: 12, y: 2, width: 8, height: 8 },
      cells: [{ x: 16, y: 5 }],
    },
    "MISSING_WANG_PATTERN",
  );
  checks.push(
    "Terrain borders, inner/outer corners, holes, islands, disjoint selection, locks, missing combinations, negative cells and four orientation outcomes",
  );
  if (saveDemo) {
    await ctl("orientation", { value: 1, infinite: false });
    // Fill a separate ground layer, leaving terrain geometry visible above it.
    await mutation(
      "apply_operations",
      {
        operations: [
          {
            op: "fill_region",
            layerId: 1,
            region: { x: 0, y: 0, width: 24, height: 20 },
            tile: { tilesetId, tileId: 350, flags: 0 },
          },
        ],
      },
      map,
    );
    const dir = resolve("examples/grass");
    await mkdir(dir, { recursive: true });
    await copyFile(outputPath, join(dir, "grass.tsx"));
    const imported = /source="([^"]+)"/.exec(
      await readFile(outputPath, "utf8"),
    )[1];
    await copyFile(join(root, imported), join(dir, imported));
    const rawMap = join(root, "grass-map.tmx");
    await mutation("save_map", { outputPath: rawMap }, map);
    let xml = await readFile(rawMap, "utf8");
    xml = xml.replace(/(<tileset[^>]*source=")[^"]+("\/>)/, "$1grass.tsx$2");
    await writeFile(join(dir, "terrain.tmx"), xml);
    await ctl("image", { path: join(dir, "terrain.png") });
    await writeFile(
      join(dir, "sources.json"),
      JSON.stringify(
        {
          repository: "https://github.com/rpgjs/starter",
          revision: "9156f8af780cf9cfcf00c04d49561c81462d650a",
          sources: [
            {
              file: "grass.png",
              url: "https://raw.githubusercontent.com/rpgjs/starter/9156f8af780cf9cfcf00c04d49561c81462d650a/src/tiled/%5BA%5DGrass_pipo.png",
              sha256: createHash("sha256")
                .update(await readFile(source))
                .digest("hex"),
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  }
  await ctl("close");
  await ctl("activate", { path: outputPath });
  await ctl("close");
}
