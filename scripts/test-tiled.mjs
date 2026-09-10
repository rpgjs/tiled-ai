import {
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  open,
} from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const app = process.env.TILED_APPIMAGE || "tiled";
const probe = spawnSync(app, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0)
  throw Error(
    "Tiled executable not found or could not start. Set TILED_APPIMAGE to its executable path, or add tiled to PATH.",
  );
const testId = randomUUID();
const root = resolve(".tmp/tiled-test-" + testId);
await mkdir(root, { recursive: true });
await sharp(resolve("examples/rpgjs/base.png"))
  .extract({ left: 0, top: 0, width: 32, height: 32 })
  .png()
  .toFile(join(root, "tile.png"));
// Tiled reports map paths with forward slashes and tileset paths with the
// platform separator, so identity checks must not depend on either.
const samePath = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.split("\\").join("/") === b.split("\\").join("/");
const collectionPath = join(root, "collection.tsx");
await writeFile(
  collectionPath,
  '<tileset version="1.10" tiledversion="1.12.2" name="Collection" tilewidth="32" tileheight="32" tilecount="2" columns="0"><tile id="2"><image width="32" height="32" source="tile.png"/></tile><tile id="10"><image width="32" height="32" source="tile.png"/></tile></tileset>',
);
// Tiled resolves its extension directory through the platform's application
// data location. XDG_CONFIG_HOME redirects it on Linux, but Windows resolves
// that location through the shell and ignores the variable, so the isolated
// directory is never read there. On Windows the test therefore installs
// copies named after this run into the real directory and removes exactly
// those files again, whatever else happens. An existing installation keeps
// its own secret because the extension derives its configuration file name
// from its own file name.
const shared = process.platform === "win32";
if (shared && !process.env.LOCALAPPDATA)
  throw Error(
    "LOCALAPPDATA is not set, so the Tiled extension directory cannot be located",
  );
const ext = shared
  ? join(process.env.LOCALAPPDATA, "Tiled", "extensions")
  : join(root, "config/tiled/extensions");
const installed = [
  join(ext, `tiled-ai-test-${testId}.mjs`),
  join(ext, `tiled-ai-test-${testId}.config.json`),
  join(ext, `tiled-ai-test-control-${testId}.mjs`),
];
const createdFiles = new Set();
async function writeExclusive(path, data) {
  const file = await open(path, "wx");
  createdFiles.add(path);
  try {
    await file.writeFile(data);
  } finally {
    await file.close();
  }
}
// Tiled loads every extension in the shared directory, and it hot-loads new
// files while running. Two concurrent runs, an already open editor or a
// regular installation would all pick up this run's copies: the same action
// identifiers get registered twice, `tiled.trigger` reaches an unpredictable
// copy, and the control extension could act on an unrelated document. Hold a
// lock for the whole run and refuse those situations with a specific message
// rather than moving anyone's files.
const lockPath = shared
  ? join(process.env.LOCALAPPDATA, "Tiled", "tiled-ai-test.lock")
  : null;
