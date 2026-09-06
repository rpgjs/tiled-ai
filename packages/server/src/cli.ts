import { readFile, writeFile, mkdir, copyFile, chmod } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import sharp, { type OverlayOptions } from "sharp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge";
import { SharedBridge } from "./shared";
import { AssetTools } from "./assets";
import { toolSchemas, RpcError } from "../../protocol/src/index";
const args = process.argv.slice(2),
  command = args[0] ?? "serve";
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const configPath = resolve(
  option("--config") ?? join(homedir(), ".config/tiled-ai/config.json"),
);
interface Config {
  port: number;
  token: string;
}
async function config(): Promise<Config> {
  const c = JSON.parse(await readFile(configPath, "utf8"));
  if (
    !Number.isInteger(c.port) ||
    c.port < 1024 ||
    c.port > 65535 ||
    typeof c.token !== "string" ||
    c.token.length < 32
  )
    throw Error("Invalid configuration");
  return c;
}
async function init() {
  await mkdir(dirname(configPath), { recursive: true });
  try {
    await config();
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    await writeFile(
      configPath,
      JSON.stringify(
        { port: 32123, token: randomBytes(32).toString("hex") },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  }
  await chmod(configPath, 0o600);
  return config();
}
async function imageContent(result: any): Promise<any[]> {
  if (Array.isArray(result) && result.length && result[0].png) {
    const cols = 8,
      cell = 96,
      rows = Math.ceil(result.length / cols),
      width = cols * cell,
      height = rows * cell;
    const composite: OverlayOptions[] = [];
    for (let i = 0; i < result.length; i++) {
      const t = result[i],
        data = await sharp(Buffer.from(t.png, "base64"))
          .resize(88, 68, {
            fit: "inside",
            kernel: "nearest",
            withoutEnlargement: false,
          })
          .png()
          .toBuffer();
      const meta = await sharp(data).metadata();
      const x = (i % cols) * cell,
        y = Math.floor(i / cols) * cell;
      composite.push({
        input: data,
        left: x + Math.floor((cell - meta.width!) / 2),
        top: y,
      });
      composite.push({
        input: Buffer.from(
          `<svg width="96" height="24"><text x="48" y="17" text-anchor="middle" fill="white" font-family="sans-serif" font-size="14">${Number(t.tileId)}</text></svg>`,
        ),
        left: x,
        top: y + 70,
      });
    }
    const png = await sharp({
      create: { width, height, channels: 4, background: "#30343b" },
    })
      .composite(composite)
      .png()
      .toBuffer();
    return [
      {
        type: "text",
        text: JSON.stringify(result.map(({ png, ...t }: any) => t)),
      },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ];
  }
  if (result?.png) {
    const { png, ...metadata } = result;
    return [
      { type: "text", text: JSON.stringify(metadata) },
      { type: "image", mimeType: "image/png", data: png },
    ];
  }
  return [{ type: "text", text: JSON.stringify(result) }];
}
const descriptions: Record<string, string> = {
  create_map:
    "Create and open a NEW TMX using Tiled. Requires absolute outputPath, map dimensions in cells, tile dimensions in pixels and unique requestId. Optional orientation, infinite and initial tile layer names. Hexagonal maps require hexSideLength. Saves the initial blank file; refuses overwrite.",
  open_map:
    "Open an existing TMX by absolute path. Use to recover a created file after interruption. Requires sessionId and unique requestId.",
  save_map:
    "Explicitly save the targeted map with a fresh revision and unique requestId, preserving Undo. Without outputPath saves its associated TMX. A different outputPath writes a NEW copy without retargeting or closing the live document; refuses overwrite of another file. File writes are not undone. Does not save external tilesets.",

  inspect_tileset_image:
    "Inspect a local absolute image path or HTTPS/GitHub URL. Returns image, dimensions, layout candidates and a destination suggestion when session/document IDs are supplied. Divisibility alone does not establish the layout.",
  create_tileset_from_image:
    "Create a NEW TSX from an image and explicit grid, using Tiled. Requires sessionId, unique requestId and absolute outputPath. Imports the image alongside the TSX, refuses overwrite, opens the new document. File writes are not Undo operations.",
  open_tileset:
    "Open an existing local TSX in Tiled. Useful to recover after a TSX was saved but not opened. Requires an absolute path and unique requestId.",
  attach_tileset:
    "Attach an OPEN tileset document to the targeted map in one Undo step. Requires a fresh map revision. Does not save the map.",
  list_wang_sets:
    "List terrain sets, color names and tile Wang IDs for a tileset document, or an attached tileset identified by tilesetId.",
  create_wang_set:
    "Create a terrain set on an OPEN tileset, with definition OR verified pipoya-grass-48 profile. Definition includes type, color names and eight Wang indices per tile. One Undo, no save.",
  update_wang_set:
    "Replace the complete definition of the identified Wang set, preserving the set identity. Requires a fresh tileset revision. One Undo, no save.",
  save_tileset:
    "Explicitly save an open tileset to its existing file. Requires fresh revision. This disk write is not undone by Tiled Undo.",
  paint_terrain:
    "Paint a terrain on a tile layer within region AND exact selection. Optional cells describes an irregular footprint; otherwise region intersect selection is used. Uses Tiled Wang generation and rejects missing combinations or incompatible boundaries. Orthogonal/isometric square topology only; other orientations return an explicit error. One Undo, no save.",

  get_editor_state:
    "List connected Tiled sessions and open documents, including the active document. Start here.",
  get_map_info:
    "Read map or tileset metadata and obtain an expectedRevision token. Token expires on content or selection changes.",
  list_layers:
    "List layers recursively with IDs, parents, locks, properties, offsets and visibility. Paginated.",
  get_selection:
    "Read exact selection rectangles, selected layers and objects in cell coordinates.",
  read_region:
    "Read bounded tile cells including tileset ID, local tile ID and flags. Paginated row-major; null means empty.",
  list_tilesets:
    "List tilesets attached to a map, or the targeted tileset document. Includes documentId if already open.",
  get_objects:
    "Read objects in native Tiled object coordinates with properties, shapes and layer IDs. Paginated.",
  get_tileset_images:
    "Return up to 64 labeled tile images and metadata for visual tile identification. Offset is index into existing tiles, not tile ID.",
  get_region_image:
    "Render a bounded map region using Tiled, up to 1024px, with objects, image layers and group visibility. Even-cell padding preserves stagger parity.",
  apply_operations:
    "Apply a prevalidated batch to one document in one Undo macro. References resolve before the batch; create layers first in a separate call. Requires fresh revision and unique requestId. No save.",
  apply_structure:
    "Place relative tile cells and native-coordinate objects at a cell origin, confined to absolute region AND exact current selection. Supports tile edits and unrotated geometric objects. One Undo; no save.",
  get_request_status:
    "Inspect queued/dispatched/completed mutation status after timeout. Unknown or dispatched does not mean unapplied.",
  update_objects:
    "Update named objects by ID using a complete geometry value; supplied properties are patched. No save.",
  set_tile_collisions:
    "Replace one tile collision group in an explicitly targeted OPEN TILESET document. A separate Undo from map edits.",
  set_properties:
    "Patch typed properties on document/layer/object/tile. Custom class/enum writes are unsupported; float writes preserve float type.",
};
async function main() {
  if (command === "init") {
    await init();
    console.log("Configuration: " + configPath);
    return;
  }
  if (command === "install") {
    const c = await init();
    const extensions = option("--extensions");
    if (!extensions)
      throw Error(
        "Specify --extensions <Tiled extensions directory>, visible in Tiled Preferences > Plugins",
      );
    const dest = resolve(extensions);
    await mkdir(dest, { recursive: true });
    await copyFile(
      join(dirname(fileURLToPath(import.meta.url)), "tiled-ai.mjs"),
      join(dest, "tiled-ai.mjs"),
    );
    await writeFile(
      join(dest, "tiled-ai.config.json"),
      JSON.stringify(
        {
          url: "http://127.0.0.1:" + c.port,
          token: c.token,
          autoConnect: true,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await chmod(join(dest, "tiled-ai.config.json"), 0o600);
    console.log(
      "Installed extension in " +
        dest +
        "\nRestart Tiled after starting the MCP server, or choose Map > Tiled AI: Connect.",
    );
    return;
  }
  if (command === "doctor") {
    const c = await config();
    console.log(
      JSON.stringify({
        node: process.version,
        config: configPath,
        bridge: "http://127.0.0.1:" + c.port,
        extensionBuild: join(
          dirname(fileURLToPath(import.meta.url)),
          "tiled-ai.mjs",
        ),
      }),
    );
    return;
  }
  const c = await config();
  const shared = new SharedBridge(c.port, c.token);
  if (command === "bridge-start") {
    await shared.ensure(fileURLToPath(import.meta.url), configPath);
    console.log(JSON.stringify({ started: true, ...(await shared.health()) }));
    return;
  }
  if (command === "bridge-stop") {
    await shared.stop();
    console.log("Shared bridge stopped. Reconnect Tiled after restarting.");
    return;
  }
  if (command === "bridge") {
    const bridge = new Bridge(c.token),
      assets = new AssetTools(bridge);
    bridge.clientCall = (method, input) => assets.call(method, input);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      void bridge.close().then(() => process.exit(0));
    };
    bridge.onStop = stop;
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      await bridge.listen(c.port);
    } catch (e: any) {
      if (e.code === "EADDRINUSE") return;
      throw e;
    }
    console.error("Shared Tiled AI bridge listening on 127.0.0.1:" + c.port);
    return;
  }
  if (command !== "serve")
    throw Error(
      "Usage: cli.mjs init|install|doctor|serve|bridge|bridge-start|bridge-stop [--config PATH]",
    );
  await shared.ensure(fileURLToPath(import.meta.url), configPath);
  const server = new McpServer({ name: "tiled-ai", version: "0.1.0" });
  for (const [name, schema] of Object.entries(toolSchemas))
    server.registerTool(
      name,
      {
        description:
          descriptions[name] ??
          `Apply ${name} to the explicit document, with fresh revision and unique requestId. Operation.op must equal the tool name. One Undo, no save.`,
        inputSchema: schema.shape,
      },
      async (input: any) => {
        try {
          return {
            content: await imageContent(await shared.call(name, input)),
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: e instanceof RpcError ? e.code : "INVALID_REQUEST",
                  message: e instanceof Error ? e.message : String(e),
                  details: e instanceof RpcError ? e.details : undefined,
                }),
              },
            ],
          };
        }
      },
    );
  const shutdown = async () => {
    await server.close();
  };
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.stdin.once("end", () => {
    void shutdown();
  });
  await server.connect(new StdioServerTransport());
  console.error(
    "MCP client connected to shared Tiled AI bridge on 127.0.0.1:" + c.port,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
