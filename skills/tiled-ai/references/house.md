# RPGJS house example

Use this recipe only with the `base.png` atlas from `rpgjs/starter` at revision `9156f8af780cf9cfcf00c04d49561c81462d650a`. It has 1,000 tiles of 32×32 pixels. Inspect the live image page to confirm the atlas before using these IDs.

The supplied map is 32×24 cells. Layers are Ground (1), House (2), Decoration (3), Collisions (4). For the demonstration, select `{x:4,y:4,width:12,height:14}` and use `{x:4,y:4}` as the structure origin. In other maps resolve layer IDs from `list_layers`.

Observed roles: roof 579/587, white facade 384/392, door 391/399, window 596/604, path 5, tree quadrants 8/9/16/17, flowers 52–55, bush 40. Keep these associations out of general tile-selection logic.

Place the 8-cell-wide house at relative cells (2,2) through (9,8), with the roof above the facade and the door at relative x=5. Lead the path south from the door. Place trees and flowers without covering the entrance. Use separate collision rectangles for the body and facade sides, leaving the door gap.

The repository's `scripts/house.mjs` is a deterministic example plan, not a general house generator. `node scripts/test-tiled.mjs --demo` applies that plan through MCP in an isolated Tiled instance and verifies Undo/Redo. `examples/rpgjs/start.tmx`, `house.tmx` and `house.png` show its input and output.
