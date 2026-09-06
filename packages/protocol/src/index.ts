import { z } from "zod";
import { gridSchema, wangDefinitionSchema } from "./terrain";
export const VERSION = 1;
export const MAX_CELLS = 16384;
const integer = z.number().int().min(-1000000).max(1000000);
export const rectSchema = z
  .object({
    x: integer,
    y: integer,
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
  })
  .strict()
  .refine((r) => r.width * r.height <= MAX_CELLS, "Region exceeds 16384 cells");
export const tileSchema = z
  .object({
    tilesetId: z.string().min(1),
    tileId: z.number().int().nonnegative(),
    flags: z.number().int().min(0).max(15).default(0),
  })
  .strict();
export const propertySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), value: z.string() }),
  z.object({ type: z.literal("bool"), value: z.boolean() }),
  z.object({ type: z.literal("int"), value: z.number().int() }),
  z.object({ type: z.literal("float"), value: z.number().finite() }),
  z.object({
    type: z.literal("color"),
    value: z.string().regex(/^#(?:[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/),
  }),
  z.object({ type: z.literal("file"), value: z.string() }),
  z.object({
    type: z.literal("object"),
    value: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("remove") }),
]);
const properties = z.record(propertySchema);
export const objectSchema = z
  .object({
    name: z.string().default(""),
    className: z.string().default(""),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative().default(0),
    height: z.number().nonnegative().default(0),
    rotation: z.number().finite().default(0),
    shape: z
      .enum([
        "rectangle",
        "ellipse",
        "point",
        "polygon",
        "polyline",
        "text",
        "tile",
      ])
      .default("rectangle"),
    points: z
      .array(
        z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
      )
      .min(2)
      .max(2048)
      .optional(),
    text: z.string().optional(),
    tile: tileSchema.optional(),
    properties: properties.default({}),
  })
  .strict()
  .superRefine((o, c) => {
    if (
      ["polygon", "polyline"].includes(o.shape) &&
      (!o.points || o.points.length < (o.shape === "polygon" ? 3 : 2))
    )
      c.addIssue({
        code: "custom",
        message: "Polygon/polyline requires points",
      });
    if (o.shape === "tile" && !o.tile)
      c.addIssue({ code: "custom", message: "Tile object requires tile" });
  });
const layerPatch = z
  .object({
    name: z.string().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    locked: z.boolean().optional(),
    offset: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .optional(),
    className: z.string().optional(),
  })
  .strict();
