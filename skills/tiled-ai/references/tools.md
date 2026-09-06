# Tool contract

The server's MCP schemas are authoritative. All tools use snake_case names.

| Tools | Purpose |
| --- | --- |
| `get_editor_state` | Sessions, open documents, active document and capabilities |
| `get_map_info` | Map/tileset metadata and a fresh revision token |
| `list_layers`, `list_tilesets`, `get_objects` | Paginated editor data |
| `get_selection` | Exact rectangles, selected layers and objects |
| `read_region` | Paginated row-major cells in an explicit bounded region |
| `get_tileset_images` | Labeled contact sheet and corresponding tile metadata |
| `get_region_image` | Bounded Tiled-rendered map preview |
| `apply_operations` | Prevalidated operations in one document's Undo macro |
| `apply_structure` | Relative structure constrained to a region and selection |
| `set_tiles`, `replace_tiles`, `fill_region` | Convenience mutation wrappers |
| `create_layer`, `update_layer` | Layer/group creation and common attributes |
| `create_objects`, `update_objects` | Geometry, tile objects and property patches |
| `set_properties` | Typed property patches; `remove` deletes a property |
| `set_tile_collisions` | Replace a tile's collision group in a tileset document |
| `get_request_status` | Recover a mutation outcome |

All document tools require `sessionId` and `documentId`. Read pagination uses `offset`, `limit`, `total` and `nextOffset`; images return the page's tile metadata instead. Image pages contain at most 64 tiles. Ordinary data pages contain at most 256 items. Regions and mutation batches are limited to 16,384 cells. Revision snapshots inspect up to 1,048,576 occupied-region cells and retain up to 32 tokens, evicting older entries earlier to bound memory.

Example `apply_operations` arguments (IDs and revision must come from live reads):

```json
{
  "sessionId": "SESSION",
  "documentId": "DOCUMENT",
  "requestId": "a-new-unique-request-id",
  "expectedRevision": "REVISION",
  "label": "Build facade",
  "operations": [{
    "op": "set_tiles",
    "layerId": 2,
    "cells": [{"x": 6, "y": 10, "tile": {"tilesetId": "TILESET", "tileId": 384, "flags": 0}}]
  }]
}
```

Convenience wrappers accept the same mutation fields and a singular `operation` whose `op` equals the tool name. `apply_structure` adds `origin` and absolute `region` to the batch fields; cells are relative to the origin.

Flags: horizontal flip `1`, vertical flip `2`, anti-diagonal flip / hexagonal rotation `4`, hexagonal 120° rotation `8`. The last flag is rejected for non-hexagonal maps. Tile objects currently accept horizontal/vertical flips only; use their explicit rotation for object rotation.

Writable property types: `string`, `bool`, `int`, `float`, `color`, `file`, `object`, `remove`. Colors use `#RRGGBB` or `#AARRGGBB`. Custom class/enum values are returned with their Tiled type metadata; their writes are unsupported. Numeric reads cannot distinguish an integral float from an integer through Tiled's scripting API; use `float` explicitly when writing such values.

`update_objects` takes `{id, value}` entries. `value` supplies the complete geometry; its supplied properties are patched, not a replacement of all existing properties. Text, rectangle, ellipse, point, polygon, polyline and tile objects are supported. Collision groups accept geometric shapes only.

The bridge retains mutation results for the lifetime of the session. Queued requests expire before dispatch. Dispatched requests may complete after the caller times out. No cross-session exactly-once guarantee is made after process restarts.

## Image and Wang tools

See [terrain.md](terrain.md) for full arguments and workflow.

| Tool | Purpose |
| --- | --- |
| `inspect_tileset_image` | Image preview, hash, dimensions, grid candidates and contextual destination suggestion |
| `create_tileset_from_image` | Import image, create and open a new TSX without overwrite |
| `open_tileset` | Open an existing TSX, including recovery after lost creation response |
| `attach_tileset` | Attach an open tileset to an explicit map with revision and Undo |
| `list_wang_sets` | Read terrain colors, definitions and live set IDs |
| `create_wang_set` | Add a validated definition or exact-image Grass profile |
| `update_wang_set` | Replace a set's complete definition with tileset Undo |
| `save_tileset` | Explicitly write an open TSX and export terrain names |
| `paint_terrain` | Prepare native Wang matches, validate footprint and apply one map Undo |

## Map lifecycle tools

| Tool | Purpose |
| --- | --- |
| `create_map` | Create and open a new TMX from explicit map/tile dimensions, orientation and initial layer names; refuse overwrite |
| `open_map` | Open an existing TMX, including recovery after interruption |
| `save_map` | Save the explicit map with a fresh revision, or export a new copy with `outputPath`; preserve live Undo and never save external tilesets implicitly |
