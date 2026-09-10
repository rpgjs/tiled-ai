// Tiled exposes a File namespace, not the browser/Node File constructor.
declare const File: {
  exists(path: string): boolean;
  makePath(path: string): boolean;
};
import { validateGrid } from "../../protocol/src/terrain";
import {
  writeNamedTileset,
  describeWang,
  validateDefinition,
  applyDefinition,
  prepareTerrain,
} from "./terrain";
import {
  RpcError,
  stable,
  contains,
  sameTile,
  MAX_CELLS,
  type Operation,
  type Rect,
  type TileRef,
  type ObjectSpec,
  type Property,
} from "../../protocol/src/index";
const fail = (code: string, message: string): never => {
  throw new RpcError(code, message);
};
const plainRect = (r: rect) => ({
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
});
const pointValue = (p: point) => ({ x: p.x, y: p.y });
function layers(map: TileMap): Layer[] {
  const out: Layer[] = [];
  const walk = (ls: Layer[]) =>
    ls.forEach((l) => {
      out.push(l);
      if (l.isGroupLayer) walk((l as GroupLayer).layers);
    });
  walk(map.layers);
  return out;
}
function encode(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== "object") return v;
  const x = v as Record<string, unknown>;
  if ("url" in x)
    return { type: "file", value: String(x.url), localFile: x.localFile };
  if (
    "id" in x &&
    (typeof x.property === "function" || Object.keys(x).length === 1)
  )
    return { type: "object", value: x.id };
  if ("typeId" in x)
    return {
      type: "custom",
      typeId: x.typeId,
      typeName: x.typeName,
      value: encode(x.value),
    };
  if (Array.isArray(v)) return v.map(encode);
  const keys = Object.keys(v);
  if (!keys.length) {
    const text = String(v);
    return text[0] === "#" ? { type: "color", value: text } : {};
  }
  return Object.fromEntries(keys.map((k) => [k, encode(x[k])]));
}
function properties(o: TiledObject) {
  const ps = o.properties();
  return Object.fromEntries(Object.keys(ps).map((k) => [k, encode(ps[k])]));
}
function objectInfo(o: MapObject) {
  return {
    id: o.id,
    name: o.name,
    className: o.className,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    rotation: o.rotation,
    shape: {
      [MapObject.Rectangle as unknown as number]: "rectangle",
      [MapObject.Ellipse as unknown as number]: "ellipse",
      [MapObject.Point as unknown as number]: "point",
      [MapObject.Polygon as unknown as number]: "polygon",
      [MapObject.Polyline as unknown as number]: "polyline",
      [MapObject.Text as unknown as number]: "text",
    }[o.shape as unknown as number],
    points: o.polygon.map(pointValue),
    text: o.text,
    visible: o.visible,
    textColor: String(o.textColor),
    font: encode(o.font),
    tile: o.tile
      ? {
          tileId: o.tile.id,
          tileset: o.tile.tileset.name,
          tilesetFileName: o.tile.tileset.fileName,
          flags:
            (o.tileFlippedHorizontally ? 1 : 0) |
            (o.tileFlippedVertically ? 2 : 0),
        }
      : null,
    properties: properties(o),
  };
}
export class Editor {
  private docs = new Map<Asset, string>();
  private sets = new Map<Tileset, string>();
  private wangIds = new Map<WangSet, string>();
  private wangId(w: WangSet) {
    if (!this.wangIds.has(w)) this.wangIds.set(w, "wang-" + this.next++);
    return this.wangIds.get(w)!;
  }
  private next = 1;
  private observations = new Map<string, { asset: Asset; snapshot: string }>();
  private revisionCounter = 1;
  private onClosed = (a: Asset) => {
    this.docs.delete(a);
    for (const [k, v] of this.observations)
      if (v.asset === a) this.observations.delete(k);
  };
  constructor(public readonly sessionId: string) {
    tiled.assetAboutToBeClosed.connect(this.onClosed);
  }
  dispose() {
    tiled.assetAboutToBeClosed.disconnect(this.onClosed);
    this.observations.clear();
  }
  private docId(a: Asset) {
    if (!this.docs.has(a)) this.docs.set(a, "doc-" + this.next++);
    return this.docs.get(a)!;
  }
  private setId(s: Tileset) {
    if (!this.sets.has(s)) this.sets.set(s, "tileset-" + this.next++);
    return this.sets.get(s)!;
  }
  private target(p: any): Asset {
    if (p.sessionId !== this.sessionId)
      fail("SESSION_MISMATCH", "Reconnect and inspect the editor");
    const a = tiled.openAssets.find((a) => this.docId(a) === p.documentId);
    return a ?? fail("DOCUMENT_CLOSED", "Target document is no longer open");
  }
  private map(a: Asset) {
    return a.isTileMap
      ? (a as TileMap)
      : fail("WRONG_DOCUMENT", "This operation requires a map");
  }
  private tile(a: Asset, t: TileRef | null): Tile | null {
    if (!t) return null;
    const sets = a.isTileMap ? (a as TileMap).tilesets : [a as Tileset];
    const s = sets.find((s) => this.setId(s) === t.tilesetId);
    if (!s)
      fail("TILESET_NOT_FOUND", "Tileset is not attached to this document");
    const tile = s!.tile(t.tileId);
    if (!tile) fail("TILE_NOT_FOUND", "Tile ID does not exist");
    if (
      a.isTileMap &&
      (a as TileMap).orientation !== TileMap.Hexagonal &&
      t.flags & 8
    )
      fail("INVALID_FLAGS", "120 degree rotation requires a hexagonal map");
    return tile;
  }
  private layer(m: TileMap, id: number) {
    return (
      layers(m).find((l) => l.id === id) ??
      fail("LAYER_NOT_FOUND", "Layer does not exist")
    );
  }
  private writable(o: TiledObject) {
    if (o.readOnly) fail("READ_ONLY", "Target is read-only");
    if ("isTileLayer" in o) {
      let l: Layer | null = o as Layer;
      while (l) {
        if (l.locked) fail("LAYER_LOCKED", "Target or parent layer is locked");
        l = l.parentLayer;
      }
    }
  }
  private tileRef(l: TileLayer, x: number, y: number): TileRef | null {
    const t = l.tileAt(x, y);
    return t
      ? {
          tilesetId: this.setId(t.tileset),
          tileId: t.id,
          flags: l.flagsAt(x, y),
        }
      : null;
  }
  private layerInfo(l: Layer) {
    return {
      id: l.id,
      parentId: l.parentLayer?.id ?? null,
      name: l.name,
      kind: l.isTileLayer
        ? "tile"
        : l.isObjectLayer
          ? "object"
          : l.isGroupLayer
            ? "group"
            : "image",
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity,
      tintColor: String(l.tintColor),
      parallaxFactor: pointValue(l.parallaxFactor),
      offset: pointValue(l.offset),
      className: l.className,
      properties: properties(l),
    };
  }
  private mapInfo(m: TileMap) {
    return {
      width: m.width,
      height: m.height,
      tileWidth: m.tileWidth,
      tileHeight: m.tileHeight,
      infinite: m.infinite,
      orientation: m.orientation,
      staggerAxis: m.staggerAxis,
      staggerIndex: m.staggerIndex,
      hexSideLength: m.hexSideLength,
      renderOrder: m.renderOrder,
      backgroundColor: String(m.backgroundColor),
      properties: properties(m),
      className: m.className,
    };
  }
  private setInfo(s: Tileset) {
    return {
      id: this.setId(s),
      documentId: tiled.openAssets.includes(s) ? this.docId(s) : null,
      name: s.name,
      fileName: s.fileName,
      tileWidth: s.tileWidth,
      tileHeight: s.tileHeight,
      tileCount: s.tileCount,
      collection: s.isCollection,
      imageFileName: s.imageFileName,
      spacing: s.tileSpacing,
      margin: s.margin,
      properties: properties(s),
    };
  }
  private snapshot(a: Asset): string {
    let count = 0;
    const setSnapshot = (s: Tileset) => ({
      info: this.setInfo(s),
      wangSets: s.wangSets.map((w) => ({
        ...describeWang(w),
        properties: properties(w),
      })),
      transformationFlags: s.transformationFlags,
      tiles: s.tiles.map((t) => ({
        id: t.id,
        className: t.className,
        properties: properties(t),
        imageFileName: t.imageFileName,
        imageRect: plainRect(t.imageRect),
        frames: t.frames,
        collisions: t.objectGroup?.objects.map(objectInfo) ?? [],
      })),
    });
    if (!a.isTileMap) return stable(setSnapshot(a as Tileset));
    const m = a as TileMap;
    return stable({
      info: this.mapInfo(m),
      selection: m.selectedArea.get().rects.map(plainRect),
      sets: m.tilesets.map(setSnapshot),
      layers: layers(m).map((l) => {
        const info = this.layerInfo(l);
        if (l.isObjectLayer)
          return {
            ...info,
            objects: (l as ObjectGroup).objects.map(objectInfo),
          };
        if (l.isTileLayer) {
          const tl = l as TileLayer;
          const cells: unknown[] = [];
          for (const r of tl.region().rects) {
            count += r.width * r.height;
            if (count > 1048576)
              fail(
                "DOCUMENT_TOO_LARGE",
                "Revision inspection is limited to 1,048,576 occupied-region cells",
              );
            for (let y = r.y; y < r.y + r.height; y++)
              for (let x = r.x; x < r.x + r.width; x++)
                cells.push([x, y, this.tileRef(tl, x, y)]);
          }
          return { ...info, cells };
        }
        return {
          ...info,
          ...(l.isImageLayer
            ? {
                imageFileName: (l as ImageLayer).imageFileName,
                repeatX: (l as ImageLayer).repeatX,
                repeatY: (l as ImageLayer).repeatY,
              }
            : {}),
        };
      }),
    });
  }
  private observe(a: Asset) {
    const token = this.sessionId + ":" + this.revisionCounter++;
    this.observations.set(token, { asset: a, snapshot: this.snapshot(a) });
    while (
      this.observations.size > 1 &&
      (this.observations.size > 32 ||
        Array.from(this.observations.values()).reduce(
          (n, v) => n + v.snapshot.length,
          0,
        ) >
          16 * 1024 * 1024)
    )
      this.observations.delete(this.observations.keys().next().value!);
    return token;
  }
  private checkRevision(a: Asset, token: string) {
    const old = this.observations.get(token);
    if (!old || old.asset !== a || old.snapshot !== this.snapshot(a))
      fail(
        "CONFLICT",
        "Document or selection changed. Read get_map_info and plan again.",
      );
  }
  private setProperties(o: TiledObject, ps: Record<string, Property>) {
    for (const [name, p] of Object.entries(ps)) {
      switch (p.type) {
        case "remove":
          o.removeProperty(name);
          break;
        case "float":
          o.setFloatProperty(name, p.value);
          break;
        case "color":
          o.setProperty(name, tiled.color(p.value));
          break;
        case "file":
          o.setProperty(name, tiled.filePath(p.value));
          break;
        case "object":
          o.setProperty(name, tiled.objectRef(p.value));
          break;
        default:
          o.setProperty(name, p.value);
      }
    }
  }
  private makeObject(a: Asset, s: ObjectSpec): MapObject {
    const o = new MapObject();
    o.name = s.name;
    o.className = s.className;
    o.x = s.x;
    o.y = s.y;
    o.width = s.width;
    o.height = s.height;
    o.rotation = s.rotation;
    const shapes: Record<string, MapObjectShape> = {
      rectangle: MapObject.Rectangle,
      ellipse: MapObject.Ellipse,
      point: MapObject.Point,
      polygon: MapObject.Polygon,
      polyline: MapObject.Polyline,
      text: MapObject.Text,
      tile: MapObject.Rectangle,
    };
    o.shape = shapes[s.shape];
    if (s.points) o.polygon = s.points;
    if (s.text !== undefined) o.text = s.text;
    if (s.tile) {
      o.tile = this.tile(a, s.tile);
      o.tileFlippedHorizontally = !!(s.tile.flags & 1);
      o.tileFlippedVertically = !!(s.tile.flags & 2);
      if (s.tile.flags & 12)
        fail(
          "UNSUPPORTED_OBJECT_FLAGS",
          "Tile objects support horizontal and vertical flips only",
        );
    }
    this.setProperties(o, s.properties);
    return o;
  }
  private validateProperties(a: Asset, ps: Record<string, Property>) {
    for (const p of Object.values(ps))
      if (p.type === "object" && p.value !== 0) {
        if (
          !a.isTileMap ||
          !layers(a as TileMap).some(
            (l) =>
              l.isObjectLayer &&
              (l as ObjectGroup).objects.some((o) => o.id === p.value),
          )
        )
          fail(
            "OBJECT_NOT_FOUND",
            "Object property references an unknown object",
          );
      }
  }
  private prepare(
    a: Asset,
    op: Operation,
    guard?: (x: number, y: number) => void,
  ): () => unknown {
    this.writable(a);
    if (op.op === "set_tile_collisions") {
      if (!a.isTileset)
        fail(
          "WRONG_DOCUMENT",
          "Target the open tileset document to edit tile collisions",
        );
      const t = (a as Tileset).tile(op.tileId);
      if (!t) fail("TILE_NOT_FOUND", "Unknown tile");
      this.writable(t);
      const group = new ObjectGroup();
      for (const s of op.objects) {
        if (s.shape === "tile" || s.shape === "text")
          fail("INVALID_COLLISION", "Collision shapes cannot be tile or text");
        this.validateProperties(a, s.properties);
        group.addObject(this.makeObject(a, s));
      }
      return () => {
        t.objectGroup = group;
        return { tileId: t.id, objects: group.objectCount };
      };
    }
    if (op.op === "set_properties") {
      let o: TiledObject = a;
      if (op.target === "tile") {
        if (!a.isTileset)
          fail("WRONG_DOCUMENT", "Tile properties require a tileset document");
        o =
          (a as Tileset).tile(op.id ?? -1) ??
          fail("TILE_NOT_FOUND", "Unknown tile");
      } else if (op.target === "layer")
        o = this.layer(this.map(a), op.id ?? -1);
      else if (op.target === "object") {
        const m = this.map(a);
        const l = layers(m).find(
          (l) =>
            l.isObjectLayer &&
            (l as ObjectGroup).objects.some((o) => o.id === op.id),
        );
        if (!l) fail("OBJECT_NOT_FOUND", "Unknown object");
        this.writable(l!);
        o = (l as ObjectGroup).objects.find((o) => o.id === op.id)!;
      }
      this.writable(o);
      this.validateProperties(a, op.properties);
      return () => {
        this.setProperties(o, op.properties);
        return { target: op.target, id: op.id };
      };
    }
    const m = this.map(a);
    if (op.op === "create_layer") {
      const parent = op.parentId === undefined ? m : this.layer(m, op.parentId);
      if ("isGroupLayer" in parent) {
        this.writable(parent);
        if (!parent.isGroupLayer) fail("WRONG_LAYER", "Parent must be a group");
      }
      const l =
        op.kind === "tile"
          ? new TileLayer(op.name)
          : op.kind === "object"
            ? new ObjectGroup(op.name)
            : new GroupLayer(op.name);
      if (l.isTileLayer) (l as TileLayer).size = m.size;
      return () => {
        (parent as TileMap | GroupLayer).addLayer(l);
        return { layerId: l.id };
      };
    }
    if (op.op === "update_objects") {
      const prepared = op.objects.map(({ id, value }) => {
        const l = layers(m).find(
          (l) =>
            l.isObjectLayer &&
            (l as ObjectGroup).objects.some((o) => o.id === id),
        );
        if (!l) fail("OBJECT_NOT_FOUND", "Unknown object");
        this.writable(l!);
        const old = (l as ObjectGroup).objects.find((o) => o.id === id)!;
        this.writable(old);
        this.validateProperties(a, value.properties);
        const source = this.makeObject(a, value);
        return { old, source, value };
      });
      return () => {
        for (const { old, source, value } of prepared) {
          old.name = source.name;
          old.className = source.className;
          old.x = source.x;
          old.y = source.y;
          old.width = source.width;
          old.height = source.height;
          old.rotation = source.rotation;
          old.shape = source.shape;
          old.polygon = source.polygon;
          old.text = source.text;
          old.tile = source.tile;
          old.tileFlippedHorizontally = source.tileFlippedHorizontally;
          old.tileFlippedVertically = source.tileFlippedVertically;
          this.setProperties(old, value.properties);
        }
        return { objectIds: prepared.map((p) => p.old.id) };
      };
    }
    const l = this.layer(m, op.layerId);
    this.writable(l);
    if (op.op === "update_layer")
      return () => {
        for (const [k, v] of Object.entries(op.patch))
          (l as unknown as Record<string, unknown>)[k] = v;
        return { layerId: l.id };
      };
    if (op.op === "create_objects") {
      if (!l.isObjectLayer) fail("WRONG_LAYER", "Requires an object layer");
      const os = op.objects.map((s) => {
        this.validateProperties(a, s.properties);
        return this.makeObject(a, s);
      });
      return () => {
        os.forEach((o) => (l as ObjectGroup).addObject(o));
        return { objectIds: os.map((o) => o.id) };
      };
    }
    if (!l.isTileLayer) fail("WRONG_LAYER", "Requires a tile layer");
    const tl = l as TileLayer;
    const cells: { x: number; y: number; tile: Tile | null; flags: number }[] =
      [];
    const add = (x: number, y: number, t: TileRef | null) => {
      if (
        !m.infinite &&
        !contains({ x: 0, y: 0, width: m.width, height: m.height }, x, y)
      )
        fail("OUT_OF_BOUNDS", "Cell is outside the finite map");
      if (
        m.selectedArea.get().rects.length &&
        !m.selectedArea.get().contains(x, y)
      )
        fail(
          "OUTSIDE_SELECTION",
          "Tiled clips painting to its current selection; clear or expand it first",
        );
      guard?.(x, y);
      cells.push({ x, y, tile: this.tile(a, t), flags: t?.flags ?? 0 });
    };
    if (op.op === "set_tiles") op.cells.forEach((c) => add(c.x, c.y, c.tile));
    else {
      this.tile(a, op.op === "fill_region" ? op.tile : op.from);
      if (op.op === "replace_tiles") this.tile(a, op.to);
      const r = op.region;
      for (let y = r.y; y < r.y + r.height; y++)
        for (let x = r.x; x < r.x + r.width; x++) {
          if (op.op === "fill_region") add(x, y, op.tile);
          else if (sameTile(this.tileRef(tl, x, y), op.from)) add(x, y, op.to);
        }
    }
    const edit = tl.edit();
    for (const c of cells) edit.setTile(c.x, c.y, c.tile, c.flags);
    return () => {
      edit.apply();
      return { cells: cells.length, layerId: l.id };
    };
  }
  private page<T>(items: T[], p: any) {
    return {
      items: items.slice(p.offset, p.offset + p.limit),
      total: items.length,
      nextOffset: p.offset + p.limit < items.length ? p.offset + p.limit : null,
    };
  }
  private openTileset(path: string) {
    if (!FileInfo.isAbsolutePath(path) || !path.toLowerCase().endsWith(".tsx"))
      fail("INVALID_DESTINATION", "Use an absolute TSX path");
    // Open the cleaned path and report Tiled's own, as openMap does. A map
    // that later resolves a relative link to this file must reach the same
    // Tileset instance, or its Wang sets and tileset ID no longer resolve.
    const a = tiled.open(FileInfo.cleanPath(path));
    if (!a || !a.isTileset) fail("OPEN_FAILED", "Could not open the tileset");
    return {
      documentId: this.docId(a!),
      tilesetId: this.setId(a as Tileset),
      filePath: a!.fileName,
      documentOpened: true,
    };
  }
  private openMap(path: string) {
    if (!FileInfo.isAbsolutePath(path) || !path.toLowerCase().endsWith(".tmx"))
      fail("INVALID_DESTINATION", "Use an absolute TMX path");
    const map = tiled.open(path);
    if (!map || !map.isTileMap) fail("OPEN_FAILED", "Could not open the map");
    return {
      documentId: this.docId(map!),
      filePath: map!.fileName,
      documentOpened: true,
      revision: this.observe(map!),
    };
  }
  handle(method: string, p: any): unknown {
    if (method === "create_map" || method === "open_map") {
      if (p.sessionId !== this.sessionId)
        fail("SESSION_MISMATCH", "Reconnect and inspect the editor");
      if (method === "open_map") return this.openMap(p.path);
      if (
        !FileInfo.isAbsolutePath(p.outputPath) ||
        !p.outputPath.toLowerCase().endsWith(".tmx")
      )
        fail("INVALID_DESTINATION", "Use an absolute TMX outputPath");
      if (File.exists(p.outputPath))
        fail(
          "FILE_EXISTS",
          "Refusing to overwrite an existing TMX; use open_map",
        );
      if (p.width * p.height > 1048576)
        fail("MAP_TOO_LARGE", "Initial map dimensions exceed 1048576 cells");
      if (
        p.orientation === "hexagonal" &&
        (p.hexSideLength < 1 ||
          p.hexSideLength >
            (p.staggerAxis === "x" ? p.tileWidth : p.tileHeight))
      )
        fail(
          "INVALID_GEOMETRY",
          "Hexagonal maps require a positive hexSideLength no larger than the tile size along staggerAxis",
        );
      const map = new TileMap();
      map.setSize(p.width, p.height);
      map.setTileSize(p.tileWidth, p.tileHeight);
      const orientations = {
        orthogonal: TileMap.Orthogonal,
        isometric: TileMap.Isometric,
        staggered: TileMap.Staggered,
        hexagonal: TileMap.Hexagonal,
      } as const;
      map.orientation =
        orientations[p.orientation as keyof typeof orientations];
      map.infinite = p.infinite;
      map.staggerAxis =
        p.staggerAxis === "x" ? TileMap.StaggerX : TileMap.StaggerY;
      map.staggerIndex =
        p.staggerIndex === "odd" ? TileMap.StaggerOdd : TileMap.StaggerEven;
      map.hexSideLength = p.hexSideLength;
      map.layerDataFormat = TileMap.CSV;
      for (const name of p.layers) {
        const layer = new TileLayer(name);
        layer.width = p.width;
        layer.height = p.height;
        map.addLayer(layer);
      }
      if (!File.makePath(FileInfo.path(p.outputPath)))
        fail("SAVE_FAILED", "Could not create the destination directory");
      const error = tiled.mapFormat("tmx")!.write(map, p.outputPath);
      if (error)
        throw new RpcError("SAVE_FAILED", error, {
          fileCreated: File.exists(p.outputPath),
          documentOpened: false,
          filePath: p.outputPath,
        });
      try {
        return { ...this.openMap(p.outputPath), fileCreated: true };
      } catch (e) {
        return {
          fileCreated: true,
          documentOpened: false,
          filePath: p.outputPath,
          recovery: "Use open_map to open the created TMX",
          error: String(e),
        };
      }
    }

    if (method === "create_tileset_from_image" || method === "open_tileset") {
      if (p.sessionId !== this.sessionId)
        fail("SESSION_MISMATCH", "Reconnect and inspect the editor");
      if (method === "open_tileset") return this.openTileset(p.path);
      if (
        !FileInfo.isAbsolutePath(p.source) ||
        !FileInfo.isAbsolutePath(p.outputPath) ||
        !p.outputPath.toLowerCase().endsWith(".tsx")
      )
        fail("INVALID_DESTINATION", "Use absolute image and TSX paths");
      if (File.exists(p.outputPath))
        fail("FILE_EXISTS", "Refusing to overwrite an existing TSX");
      const image = new Image(p.source);
      validateGrid(image.width, image.height, p.grid);
      const s = new Tileset(p.name);
      s.setTileSize(p.grid.tileWidth, p.grid.tileHeight);
      s.margin = p.grid.margin;
      s.tileSpacing = p.grid.spacing;
      s.imageFileName = p.source;
      const error = tiled.tilesetFormat("tsx")!.write(s, p.outputPath);
      if (error)
        throw new RpcError("SAVE_FAILED", error, {
          imageImported: true,
          filePath: p.outputPath,
          fileCreated: File.exists(p.outputPath),
        });
      try {
        return {
          ...this.openTileset(p.outputPath),
          imageImported: true,
          fileCreated: true,
        };
      } catch (e) {
        return {
          imageImported: true,
          fileCreated: true,
          documentOpened: false,
          filePath: p.outputPath,
          recovery: "Use open_tileset to open the created file",
          error: String(e),
        };
      }
    }

    if (method === "get_editor_state")
      return {
        sessionId: this.sessionId,
        tiledVersion: tiled.version,
        protocolVersion: 1,
        documents: tiled.openAssets
          .filter((a) => a.isTileMap || a.isTileset)
          .map((a) => ({
            id: this.docId(a),
            kind: a.isTileMap ? "map" : "tileset",
            fileName: a.fileName,
            modified: a.modified,
            active: tiled.activeAsset === a,
          })),
        capabilities: {
          orientations: ["orthogonal", "isometric", "staggered", "hexagonal"],
          maxCells: MAX_CELLS,
          undo: true,
        },
      };
    const a = this.target(p);
    if (method === "save_map") {
      this.checkRevision(a, p.expectedRevision);
      this.writable(a);
      const map = this.map(a);
      const destination = p.outputPath ?? map.fileName;
      if (
        !FileInfo.isAbsolutePath(destination) ||
        !destination.toLowerCase().endsWith(".tmx")
      )
        fail(
          "INVALID_DESTINATION",
          "Use an absolute TMX outputPath for an untitled map",
        );
      const sameFile =
        FileInfo.cleanPath(destination) === FileInfo.cleanPath(map.fileName);
      if (!sameFile && File.exists(destination))
        fail("FILE_EXISTS", "Refusing to overwrite another file");
      if (sameFile) {
        if (!map.save()) fail("SAVE_FAILED", "Tiled could not save the map");
      } else {
        if (!File.makePath(FileInfo.path(destination)))
          fail("SAVE_FAILED", "Could not create the destination directory");
        const error = tiled.mapFormat("tmx")!.write(map, destination);
        if (error)
          throw new RpcError("SAVE_FAILED", error, {
            filePath: destination,
            fileMayHaveChanges: true,
          });
      }
      return {
        saved: true,
        filePath: destination,
        documentId: p.documentId,
        revision: this.observe(map),
        savedCopy: !sameFile,
        documentFilePath: map.fileName,
        modified: map.modified,
      };
    }

    if (method === "list_wang_sets") {
      const s = a.isTileset
        ? (a as Tileset)
        : (a as TileMap).tilesets.find((s) => this.setId(s) === p.tilesetId);
      if (!s) fail("TILESET_NOT_FOUND", "Specify an attached tileset");
      return {
        tilesetId: this.setId(s!),
        items: s!.wangSets.map((w) => ({
          id: this.wangId(w),
          ...describeWang(w),
        })),
      };
    }
    if (
      [
        "attach_tileset",
        "create_wang_set",
        "update_wang_set",
        "save_tileset",
        "paint_terrain",
      ].includes(method)
    ) {
      this.checkRevision(a, p.expectedRevision);
      this.writable(a);
      let action: () => unknown;
      if (method === "save_tileset") {
        if (!a.isTileset)
          fail("WRONG_DOCUMENT", "Save targets a tileset document");
        if (!a.fileName.toLowerCase().endsWith(".tsx"))
          fail(
            "INVALID_DESTINATION",
            "Explicit tileset saving currently requires a TSX destination",
          );
        if (!a.save()) fail("SAVE_FAILED", "Tiled could not save this tileset");
        writeNamedTileset(a as Tileset);
        return {
          saved: true,
          filePath: a.fileName,
          namesVisibleAfterReopen: true,
          revision: this.observe(a),
        };
      }
      if (method === "attach_tileset") {
        const map = this.map(a),
          set = this.target({ ...p, documentId: p.tilesetDocumentId });
        if (!set.isTileset)
          fail("WRONG_DOCUMENT", "tilesetDocumentId must identify a tileset");
        if (map.tilesets.includes(set as Tileset))
          return {
            attached: true,
            alreadyAttached: true,
            tilesetId: this.setId(set as Tileset),
            revision: this.observe(a),
          };
        action = () => {
          map.addTileset(set as Tileset);
          return { attached: true, tilesetId: this.setId(set as Tileset) };
        };
      } else if (method === "paint_terrain") {
        const map = this.map(a),
          l = this.layer(map, p.layerId);
        this.writable(l);
        if (!l.isTileLayer) fail("WRONG_LAYER", "Terrain needs a tile layer");
        const s = map.tilesets.find((s) => this.setId(s) === p.tilesetId);
        const w = s?.wangSets.find((w) => this.wangId(w) === p.wangSetId);
        if (!w) fail("WANG_SET_NOT_FOUND", "Unknown attached Wang set");
        action = prepareTerrain(
          map,
          l as TileLayer,
          w!,
          p.colorId,
          p.region,
          p.cells,
        );
      } else {
        if (!a.isTileset)
          fail("WRONG_DOCUMENT", "Wang edits require an open tileset document");
        const s = a as Tileset,
          d = validateDefinition(s, p.definition);
        let existing: WangSet | undefined;
        if (method === "update_wang_set") {
          existing = s.wangSets.find((w) => this.wangId(w) === p.wangSetId);
          if (!existing) fail("WANG_SET_NOT_FOUND", "Unknown Wang set");
        } else if (s.wangSets.some((w) => w.name === d.name))
          fail(
            "WANG_SET_EXISTS",
            "A set with this name already exists; update it explicitly",
          );
        action = () => {
          const w =
            existing ??
            s.addWangSet(
              d.name,
              d.type === "edge"
                ? WangSet.Edge
                : d.type === "corner"
                  ? WangSet.Corner
                  : WangSet.Mixed,
            );
          applyDefinition(w, d);
          return { wangSetId: this.wangId(w) };
        };
      }
      let result: unknown;
      try {
        a.macro(p.label, () => {
          result = action();
        });
      } catch (e) {
        throw new RpcError("PARTIAL_APPLICATION", String(e), {
          failedOperationMayHaveChanges: true,
          undoAvailable: true,
        });
      }
      return { applied: true, result, revision: this.observe(a) };
    }

    if (method === "get_map_info")
      return {
        documentId: p.documentId,
        revision: this.observe(a),
        modified: a.modified,
        ...(a.isTileMap
          ? this.mapInfo(a as TileMap)
          : this.setInfo(a as Tileset)),
      };
    if (method === "list_tilesets")
      return this.page(
        (a.isTileMap ? (a as TileMap).tilesets : [a as Tileset]).map((s) =>
          this.setInfo(s),
        ),
        p,
      );
    if (method === "get_tileset_images") {
      const s = (a.isTileMap ? (a as TileMap).tilesets : [a as Tileset]).find(
        (s) => this.setId(s) === p.tilesetId,
      );
      if (!s) fail("TILESET_NOT_FOUND", "Unknown tileset");
      return this.page(
        s!.tiles.map((t) => t.id),
        p,
      ).items.map((id) => {
        const t = s!.tile(id)!;
        const image = t.image.copy(t.imageRect);
        if (image.width * image.height > 4194304)
          fail("IMAGE_TOO_LARGE", "Tile image exceeds 4 megapixels");
        return {
          tileId: id,
          tilesetId: p.tilesetId,
          className: t.className,
          properties: properties(t),
          width: image.width,
          height: image.height,
          png: Base64.encode(image.saveToData("PNG")),
        };
      });
    }
    if (
      method === "apply_operations" ||
      method === "apply_structure" ||
      method in
        {
          set_tiles: 1,
          replace_tiles: 1,
          fill_region: 1,
          create_layer: 1,
          update_layer: 1,
          create_objects: 1,
          update_objects: 1,
          set_properties: 1,
          set_tile_collisions: 1,
        }
    ) {
      this.checkRevision(a, p.expectedRevision);
      let ops: Operation[] = p.operations ?? [p.operation];
      if (p.operation && p.operation.op !== method)
        fail("INVALID_OPERATION", "Operation must match tool name");
      let guard: ((x: number, y: number) => void) | undefined;
      if (method === "apply_structure") {
        const m = this.map(a),
          selection = m.selectedArea.get();
        if (!selection.rects.length)
          fail("EMPTY_SELECTION", "Select an area in Tiled first");
        guard = (x, y) => {
          if (!contains(p.region, x, y) || !selection.contains(x, y))
            fail(
              "OUTSIDE_SELECTION",
              "Structure exceeds region or exact selection",
            );
        };
        ops = ops.map((op) => {
          if (op.op === "set_tiles")
            return {
              ...op,
              cells: op.cells.map((c) => ({
                ...c,
                x: c.x + p.origin.x,
                y: c.y + p.origin.y,
              })),
            };
          if (op.op === "fill_region" || op.op === "replace_tiles")
            return {
              ...op,
              region: {
                ...op.region,
                x: op.region.x + p.origin.x,
                y: op.region.y + p.origin.y,
              },
            };
          if (op.op === "create_objects") {
            const l = this.layer(m, op.layerId);
            const origin = m.tileToPixel(p.origin);
            return {
              ...op,
              objects: op.objects.map((s) => {
                const value = { ...s, x: s.x + origin.x, y: s.y + origin.y };
                this.guardObject(m, l, value, guard!);
                return value;
              }),
            };
          }
          return fail(
            "INVALID_STRUCTURE_OPERATION",
            "Structures accept tile edits and object creation only",
          );
        });
      }
      const work = ops.reduce(
        (n, op) =>
          n +
          (op.op === "set_tiles"
            ? op.cells.length
            : op.op === "fill_region" || op.op === "replace_tiles"
              ? op.region.width * op.region.height
              : 1),
        0,
      );
      if (work > MAX_CELLS)
        fail("LIMIT_EXCEEDED", "Split edits larger than 16384 cells");
      // References resolve against the state before the batch, including new layer IDs.
      const prepared = ops.map((op) => this.prepare(a, op, guard));
      const results: unknown[] = [];
      let index = 0;
      try {
        a.macro(p.label, () => {
          for (; index < prepared.length; index++)
            results.push(prepared[index]());
        });
      } catch (e) {
        throw new RpcError("PARTIAL_APPLICATION", String(e), {
          completedOperations: index,
          failedOperation: index,
          results,
          failedOperationMayHaveChanges: true,
          undoAvailable: true,
        });
      }
      // A post-edit inspection failure must not hide a successful mutation.
      try {
        return { applied: true, results, revision: this.observe(a) };
      } catch (e) {
        return {
          applied: true,
          results,
          revision: null,
          inspectionError: String(e),
        };
      }
    }
    const m = this.map(a);
    if (method === "list_layers")
      return this.page(
        layers(m).map((l) => this.layerInfo(l)),
        p,
      );
    if (method === "get_selection")
      return {
        rects: m.selectedArea.get().rects.map(plainRect),
        bounds: plainRect(m.selectedArea.boundingRect),
        layerIds: m.selectedLayers.map((l) => l.id),
        objectIds: m.selectedObjects.map((o) => o.id),
      };
    if (method === "get_objects")
      return this.page(
        layers(m)
          .filter(
            (l) =>
              l.isObjectLayer &&
              (p.layerId === undefined || l.id === p.layerId),
          )
          .flatMap((l) =>
            (l as ObjectGroup).objects.map((o) => ({
              ...objectInfo(o),
              ...(o.tile
                ? {
                    tile: {
                      tilesetId: this.setId(o.tile.tileset),
                      tileId: o.tile.id,
                      flags:
                        (o.tileFlippedHorizontally ? 1 : 0) |
                        (o.tileFlippedVertically ? 2 : 0),
                    },
                  }
                : {}),
              layerId: l.id,
            })),
          ),
        p,
      );
    if (method === "read_region") {
      const l = this.layer(m, p.layerId);
      if (!l.isTileLayer) fail("WRONG_LAYER", "Requires a tile layer");
      const r: Rect = p.region,
        total = r.width * r.height;
      const cells = [];
      for (let i = p.offset; i < Math.min(total, p.offset + p.limit); i++) {
        const x = r.x + (i % r.width),
          y = r.y + Math.floor(i / r.width);
        cells.push({ x, y, tile: this.tileRef(l as TileLayer, x, y) });
      }
      return {
        items: cells,
        total,
        nextOffset: p.offset + p.limit < total ? p.offset + p.limit : null,
      };
    }
    if (method === "get_region_image") return this.regionImage(m, p.region);
    return fail("UNKNOWN_METHOD", method);
  }
  private guardObject(
    m: TileMap,
    l: Layer,
    s: ObjectSpec,
    guard: (x: number, y: number) => void,
  ) {
    if (s.rotation !== 0 || s.shape === "tile" || s.shape === "text")
      fail(
        "UNSUPPORTED_STRUCTURE_OBJECT",
        "Structure objects must be unrotated geometry",
      );
    let offset = { x: 0, y: 0 };
    let current: Layer | null = l;
    while (current) {
      offset.x += current.offset.x;
      offset.y += current.offset.y;
      current = current.parentLayer;
    }
    // Conservative footprint: every screen pixel in the geometry bounds must map into the mask.
    const points = s.points ?? [
      { x: 0, y: 0 },
      { x: s.width, y: s.height },
    ];
    const ps = points.map((p) => m.pixelToScreen(s.x + p.x, s.y + p.y));
    const minX = Math.floor(Math.min(...ps.map((p) => p.x)) + offset.x),
      minY = Math.floor(Math.min(...ps.map((p) => p.y)) + offset.y),
      maxX = Math.ceil(Math.max(...ps.map((p) => p.x)) + offset.x),
      maxY = Math.ceil(Math.max(...ps.map((p) => p.y)) + offset.y);
    if (Math.max(1, maxX - minX) * Math.max(1, maxY - minY) > 1048576)
      fail("LIMIT_EXCEEDED", "Structure object footprint is too large");
    for (let y = minY; y < Math.max(minY + 1, maxY); y++)
      for (let x = minX; x < Math.max(minX + 1, maxX); x++) {
        const p = m.screenToTile(x + 0.5, y + 0.5);
        guard(Math.floor(p.x), Math.floor(p.y));
      }
  }
  private regionImage(m: TileMap, r: Rect) {
    // Render a detached, bounded tile-layer copy with Tiled's own orientation renderer.
    const copy = new TileMap();
    copy.orientation = m.orientation;
    copy.staggerAxis = m.staggerAxis;
    copy.staggerIndex = m.staggerIndex;
    copy.hexSideLength = m.hexSideLength;
    copy.renderOrder = m.renderOrder;
    copy.setTileSize(m.tileWidth, m.tileHeight);
    // Even padding preserves stagger parity when translating negative coordinates.
    const ox = Math.floor(r.x / 2) * 2,
      oy = Math.floor(r.y / 2) * 2;
    copy.setSize(r.width + r.x - ox, r.height + r.y - oy);
    m.tilesets.forEach((s) => copy.addTileset(s));
    const translate = (x: number, y: number) => {
      const p = m.pixelToTile(x, y);
      return copy.tileToPixel(p.x - ox, p.y - oy);
    };
    const screenOrigin = m.tileToScreen(ox, oy),
      newOrigin = copy.tileToScreen(0, 0);
    const clone = (ls: Layer[], parent: TileMap | GroupLayer) =>
      ls.forEach((l) => {
        let dest: Layer;
        if (l.isGroupLayer) {
          const g = new GroupLayer(l.name);
          dest = g;
          parent.addLayer(g);
          clone((l as GroupLayer).layers, g);
        } else if (l.isTileLayer) {
          const tl = new TileLayer(l.name);
          dest = tl;
          tl.size = copy.size;
          parent.addLayer(tl);
          const edit = tl.edit();
          for (let y = r.y; y < r.y + r.height; y++)
            for (let x = r.x; x < r.x + r.width; x++)
              edit.setTile(
                x - ox,
                y - oy,
                (l as TileLayer).tileAt(x, y),
                (l as TileLayer).flagsAt(x, y),
              );
          edit.apply();
        } else if (l.isObjectLayer) {
          const group = new ObjectGroup(l.name);
          dest = group;
          group.drawOrder = (l as ObjectGroup).drawOrder;
          group.color = (l as ObjectGroup).color;
          parent.addLayer(group);
          for (const o of (l as ObjectGroup).objects) {
            // Keep intersecting geometry; use conservative bounds for rotated objects.
            const corners = [
              m.pixelToTile(o.x, o.y),
              m.pixelToTile(o.x + o.width, o.y + o.height),
              ...o.polygon.map((p) => m.pixelToTile(o.x + p.x, o.y + p.y)),
            ];
            const minX = Math.min(...corners.map((p) => p.x)),
              maxX = Math.max(...corners.map((p) => p.x)),
              minY = Math.min(...corners.map((p) => p.y)),
              maxY = Math.max(...corners.map((p) => p.y));
            if (
              o.rotation === 0 &&
              (maxX < r.x ||
                minX >= r.x + r.width ||
                maxY < r.y ||
                minY >= r.y + r.height)
            )
              continue;
            const n = new MapObject(),
              pos = translate(o.x, o.y);
            n.name = o.name;
            n.className = o.className;
            n.x = pos.x;
            n.y = pos.y;
            n.width = o.width;
            n.height = o.height;
            n.rotation = o.rotation;
            n.shape = o.shape;
            n.polygon = o.polygon;
            n.text = o.text;
            n.font = o.font;
            n.textColor = o.textColor;
            n.visible = o.visible;
            n.tile = o.tile;
            n.tileFlippedHorizontally = o.tileFlippedHorizontally;
            n.tileFlippedVertically = o.tileFlippedVertically;
            group.addObject(n);
          }
        } else {
          const src = l as ImageLayer,
            n = new ImageLayer(l.name);
          dest = n;
          n.image = src.image;
          n.repeatX = src.repeatX;
          n.repeatY = src.repeatY;
          parent.addLayer(n);
        }
        dest.visible = l.visible;
        dest.opacity = l.opacity;
        dest.tintColor = l.tintColor;
        dest.offset = l.isImageLayer
          ? Qt.point(
              l.offset.x + newOrigin.x - screenOrigin.x,
              l.offset.y + newOrigin.y - screenOrigin.y,
            )
          : l.offset;
      });
    clone(m.layers, copy);
    const image = copy.toImage(Qt.size(1024, 1024));
    return {
      png: Base64.encode(image.saveToData("PNG")),
      region: r,
      scope: "map-region",
      note: "Bounded Tiled render; even-cell padding preserves stagger parity",
      width: image.width,
      height: image.height,
    };
  }
}