export const operationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set_tiles"),
      layerId: z.number().int(),
      cells: z
        .array(
          z
            .object({ x: integer, y: integer, tile: tileSchema.nullable() })
            .strict(),
        )
        .min(1)
        .max(MAX_CELLS),
    })
    .strict(),
  z
    .object({
      op: z.literal("fill_region"),
      layerId: z.number().int(),
      region: rectSchema,
      tile: tileSchema.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("replace_tiles"),
      layerId: z.number().int(),
      region: rectSchema,
      from: tileSchema.nullable(),
      to: tileSchema.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal("create_layer"),
      name: z.string().min(1),
      kind: z.enum(["tile", "object", "group"]),
      parentId: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_layer"),
      layerId: z.number().int(),
      patch: layerPatch,
    })
    .strict(),
  z
    .object({
      op: z.literal("create_objects"),
      layerId: z.number().int(),
      objects: z.array(objectSchema).min(1).max(1024),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_objects"),
      objects: z
        .array(z.object({ id: z.number().int(), value: objectSchema }).strict())
        .min(1)
        .max(1024),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_properties"),
      target: z.enum(["document", "layer", "object", "tile"]),
      id: z.number().int().optional(),
      properties,
    })
    .strict(),
  z
    .object({
      op: z.literal("set_tile_collisions"),
      tileId: z.number().int().nonnegative(),
      objects: z.array(objectSchema).max(1024),
    })
    .strict(),
]);
const target = { sessionId: z.string().min(1), documentId: z.string().min(1) };
const pagination = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(256).default(100),
};
const mutation = {
  ...target,
  requestId: z.string().min(8).max(128),
  expectedRevision: z.string().min(1),
  label: z.string().max(200).default("AI edit"),
};
export const toolSchemas = {
  create_map: z
    .object({
      sessionId: z.string().min(1),
      requestId: z.string().min(8).max(128),
      outputPath: z.string().min(1),
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
      tileWidth: z.number().int().min(1).max(4096),
      tileHeight: z.number().int().min(1).max(4096),
      orientation: z
        .enum(["orthogonal", "isometric", "staggered", "hexagonal"])
        .default("orthogonal"),
      infinite: z.boolean().default(false),
      staggerAxis: z.enum(["x", "y"]).default("y"),
      staggerIndex: z.enum(["odd", "even"]).default("odd"),
      hexSideLength: z.number().int().min(0).max(4096).default(0),
      layers: z
        .array(z.string().min(1).max(128))
        .min(1)
        .max(32)
        .default(["Ground"]),
    })
    .strict(),
  open_map: z
    .object({
      sessionId: z.string().min(1),
      requestId: z.string().min(8).max(128),
      path: z.string().min(1),
    })
    .strict(),
  save_map: z
    .object({ ...mutation, outputPath: z.string().min(1).optional() })
    .strict(),
  inspect_tileset_image: z
    .object({
      source: z.string().min(1),
      sessionId: z.string().optional(),
      documentId: z.string().optional(),
      grid: gridSchema.optional(),
    })
    .strict(),
  create_tileset_from_image: z
    .object({
      sessionId: z.string().min(1),
      requestId: z.string().min(8).max(128),
      source: z.string().min(1),
      outputPath: z.string().min(1),
      name: z.string().min(1).max(128),
      grid: gridSchema,
    })
    .strict(),
  open_tileset: z
    .object({
      sessionId: z.string().min(1),
      requestId: z.string().min(8).max(128),
      path: z.string().min(1),
    })
    .strict(),
  attach_tileset: z
    .object({ ...mutation, tilesetDocumentId: z.string().min(1) })
    .strict(),
  list_wang_sets: z
    .object({ ...target, tilesetId: z.string().optional() })
    .strict(),
  create_wang_set: z
    .object({
      ...mutation,
      definition: wangDefinitionSchema.optional(),
      profile: z.enum(["pipoya-grass-48"]).optional(),
    })
    .strict(),
  update_wang_set: z
    .object({
      ...mutation,
      wangSetId: z.string().min(1),
      definition: wangDefinitionSchema,
    })
    .strict(),
  save_tileset: z.object(mutation).strict(),
  paint_terrain: z
    .object({
      ...mutation,
      layerId: z.number().int(),
      tilesetId: z.string().min(1),
      wangSetId: z.string().min(1),
      colorId: z.number().int().min(1).max(255),
      region: rectSchema,
      cells: z
        .array(z.object({ x: integer, y: integer }).strict())
        .min(1)
        .max(MAX_CELLS)
        .optional(),
    })
    .strict(),
  get_editor_state: z.object({}).strict(),
  get_map_info: z.object(target).strict(),
  list_layers: z.object({ ...target, ...pagination }).strict(),
  get_selection: z.object(target).strict(),
  read_region: z
    .object({
      ...target,
      layerId: z.number().int(),
      region: rectSchema,
      ...pagination,
    })
    .strict(),
  list_tilesets: z.object({ ...target, ...pagination }).strict(),
  get_objects: z
    .object({ ...target, layerId: z.number().int().optional(), ...pagination })
    .strict(),
  get_tileset_images: z
    .object({
      ...target,
      tilesetId: z.string(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(64).default(32),
    })
    .strict(),
  get_region_image: z.object({ ...target, region: rectSchema }).strict(),
  apply_operations: z
    .object({
      ...mutation,
      operations: z.array(operationSchema).min(1).max(256),
    })
    .strict(),
  apply_structure: z
    .object({
      ...mutation,
      origin: z.object({ x: integer, y: integer }).strict(),
      region: rectSchema,
      operations: z.array(operationSchema).min(1).max(256),
    })
    .strict(),
  get_request_status: z
    .object({ sessionId: z.string(), requestId: z.string() })
    .strict(),
  ...Object.fromEntries(
    [
      "set_tiles",
      "fill_region",
      "replace_tiles",
      "create_layer",
      "update_layer",
      "create_objects",
      "update_objects",
      "set_properties",
      "set_tile_collisions",
    ].map((name) => [
      name,
      z.object({ ...mutation, operation: operationSchema }).strict(),
    ]),
  ),
} as Record<string, z.ZodObject<any>>;
export type Operation = z.infer<typeof operationSchema>;
export type TileRef = z.infer<typeof tileSchema>;
export type Rect = z.infer<typeof rectSchema>;
export type ObjectSpec = z.infer<typeof objectSchema>;
export type Property = z.infer<typeof propertySchema>;
export const envelopeSchema = z
  .object({
    version: z.literal(VERSION),
    id: z.string(),
    method: z.string(),
    params: z.record(z.unknown()),
  })
  .strict();
export interface RpcResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function contains(r: Rect, x: number, y: number) {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}
export function sameTile(a: TileRef | null, b: TileRef | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stable((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