async function acquireLock() {
  await mkdir(dirname(lockPath), { recursive: true });
  let file;
  try {
    file = await open(lockPath, "wx");
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // Never recover automatically: two runs could both judge the owner dead,
    // and one would then delete the other's fresh lock. Leave it to a person,
    // as with leftover extension files.
    const owner = (await readFile(lockPath, "utf8").catch(() => "")).trim();
    throw Error(
      `${lockPath} exists, written by pid ${owner || "unknown"}. If no test run is active, delete it and rerun.`,
    );
  }
  try {
    await file.writeFile(String(process.pid));
  } finally {
    await file.close();
  }
}
function refuseRunningTiled() {
  const image = basename(app).toLowerCase().endsWith(".exe")
    ? basename(app)
    : basename(app) + ".exe";
  const list = spawnSync(
    "tasklist",
    ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"],
    { encoding: "utf8" },
  );
  // Fail closed: an unavailable process check must not read as "not running".
  if (list.error || list.status !== 0)
    throw Error(
      "Could not check for a running Tiled with tasklist: " +
        (
          list.error?.message ?? `exit ${list.status} ${list.stderr ?? ""}`
        ).trim(),
    );
  if (list.stdout.toLowerCase().includes(image.toLowerCase()))
    throw Error(
      `${image} is already running and would load this test's extension copies as soon as they are written. Close Tiled and rerun.`,
    );
}
async function refuseForeignExtensions() {
  const names = await readdir(ext);
  if (names.some((n) => /^tiled-ai\.m?js$/.test(n)))
    throw Error(
      "An installed tiled-ai extension in " +
        ext +
        " would collide with this test. Move tiled-ai.mjs and tiled-ai.config.json aside, run the test, then restore them.",
    );
  const stale = names.filter((n) => /^tiled-ai-test-/.test(n));
  if (stale.length)
    throw Error(
      "Files from an earlier test run remain in " +
        ext +
        ": " +
        stale.join(", ") +
        ". Delete them and rerun.",
    );
}
const token = randomBytes(32).toString("hex");
const portProbe = createServer();
await new Promise((r) => portProbe.listen(0, "127.0.0.1", r));
const port = portProbe.address().port;
await new Promise((r) => portProbe.close(r));
const config = join(root, "bridge.json");
await writeFile(config, JSON.stringify({ port, token }));
const width = 32,
  height = 24,
  base = resolve("examples/rpgjs/base.tsx");
const data = Array(width * height)
  .fill(1)
  .join(",");
const mapPath = join(root, "map.tmx");
await writeFile(
  mapPath,
  `<?xml version="1.0"?><map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="${width}" height="${height}" tilewidth="32" tileheight="32" infinite="0" nextlayerid="5" nextobjectid="1"><tileset firstgid="1" source="${base}"/><layer id="1" name="Ground" width="${width}" height="${height}"><data encoding="csv">${data}</data></layer><layer id="2" name="House" width="${width}" height="${height}"><data encoding="csv">${Array(
    width * height,
  )
    .fill(0)
    .join(
      ",",
    )}</data></layer><layer id="3" name="Decoration" width="${width}" height="${height}"><data encoding="csv">${Array(
    width * height,
  )
    .fill(0)
    .join(
      ",",
    )}</data></layer><objectgroup id="4" name="Collisions" visible="0"/></map>`,
);
let poll,
  queue = [],
  controlId = 0;
