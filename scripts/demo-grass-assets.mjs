import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const revision = "9156f8af780cf9cfcf00c04d49561c81462d650a";
const url = `https://raw.githubusercontent.com/rpgjs/starter/${revision}/src/tiled/%5BA%5DGrass_pipo.png`;
const response = await fetch(url);
if (!response.ok) throw Error(`Asset download failed: ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(data).digest("hex");
if (
  sha256 !== "ae3dfaa489a3daaed25ca9fa7d708cf428784d2840f49057bdd2489dc655ad08"
)
  throw Error("Grass image checksum mismatch");
await mkdir("examples/grass", { recursive: true });
await writeFile("examples/grass/grass.png", data);
await writeFile(
  "examples/grass/sources.json",
  JSON.stringify(
    {
      repository: "https://github.com/rpgjs/starter",
      revision,
      sources: [{ file: "grass.png", url, sha256 }],
    },
    null,
    2,
  ) + "\n",
);
console.log("Grass PNG acquired and verified; no companion TSX was used.");
