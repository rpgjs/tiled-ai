import {
  RpcError,
  contains,
  stable,
  type Rect,
} from "../../protocol/src/index";
import {
  wangDefinitionSchema,
  type WangDefinition,
} from "../../protocol/src/terrain";
const NAMES = "tiled-ai:terrain-names";
function terrainNames(w: WangSet): string[] {
  const v = w.property(NAMES);
  try {
    const parsed: unknown = typeof v === "string" ? JSON.parse(v) : [];
    return Array.isArray(parsed) &&
      parsed.every((name) => typeof name === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
// Tiled 1.12.2 keeps raw WangColor pointers in name Undo commands. Resizing
// colors followed by renaming crashes Redo. Store names in an undoable set property.
export function writeNamedTileset(s: Tileset) {
  try {
    const f = new TextFile(s.fileName, TextFile.ReadOnly);
    let xml = f.readAll();
    f.close();
    let index = 0;
    const escape = (v: string) =>
      v
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "&#10;")
        .replace(/\r/g, "&#13;");
    xml = xml.replace(/<wangset\b[\s\S]*?<\/wangset>/g, (block) => {
      const names = terrainNames(s.wangSets[index++]);
      let color = 0;
      return block.replace(/<wangcolor\b[^>]*>/g, (tag) => {
        const name = names[color++];
        return name === undefined
          ? tag
          : tag.replace(/name="[^"]*"/, () => 'name="' + escape(name) + '"');
      });
    });
    const out = new TextFile(s.fileName, TextFile.WriteOnly);
    out.write(xml);
    out.commit();
  } catch (e) {
    throw new RpcError("SAVE_FAILED", String(e), {
      fileSaved: true,
      namesExported: false,
    });
  }
}
export function describeWang(w: WangSet) {
  return {
    name: w.name,
    type:
      w.type === WangSet.Edge
        ? "edge"
        : w.type === WangSet.Corner
          ? "corner"
          : "mixed",
    colors: Array.from({ length: w.colorCount }, (_, i) => ({
      id: i + 1,
      name: terrainNames(w)[i] ?? w.colorName(i + 1),
      nativeName: w.colorName(i + 1),
    })),
    assignments: w.tileset.tiles
      .map((t) => ({ tileId: t.id, wangId: w.wangId(t) }))
      .filter((a) => a.wangId.some((n) => n !== 0)),
  };
}
export function validateDefinition(s: Tileset, input: unknown): WangDefinition {
  const d = wangDefinitionSchema.parse(input);
  for (const a of d.assignments)
    if (!s.findTile(a.tileId))
      throw new RpcError(
        "TILE_NOT_FOUND",
        "Wang assignment references tile " + a.tileId,
      );
  return d;
}
export function applyDefinition(w: WangSet, d: WangDefinition) {
  for (const t of w.tileset.tiles)
    if (w.wangId(t).some((n) => n !== 0))
      w.setWangId(t, [0, 0, 0, 0, 0, 0, 0, 0]);
  w.name = d.name;
  w.type =
    d.type === "edge"
      ? WangSet.Edge
      : d.type === "corner"
        ? WangSet.Corner
        : WangSet.Mixed;
  w.colorCount = d.colors.length;
  w.setProperty(NAMES, JSON.stringify(d.colors.map((c) => c.name)));
  d.assignments.forEach((a) =>
    w.setWangId(w.tileset.findTile(a.tileId)!, a.wangId),
  );
}
const ZERO = [0, 0, 0, 0, 0, 0, 0, 0];
const neighbors = [
  [0, -1, 4],
  [1, 0, 6],
  [0, 1, 0],
  [-1, 0, 2],
];
export function prepareTerrain(
  map: TileMap,
  layer: TileLayer,
  w: WangSet,
  color: number,
  region: Rect,
  cells?: { x: number; y: number }[],
) {
  if (
    map.orientation !== TileMap.Orthogonal &&
    map.orientation !== TileMap.Isometric
  )
    throw new RpcError(
      "UNSUPPORTED_TERRAIN_ORIENTATION",
      "This painter uses square-cell Wang topology (orthogonal/isometric). Staggered and hexagonal terrain adjacency is not supported; no cells were changed.",
    );
  if (color > w.colorCount)
    throw new RpcError("COLOR_NOT_FOUND", "Terrain color does not exist");
  const selected = map.selectedArea.get(),
    hasSelection = selected.rects.length > 0,
    allowed = (x: number, y: number) =>
      contains(region, x, y) && (!hasSelection || selected.contains(x, y));
  const wanted = new Map<string, { x: number; y: number }>();
  const key = (x: number, y: number) => x + "," + y;
  const add = (x: number, y: number) => {
    if (!allowed(x, y))
      throw new RpcError(
        "OUTSIDE_SELECTION",
        "Terrain footprint exceeds region or exact selection",
      );
    if (
      !map.infinite &&
      !contains({ x: 0, y: 0, width: map.width, height: map.height }, x, y)
    )
      throw new RpcError(
        "OUT_OF_BOUNDS",
        "Terrain footprint exceeds finite map",
      );
    wanted.set(key(x, y), { x, y });
  };
  if (cells) cells.forEach((c) => add(c.x, c.y));
  else
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++)
        if (allowed(x, y)) add(x, y);
  if (!wanted.size)
    throw new RpcError("EMPTY_SELECTION", "There are no paintable cells");
  const actual = (x: number, y: number) => {
    const t = layer.tileAt(x, y);
    if (!t || t.tileset !== w.tileset) return ZERO;
    if (layer.flagsAt(x, y))
      throw new RpcError(
        "UNSUPPORTED_TERRAIN_TRANSFORM",
        "Transformed neighboring terrain cells require an explicitly transformed Wang definition",
      );
    return w.wangId(t);
  };
  const expected = new Map<string, number[]>();
  for (const { x, y } of wanted.values()) {
    const edge = neighbors.map(
      ([dx, dy, opposite]) =>
        wanted.has(key(x + dx, y + dy)) ||
        actual(x + dx, y + dy)[opposite] === color,
    );
    const diagonal = [
      [1, -1, 5],
      [1, 1, 7],
      [-1, 1, 1],
      [-1, -1, 3],
    ].map(
      ([dx, dy, opposite]) =>
        wanted.has(key(x + dx, y + dy)) ||
        actual(x + dx, y + dy)[opposite] === color,
    );
    const id = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      if (w.type !== WangSet.Corner && edge[i]) id[i * 2] = color;
      if (
        w.type !== WangSet.Edge &&
        edge[i] &&
        edge[(i + 1) % 4] &&
        diagonal[i]
      )
        id[i * 2 + 1] = color;
    }
    expected.set(key(x, y), id);
  }
  const lookup = (x: number, y: number) =>
    expected.get(key(x, y)) ?? actual(x, y);
  // Compare both sides of each edge, including its two endpoint corners.
  for (const { x, y } of wanted.values())
    for (const [dx, dy, pairs] of [
      [
        1,
        0,
        [
          [2, 6],
          [1, 7],
          [3, 5],
        ],
      ],
      [
        0,
        1,
        [
          [4, 0],
          [3, 1],
          [5, 7],
        ],
      ],
      [
        -1,
        0,
        [
          [6, 2],
          [7, 1],
          [5, 3],
        ],
      ],
      [
        0,
        -1,
        [
          [0, 4],
          [7, 5],
          [1, 3],
        ],
      ],
    ] as [number, number, number[][]][]) {
      const a = lookup(x, y),
        b = lookup(x + dx, y + dy);
      if (pairs.some(([i, j]) => a[i] !== b[j]))
        throw new RpcError(
          "BOUNDARY_CONFLICT",
          "A terrain boundary cannot match the unchanged neighbor; expand the footprint or use a compatible terrain set",
          { x, y, neighbor: { x: x + dx, y: y + dy } },
        );
    }
  const patterns = new Set(
    w.tileset.tiles
      .map((t) => stable(w.wangId(t)))
      .filter((s) => s !== stable(ZERO)),
  );
  for (const [position, id] of expected)
    if (!id.some((n) => n === color) || !patterns.has(stable(id)))
      throw new RpcError(
        "MISSING_WANG_PATTERN",
        "Terrain set has no tile for a required combination; no cells were changed",
        { position, wangId: id },
      );
  const edit = layer.wangEdit(w);
  edit.correctionsEnabled = false;
  edit.erasingEnabled = false;
  for (const { x, y } of wanted.values()) {
    const id = expected.get(key(x, y))!;
    for (let i = 0; i < 8; i++) edit.setWangIndex(x, y, i, id[i]);
  }
  const generated = edit.generate();
  const prepared: { x: number; y: number; tile: Tile }[] = [];
  for (const r of generated.region().rects)
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++)
        if (!wanted.has(key(x, y)) && generated.tileAt(x, y))
          throw new RpcError(
            "OUTSIDE_SELECTION",
            "Tiled generated a correction outside the requested footprint",
          );
  for (const { x, y } of wanted.values()) {
    const tile = generated.tileAt(x, y) ?? layer.tileAt(x, y),
      flags = generated.tileAt(x, y)
        ? generated.flagsAt(x, y)
        : layer.flagsAt(x, y);
    if (
      !tile ||
      tile.tileset !== w.tileset ||
      flags !== 0 ||
      stable(w.wangId(tile)) !== stable(expected.get(key(x, y)))
    )
      throw new RpcError(
        "MISSING_WANG_PATTERN",
        "Tiled could not satisfy the required Wang constraints",
        { x, y },
      );
    prepared.push({ x, y, tile });
  }
  return () => {
    const out = layer.edit();
    prepared.forEach((c) => out.setTile(c.x, c.y, c.tile, 0));
    out.apply();
    return { cells: prepared.length };
  };
}
