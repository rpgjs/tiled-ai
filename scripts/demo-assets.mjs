import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const revision = "9156f8af780cf9cfcf00c04d49561c81462d650a";
const root = "examples/rpgjs";
await mkdir(root, { recursive: true });
const sources = [];
const expected = {
  "base.png":
    "15a73857f1a06b4fc4393483012a849c42e752af88223c19b7536147074c837f",
  "tileset.tsx":
    "305e2b86256f91a0385ffdf86180badfd5214faefe0aa79d44a204a5914f384d",
};
for (const name of ["base.png", "tileset.tsx"]) {
  const url = `https://raw.githubusercontent.com/rpgjs/starter/${revision}/src/tiled/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw Error(`${response.status}: ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== expected[name])
    throw Error("Asset checksum mismatch: " + name);
  const destination = name === "tileset.tsx" ? "base.tsx" : name;
  await writeFile(`${root}/${destination}`, data);
  sources.push({ url, file: destination, sha256 });
}
await writeFile(
  `${root}/sources.json`,
  JSON.stringify(
    { repository: "https://github.com/rpgjs/starter", revision, sources },
    null,
    2,
  ) + "\n",
);
console.log("RPGJS assets acquired at " + revision);
