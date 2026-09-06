# Image-only terrain workflow

## Inspect and decide

Call `inspect_tileset_image` with `source` (absolute local image path or HTTPS URL). GitHub `blob` links are normalized. Supply `sessionId` and `documentId` for a destination suggestion beside a saved document. The tool returns an image, dimensions, hash, layout recognition and candidate grids. Optional `grid` validates exact slicing with margin and spacing.

Known profile `pipoya-grass-48` is restricted to SHA-256 `ae3dfaa489a3daaed25ca9fa7d708cf428784d2840f49057bdd2489dc655ad08`, the pinned RPGJS `[A]Grass_pipo.png`: 256 × 2112 pixels, 32 × 32 tiles, 528 tiles in eleven 48-tile blocks. Each block has 46 Wang assignments, with offsets 0 and 47 unassigned. The profile is verified against an independent reference fixture. A similar filename, dimensions or tile count does not establish this layout.

For unknown images, divisibility only suggests possible grids. Observe repeated boundaries and transparent gutters. If necessary ask: “Are these 16 × 16 or 32 × 32 tiles?” Once the grid is established, create the tileset and inspect `get_tileset_images` pages with labeled IDs. Determine centers, outside/inside corners and edges from the actual pixels. Ask about ambiguous connections or missing artwork. Do not promise complete terrain for an arbitrary sheet.

## Create and define

`create_tileset_from_image` takes `sessionId`, `requestId`, `source`, `outputPath`, `name` and `grid`:

```json
{
  "sessionId": "<session>",
  "requestId": "<unique-request>",
  "source": "/path/to/grass.png",
  "outputPath": "/path/to/project/tilesets/grass.tsx",
  "name": "Grass",
  "grid": {"tileWidth": 32, "tileHeight": 32, "margin": 0, "spacing": 0}
}
```

The source is imported next to the TSX; its image reference is relative. Existing TSX files are refused. A new TSX is saved and opened using Tiled's API. Keep the returned tileset `documentId`, separately from the map document ID.

Read `get_map_info` for the tileset's revision. For the verified image call `create_wang_set` with `profile: "pipoya-grass-48"`. Otherwise provide `definition` (exactly one of profile or definition). Mutations also require `sessionId`, `documentId`, `requestId` and `expectedRevision`:

```json
{
  "definition": {
    "name": "Meadow",
    "type": "mixed",
    "colors": [{"name": "Grass"}],
    "assignments": [{"tileId": 14, "wangId": [1,1,1,1,1,1,1,1]}]
  }
}
```

This sample defines only an interior tile, not a complete paintable set. Tile 14 is specific to the example, not a universal grass ID.

Indices are **top, top-right, right, bottom-right, bottom, bottom-left, left, top-left**. Zero is empty; other values refer to one-based colors. `edge` sets require odd positions to be zero; `corner` sets require even positions to be zero; `mixed` sets permit both. Multiple tile IDs can share the same Wang ID as variants. A tile cannot be assigned twice.

`list_wang_sets` returns stable live set IDs. On a map, also specify `tilesetId`. `update_wang_set` takes `wangSetId` and a complete replacement `definition`; omitted assignments are cleared. References, definitions and revisions are checked before editing. Changes use the tileset's own Undo macro.

Tiled 1.12.2 has a native Undo/Redo crash involving color-count changes followed by color renaming. The extension stores logical names in `tiled-ai:terrain-names`, an undoable property; `save_tileset` exports standard TSX color names. Native labels update after reopening. Explain this if labels appear blank; do not attempt repeated renaming as a repair.

## Create a map

If there is no suitable map, call `create_map` with `sessionId`, a unique `requestId`, absolute `.tmx` `outputPath`, `width`/`height` in cells and `tileWidth`/`tileHeight` in pixels. Choose cell dimensions from the requested scene and tile dimensions from the inspected grid. Example: a 24 × 20 map with 32 × 32 tiles and `layers: ["Ground", "Terrain"]`. Defaults are orthogonal, finite and one Ground layer. Ask for a destination when the request and saved documents provide no context.

Creation writes a new blank TMX and opens it; it refuses an existing file. Keep its returned `documentId` independently of the tileset document. Inspect `list_layers` to obtain actual IDs. Existing tileset and terrain tools then apply without test-only controls.

For staggered/hexagonal maps, provide the intended `staggerAxis`/`staggerIndex`; hexagonal maps need a valid positive `hexSideLength`. Creation supports all four orientations, while terrain painting retains its documented square-topology limitation.

## Attach, paint and verify

`attach_tileset` targets the map's document/revision and takes the open `tilesetDocumentId`. It returns the attached `tilesetId` and uses map Undo. Attaching an already attached tileset is a no-op. Refresh map info and list the attached Wang sets afterward.

`paint_terrain` takes the map mutation fields, `layerId`, `tilesetId`, `wangSetId`, `colorId` and a cell `region`. Optional `cells` specifies an exact footprint; otherwise the footprint is the region intersected with the active selection. Keep the selection's holes and separate components. Object coordinates are unrelated to these integer cell coordinates.

The painter prepares with Tiled's Wang engine, verifies every produced cell and applies one map Undo macro. Orthogonal and isometric square-cell topology is supported. Staggered/hexagonal maps return an explicit unsupported-orientation error. Transformed neighbors are rejected. Neighbor constraints must be satisfied without changing cells outside the authorized footprint. `BOUNDARY_CONFLICT` requires inspecting the neighbors and adjusting the intended footprint within the user's scope. Do not automatically expand the selection.

`MISSING_WANG_PATTERN` means the image/definition cannot represent a required combination. Inspect the returned Wang ID, consult the images, and add a genuinely observed missing pattern or explain the limitation. The Grass profile cannot represent an isolated single-cell island. Do not erase failed cells, invent tile IDs or leave silent holes.

Read the affected region and inspect `get_region_image`. A Grass recipe is an 8 × 8 footprint with a 2 × 2 hole, plus two separate 3 × 3 islands. Use a separate ground layer. The reproducible example is in `examples/grass`; its generator never reads the upstream TSX as input.

## Save and recover

`save_tileset` is a separate explicit file write using the tileset document's current revision. Document Undo does not revert the saved file. The map is never saved by terrain painting. To deliver a saved TMX, call `save_map` with the map target, fresh revision and unique request ID. It saves the associated TMX and preserves Undo. Save the external tileset separately when needed. An optional different `outputPath` writes a new copy without retargeting the source document or clearing its modified flag. Existing copy destinations are refused. Report `savedCopy` and `modified` accurately.

If a map creation response is lost, use the same status/retry rules as TSX creation. After restart, inspect the destination and open documents; use `open_map` on an existing TMX. File creation and opening are separate reported stages. Never replace an existing file just to recover an interrupted workflow.

If a creation response is lost, inspect `get_request_status` before retrying with the same ID and identical arguments. Creation reports file creation and document opening separately; `attach_tileset` is a later mutation. After a process restart, inspect the destination and open documents, use `open_tileset` with `sessionId`, `requestId` and absolute `path` for an existing TSX, then inspect attachment. Never overwrite an existing file to recover a lost response. A downloaded image can remain after a failed creation.

On revision conflict, re-read the changed document and reconsider the edit. On partial application or save error, inspect returned stage details and actual state; do not replay a whole sequence blindly.
