# Grass example

The source image is [`[A]Grass_pipo.png` from rpgjs/starter](https://github.com/rpgjs/starter/blob/9156f8af780cf9cfcf00c04d49561c81462d650a/src/tiled/%5BA%5DGrass_pipo.png), pinned at revision `9156f8af780cf9cfcf00c04d49561c81462d650a`. It is preserved as `grass.png`. Exact source URL and SHA-256 are recorded in `sources.json`. The artwork is attributed to Pipoya by its source filename; it retains its authors' terms. This project grants no additional artwork license.

The generated `grass.tsx` uses 32 × 32 tiles, eight columns and eleven blocks of 48 tiles. The verified layout assigns 46 patterns per block; tiles at block offsets 0 and 47 are not Wang assignments. The profile in `packages/protocol/src/terrain.ts` applies only to this exact image hash. It is not a rule for arbitrary images with similar names.

`terrain.tmx` and `terrain.png` demonstrate a rectangular terrain with a hole and two separate islands. The map is created with `create_map`, painted through Tiled's Wang engine and saved with `save_map`, all through MCP. `grass.tsx` and its content-addressed image are portable; the image reference is relative. `grass.png` is also retained as the clearly named generation input.

Reproduce with `npm run demo:grass:assets`, then `node scripts/test-tiled.mjs --terrain --demo`. The generator uses the PNG and built-in verified profile only. `tests/fixtures/grass-reference.tsx` is the upstream companion TSX, retained solely as an independent test oracle. Its URL, revision and hash are recorded in `tests/fixtures/grass-reference.sources.json`; it is never an input to TSX generation.