const waits = new Map();
const control = createServer(async (req, res) => {
  if (req.headers.authorization !== token) {
    res.writeHead(403).end();
    return;
  }
  if (req.url === "/next") {
    poll = res;
    flush();
    return;
  }
  let text = "";
  for await (const c of req) text += c;
  const value = JSON.parse(text);
  const w = waits.get(value.id);
  waits.delete(value.id);
  if (w) {
    clearTimeout(w.timer);
    value.error ? w.reject(Error(value.error)) : w.resolve(value.result);
  }
  res.end("{}");
});
function flush() {
  if (poll && queue.length) {
    poll.end(JSON.stringify(queue.shift()));
    poll = null;
  }
}
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const controlPort = control.address().port;
const controlSource = `
function http(path,body,done){const r=new XMLHttpRequest();r.open('POST','http://127.0.0.1:${controlPort}'+path,true);r.setRequestHeader('Authorization','${token}');r.onreadystatechange=()=>{if(r.readyState===4&&r.status===200)done(JSON.parse(r.responseText));};r.send(JSON.stringify(body));}
function run(c){const m=tiled.activeAsset;switch(c.op){
case 'selection':return {selection:m.selectedArea.get().rects,layer:m.selectedLayers.map(l=>l.id)};
case 'state':return {open:tiled.openAssets.length,active:m?.fileName};
case 'select':m.selectedLayers=[m.layerAt(1)];m.selectedArea.set(Qt.rect(c.x,c.y,c.width,c.height));if(c.hole)m.selectedArea.subtract(Qt.rect(c.hole.x,c.hole.y,c.hole.width,c.hole.height));return {rects:m.selectedArea.get().rects,bounds:m.selectedArea.boundingRect,file:m.fileName};
case 'undo':m.undo();return true;
case 'redo':m.redo();return true;
case 'cell':return {id:m.layerAt(c.layer).tileAt(c.x,c.y)?.id??null,flags:m.layerAt(c.layer).flagsAt(c.x,c.y),modified:m.modified};
case 'setcell':{const layer=m.layerAt(c.layer);const e=layer.edit();e.setTile(c.x,c.y,m.tilesets[0].tile(c.tileId),0);m.macro('Simulated user edit',()=>e.apply());return {tile:m.layerAt(c.layer).tileAt(c.x,c.y)?.id};}
case 'open':tiled.open(c.path);return true;
case 'activate':tiled.activeAsset=tiled.openAssets.find(a=>FileInfo.cleanPath(a.fileName)===FileInfo.cleanPath(c.path));return true;
case 'close':tiled.close(m);return true;
case 'lock':m.layerAt(c.layer).locked=c.value;return true;
case 'save':tiled.mapFormat('tmx').write(m,c.path);return true;
case 'image':return m.toImage().save(c.path);
case 'orientation':m.selectedArea.set(Qt.rect(0,0,0,0));m.orientation=c.value;m.infinite=c.infinite;m.staggerAxis=c.axis??TileMap.StaggerY;m.staggerIndex=c.index??TileMap.StaggerOdd;m.hexSideLength=16;return true;
case 'property':return {value:m.property(c.name),modified:m.modified};
case 'collision':return m.tile(c.tileId).objectGroup?.objectCount??0;
case 'disconnect':tiled.trigger('TiledAIDisconnect');return true;
case 'connect':tiled.trigger('TiledAIConnect');return true;
}throw Error('Unknown test control');}
function next(){http('/next',{},c=>{let result;try{result={id:c.id,result:run(c)};}catch(e){result={id:c.id,error:String(e)};}http('/result',result,next);});}
// Only the editor that opened this run's map may take control commands.
function armed(){return tiled.openAssets.some(a=>FileInfo.cleanPath(a.fileName)===FileInfo.cleanPath(${JSON.stringify(mapPath)}));}
var started=false;function start(){if(!started&&armed()){started=true;next();}}
start();tiled.assetOpened.connect(start);
`;
function ctl(op, args = {}) {
  const id = ++controlId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waits.delete(id);
      reject(Error("Control timeout: " + op));
    }, 15000);
    waits.set(id, { resolve, reject, timer });
    queue.push({ id, op, ...args });
    flush();
  });
}
const client = new Client({ name: "tiled-ai-integration", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/cli.mjs"), "serve", "--config", config],
  stderr: "pipe",
});
let tiledProcess,
  logs = "";
const checks = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw Error(r.content[0].text);
  return r;
}
async function json(name, args = {}) {
  return JSON.parse((await call(name, args)).content[0].text);
}
async function rejected(name, args, code) {
  const r = await client.callTool({ name, arguments: args });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).code, code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (shared) await acquireLock();
