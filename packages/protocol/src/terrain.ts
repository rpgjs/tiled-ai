import { z } from "zod";
export const gridSchema = z
  .object({
    tileWidth: z.number().int().min(1).max(4096),
    tileHeight: z.number().int().min(1).max(4096),
    margin: z.number().int().min(0).max(4096).default(0),
    spacing: z.number().int().min(0).max(4096).default(0),
  })
  .strict();
export type Grid = z.infer<typeof gridSchema>;
export function validateGrid(width: number, height: number, g: Grid) {
  const w = width - 2 * g.margin + g.spacing,
    h = height - 2 * g.margin + g.spacing,
    dx = g.tileWidth + g.spacing,
    dy = g.tileHeight + g.spacing;
  if (w <= 0 || h <= 0 || w % dx || h % dy)
    throw Error(
      "Image dimensions do not divide exactly into this grid, margin and spacing",
    );
  const columns = w / dx,
    rows = h / dy;
  if (columns * rows > 16384) throw Error("Tileset exceeds 16384 tiles");
  return { columns, rows, tileCount: columns * rows };
}
export const wangDefinitionSchema = z
  .object({
    name: z.string().min(1).max(128),
    type: z.enum(["edge", "corner", "mixed"]),
    colors: z
      .array(z.object({ name: z.string().min(1).max(128) }).strict())
      .min(1)
      .max(255),
    assignments: z
      .array(
        z
          .object({
            tileId: z.number().int().nonnegative(),
            wangId: z.array(z.number().int().min(0).max(255)).length(8),
          })
          .strict(),
      )
      .min(1)
      .max(16384),
  })
  .strict()
  .superRefine((v, c) => {
    const ids = new Set<number>();
    for (const a of v.assignments) {
      if (ids.has(a.tileId))
        c.addIssue({ code: "custom", message: "Duplicate tile assignment" });
      ids.add(a.tileId);
      for (let i = 0; i < 8; i++) {
        if (a.wangId[i] > v.colors.length)
          c.addIssue({ code: "custom", message: "Wang color does not exist" });
        if (
          a.wangId[i] &&
          ((v.type === "edge" && i % 2 === 1) ||
            (v.type === "corner" && i % 2 === 0))
        )
          c.addIssue({
            code: "custom",
            message: "Wang ID uses an inactive position for this set type",
          });
      }
    }
  });
export type WangDefinition = z.infer<typeof wangDefinitionSchema>;
export const GRASS_SHA256 =
  "ae3dfaa489a3daaed25ca9fa7d708cf428784d2840f49057bdd2489dc655ad08";
// Expanded Pipoya 8x6 blocks: positions 0 and 47 have no Wang assignment.
// Bits follow Tiled order: top, top-right, right, bottom-right, bottom,
// bottom-left, left, top-left. Do not apply this to arbitrary 48-tile sheets.
export const GRASS_MASKS = [
  4, 68, 64, 16, 28, 124, 112, 20, 80, 21, 84, 17, 31, 255, 241, 5, 65, 69, 81,
  1, 7, 199, 193, 23, 209, 116, 92, 247, 223, 213, 87, 29, 113, 197, 71, 253,
  127, 117, 93, 125, 215, 245, 95, 221, 119, 85,
];
export function grassDefinition(): WangDefinition {
  return {
    name: "Grass transitions",
    type: "mixed",
    colors: Array.from({ length: 11 }, (_, i) => ({
      name: "Grass " + (i + 1),
    })),
    assignments: Array.from({ length: 11 }, (_, block) =>
      GRASS_MASKS.map((mask, index) => ({
        tileId: block * 48 + index + 1,
        wangId: Array.from({ length: 8 }, (_, bit) =>
          mask & (1 << bit) ? block + 1 : 0,
        ),
      })),
    ).flat(),
  };
}
export function suggestedGrids(width: number, height: number, sha256: string) {
  if (sha256 === GRASS_SHA256)
    return {
      recognition: "verified",
      profile: "pipoya-grass-48",
      grid: { tileWidth: 32, tileHeight: 32, margin: 0, spacing: 0 },
      blocks: 11,
    };
  return {
    recognition: "unknown",
    profile: null,
    candidates: [8, 16, 24, 32, 48, 64]
      .filter((n) => width % n === 0 && height % n === 0)
      .map((n) => ({ tileWidth: n, tileHeight: n, margin: 0, spacing: 0 })),
    guidance:
      "Divisibility is not proof of a tile grid. Inspect the image and ask for tile size or layout if ambiguous.",
  };
}