try {
  if (shared) refuseRunningTiled();
  await mkdir(ext, { recursive: true });
  if (shared) await refuseForeignExtensions();
  await writeExclusive(installed[0], await readFile("dist/tiled-ai.mjs"));
  await writeExclusive(
    installed[1],
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      token,
      autoConnect: true,
    }),
  );
  await writeExclusive(installed[2], controlSource);
  await client.connect(transport);
  transport.stderr?.on("data", (c) => {
    logs += c;
  });
  tiledProcess = spawn(app, ["--new-instance", "--disable-opengl", mapPath], {
    env: {
      ...process.env,
      QT_LOGGING_RULES: "qt.qml.usedbeforedeclared=false",
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tiledProcess.once("exit", (code, signal) => {
    logs += "Tiled exited: " + code + " " + signal + "\n";
  });
  tiledProcess.stdout.on("data", (c) => (logs += c));
  tiledProcess.stderr.on("data", (c) => (logs += c));
  // Take the editor that opened this run's map, not the first to connect.
  const opened = (s) => s.documents.some((d) => samePath(d.fileName, mapPath));
  let session;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    session = (await json("get_editor_state")).sessions.find(opened);
    if (session) break;
  }
  assert.ok(session, "Tiled did not connect: " + logs);
  await sleep(600);
  const target = {
    sessionId: session.sessionId,
    documentId: session.documents.find((d) => samePath(d.fileName, mapPath)).id,
  };
  const secondClient = new Client({
    name: "tiled-ai-second-task",
    version: "1",
  });
  try {
    await secondClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/cli.mjs"), "serve", "--config", config],
        stderr: "ignore",
      }),
    );
    assert.ok(
      (await secondClient.listTools()).tools.some(
        (t) => t.name === "paint_terrain",
      ),
    );
    const response = await secondClient.callTool({
      name: "get_editor_state",
      arguments: {},
    });
    assert.equal(
      JSON.parse(response.content[0].text).sessions[0].sessionId,
      target.sessionId,
    );
  } finally {
    await secondClient.close();
  }
  assert.equal(
    (await json("get_editor_state")).sessions[0].sessionId,
    target.sessionId,
  );
  checks.push(
    "Two MCP clients inspect the same live Tiled session; closing one leaves the other connected",
  );
  await ctl("disconnect");
  await ctl("connect");
  await sleep(100);
  assert.equal(
    (await json("get_editor_state")).sessions[0].sessionId,
    target.sessionId,
  );
  checks.push("Explicit extension disconnect and same-session reconnect");
  const sets = await json("list_tilesets", target),
    tile = { tilesetId: sets.items[0].id, tileId: 1, flags: 0 };
  const revision = async (t = target) =>
    (await json("get_map_info", t)).revision;
  const mutate = async (operations, t = target) =>
    json("apply_operations", {
      ...t,
      requestId: randomUUID(),
      expectedRevision: await revision(t),
      operations,
    });
  await ctl("select", { x: 4, y: 4, width: 12, height: 14 });
  assert.equal((await json("get_selection", target)).rects[0].width, 12);
  checks.push("Asynchronous HTTP, map and selection inspection");
  const image = await call("get_tileset_images", {
    ...target,
    tilesetId: tile.tilesetId,
    offset: 0,
    limit: 32,
  });
  assert.ok(image.content.some((c) => c.type === "image"));
  checks.push("MCP labeled atlas images");
  const request = {
    ...target,
    requestId: randomUUID(),
    expectedRevision: await revision(),
    operations: [
      { op: "set_tiles", layerId: 2, cells: [{ x: 4, y: 4, tile }] },
    ],
  };
  await json("apply_operations", request);
  assert.equal((await ctl("cell", { layer: 1, x: 4, y: 4 })).id, 1);
  await json("apply_operations", request);
  await ctl("undo");
  assert.equal((await ctl("cell", { layer: 1, x: 4, y: 4 })).id, null);
  await ctl("redo");
  assert.equal((await ctl("cell", { layer: 1, x: 4, y: 4 })).id, 1);
  checks.push("Immediate unsaved mutation, deduplication, single Undo/Redo");
  assert.equal(
    (
      await json("get_request_status", {
        sessionId: target.sessionId,
        requestId: request.requestId,
      })
    ).state,
    "completed",
  );
  const old = await revision();
  await ctl("setcell", { layer: 0, x: 5, y: 5, tileId: 2 });
  await rejected(
    "apply_operations",
    { ...request, requestId: randomUUID(), expectedRevision: old },
    "CONFLICT",
  );
  checks.push("User edit conflict");
  await ctl("lock", { layer: 1, value: true });
  await rejected(
    "apply_operations",
    { ...request, requestId: randomUUID(), expectedRevision: await revision() },
    "LAYER_LOCKED",
  );
  await ctl("lock", { layer: 1, value: false });
  await rejected(
    "apply_operations",
    {
      ...target,
      requestId: randomUUID(),
      expectedRevision: await revision(),
      operations: [
        { op: "set_tiles", layerId: 2, cells: [{ x: 5, y: 5, tile }] },
        { op: "set_tiles", layerId: 999, cells: [{ x: 5, y: 5, tile }] },
      ],
    },
    "LAYER_NOT_FOUND",
  );
  assert.equal((await ctl("cell", { layer: 1, x: 5, y: 5 })).id, null);
  checks.push("Locks and whole-batch prevalidation");
  await ctl("select", {
    x: 4,
    y: 4,
    width: 12,
    height: 14,
    hole: { x: 6, y: 6, width: 1, height: 1 },
  });
  await rejected(
    "apply_structure",
    {
      ...target,
      requestId: randomUUID(),
      expectedRevision: await revision(),
      origin: { x: 4, y: 4 },
      region: { x: 4, y: 4, width: 12, height: 14 },
      operations: [
        { op: "set_tiles", layerId: 2, cells: [{ x: 2, y: 2, tile }] },
      ],
    },
    "OUTSIDE_SELECTION",
  );
  checks.push("Disjoint selection mask");
  await ctl("select", { x: 4, y: 4, width: 12, height: 14 });
  for (const value of [1, 2, 3, 4])
    for (const infinite of [false, true]) {
      await ctl("orientation", { value, infinite });
      await mutate([
        {
          op: "set_tiles",
          layerId: 2,
          cells: [
            {
              x: infinite ? -2 : 5,
              y: infinite ? -2 : 5,
              tile: { ...tile, flags: value === 4 ? 15 : 3 },
            },
          ],
        },
      ]);
      const c = await ctl("cell", {
        layer: 1,
        x: infinite ? -2 : 5,
        y: infinite ? -2 : 5,
      });
      assert.equal(c.flags, value === 4 ? 15 : 3);
      const img = await call("get_region_image", {
        ...target,
        region: {
          x: infinite ? -2 : 0,
          y: infinite ? -2 : 0,
          width: 8,
          height: 8,
        },
      });
      assert.ok(img.content.some((c) => c.type === "image"));
    }
  checks.push(
    "Four orientations, finite/infinite maps, negative cells, flags and Tiled rendering",
  );
  await ctl("orientation", { value: 1, infinite: false });
  await mutate([
    {
      op: "create_objects",
      layerId: 4,
      objects: [{ name: "wall", x: 128, y: 128, width: 32, height: 32 }],
    },
    {
      op: "set_properties",
      target: "document",
      properties: {
        difficulty: { type: "float", value: 1 },
        tint: { type: "color", value: "#ff0022" },
      },
    },
  ]);
  assert.equal((await json("get_objects", { ...target, layerId: 4 })).total, 1);
  assert.equal((await ctl("property", { name: "difficulty" })).value, 1);
  await ctl("undo");
  assert.equal((await json("get_objects", { ...target, layerId: 4 })).total, 0);
  checks.push("Objects, typed writes and grouped Undo");
  await mutate([
    {
      op: "fill_region",
      layerId: 2,
      region: { x: 12, y: 12, width: 2, height: 2 },
      tile,
    },
  ]);
  await json("replace_tiles", {
    ...target,
    requestId: randomUUID(),
    expectedRevision: await revision(),
    operation: {
      op: "replace_tiles",
      layerId: 2,
      region: { x: 12, y: 12, width: 2, height: 2 },
      from: tile,
      to: { ...tile, tileId: 2 },
    },
  });
  assert.equal((await ctl("cell", { layer: 1, x: 13, y: 13 })).id, 2);
  const objects = await mutate([
    {
      op: "create_objects",
      layerId: 4,
      objects: [
        {
          name: "polygon",
          x: 10,
          y: 20,
          shape: "polygon",
          points: [
            { x: 0, y: 0 },
            { x: 32, y: 0 },
            { x: 16, y: 32 },
          ],
        },
      ],
    },
  ]);
  const objectId = objects.results[0].objectIds[0];
  await mutate([
    {
      op: "update_objects",
      objects: [
        {
          id: objectId,
          value: { name: "updated", x: 20, y: 30, width: 10, height: 12 },
        },
      ],
    },
    {
      op: "set_properties",
      target: "document",
      properties: {
        id: { type: "int", value: 9 },
        ratio: { type: "float", value: 1 },
        asset: { type: "file", value: base },
        ref: { type: "object", value: objectId },
      },
    },
  ]);
  const oi = (await json("get_objects", { ...target, layerId: 4 })).items.find(
    (o) => o.id === objectId,
  );
  assert.equal(oi.name, "updated");
  assert.equal(oi.shape, "rectangle");
  const properties = (await json("get_map_info", target)).properties;
  assert.equal(properties.id, 9);
  assert.equal(properties.ref.value, objectId);
  assert.equal(properties.asset.type, "file");
  const roundtrip = join(root, "properties.tmx");
  await ctl("save", { path: roundtrip });
  assert.match(await readFile(roundtrip, "utf8"), /name="ratio" type="float"/);
  checks.push(
    "Fill, replace, object update, polygons and typed property serialization",
  );

  // External tileset mutations must operate on that open document and undo independently.
  await ctl("open", { path: base });
  const s2 = (await json("get_editor_state")).sessions[0];
  const tsTarget = {
    sessionId: target.sessionId,
    documentId: s2.documents.find((d) => d.kind === "tileset").id,
  };
  const before = await ctl("collision", { tileId: 1 });
  await mutate(
    [
      {
        op: "set_tile_collisions",
        tileId: 1,
        objects: [{ x: 0, y: 0, width: 32, height: 32 }],
      },
    ],
    tsTarget,
  );
  assert.equal(await ctl("collision", { tileId: 1 }), 1);
  await ctl("undo");
  assert.equal(await ctl("collision", { tileId: 1 }), before);
  checks.push("External tileset collision Undo");
  await ctl("close");
  await rejected("get_map_info", tsTarget, "DOCUMENT_CLOSED");
  await ctl("activate", { path: mapPath });
  checks.push("Closed document rejected; active tab does not redirect target");
  // Nested groups, sparse collection IDs and explicit targeting across tabs.
  const created = await mutate([
    { op: "create_layer", kind: "group", name: "Nested" },
  ]);
  const groupId = created.results[0].layerId;
  const child = await mutate([
    {
      op: "create_layer",
      kind: "tile",
      name: "Nested tiles",
      parentId: groupId,
    },
  ]);
  const childId = child.results[0].layerId;
  assert.equal(
    (await json("list_layers", target)).items.find((l) => l.id === childId)
      .parentId,
    groupId,
  );
  await mutate([
    { op: "update_layer", layerId: groupId, patch: { locked: true } },
  ]);
  await rejected(
    "apply_operations",
    {
      ...target,
      requestId: randomUUID(),
      expectedRevision: await revision(),
      operations: [
        {
          op: "fill_region",
          layerId: childId,
          region: { x: 1, y: 1, width: 1, height: 1 },
          tile,
        },
      ],
    },
    "LAYER_LOCKED",
  );
  await ctl("open", { path: collectionPath });
  const cs = (await json("get_editor_state")).sessions[0],
    ct = {
      sessionId: target.sessionId,
      documentId: cs.documents.find((d) => samePath(d.fileName, collectionPath))
        .id,
    };
  const cset = (await json("list_tilesets", ct)).items[0];
  const cimages = await call("get_tileset_images", {
    ...ct,
    tilesetId: cset.id,
    limit: 2,
  });
  assert.deepEqual(
    JSON.parse(cimages.content[0].text).map((t) => t.tileId),
    [2, 10],
  );
  assert.equal((await json("get_map_info", target)).width, 32);
  await ctl("close");
  await ctl("activate", { path: mapPath });
  checks.push(
    "Nested group locks, sparse image collections and explicit targeting across active tabs",
  );
  if (process.argv.includes("--terrain")) {
    const { testTerrain } = await import("./test-terrain.mjs");
    await testTerrain({
      json,
      call,
      rejected,
      ctl,
      root,
      checks,
      saveDemo: process.argv.includes("--demo"),
    });
    await ctl("activate", { path: mapPath });
  }
  if (process.argv.includes("--demo")) {
    const { houseOperations } = await import("./house.mjs");
    // Reset the fixture to produce a clean, repeatable deliverable.
    await ctl("close");
    await ctl("open", { path: mapPath });
    const fresh = (await json("get_editor_state")).sessions[0];
    const t = {
      sessionId: fresh.sessionId,
      documentId: fresh.documents.find((d) => samePath(d.fileName, mapPath)).id,
    };
    await ctl("select", { x: 4, y: 4, width: 12, height: 14 });
    const set = (await json("list_tilesets", t)).items[0];
    await ctl("save", { path: resolve("examples/rpgjs/start.tmx") });
    await json("apply_structure", {
      ...t,
      requestId: randomUUID(),
      expectedRevision: await revision(t),
      label: "Build RPGJS house",
      origin: { x: 4, y: 4 },
      region: { x: 4, y: 4, width: 12, height: 14 },
      operations: houseOperations(set.id),
    });
    const preview = await call("get_region_image", {
      ...t,
      region: { x: 4, y: 4, width: 12, height: 14 },
    });
    await writeFile(
      resolve("examples/rpgjs/house-region.png"),
      Buffer.from(
        preview.content.find((c) => c.type === "image").data,
        "base64",
      ),
    );
    await ctl("save", { path: resolve("examples/rpgjs/house.tmx") });
    await ctl("image", { path: resolve("examples/rpgjs/house.png") });
    await ctl("undo");
    assert.equal((await ctl("cell", { layer: 1, x: 6, y: 6 })).id, null);
    await ctl("redo");
    checks.push(
      "RPGJS house generated through MCP, saved and Undo/Redo verified",
    );
  }
  console.log(JSON.stringify({ tiled: "1.12.2", checks }, null, 2));
  await writeFile(
    resolve("examples/rpgjs/validation.json"),
    JSON.stringify({ tiled: "1.12.2", checks }, null, 2) + "\n",
  );
} catch (e) {
  console.error(logs);
  console.error(e);
  throw e;
} finally {
  try {
    if (
      tiledProcess &&
      tiledProcess.exitCode === null &&
      tiledProcess.signalCode === null
    ) {
      const exited = new Promise((r) => tiledProcess.once("exit", r));
      tiledProcess.kill("SIGTERM");
      const force = setTimeout(() => tiledProcess.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(force);
    }
    await client.close();
    spawnSync(
      process.execPath,
      [resolve("dist/cli.mjs"), "bridge-stop", "--config", config],
      { stdio: "ignore" },
    );
    control.closeAllConnections();
    await new Promise((r) => control.close(r));
    for (const w of waits.values()) {
      clearTimeout(w.timer);
      w.reject(Error("Test ended"));
    }
  } finally {
    // Remove only what this run created, even if the teardown above failed.
    for (const path of createdFiles) await rm(path, { force: true });
    if (lockPath) await rm(lockPath, { force: true });
    await writeFile(join(root, "run.log"), logs);
  }
}
