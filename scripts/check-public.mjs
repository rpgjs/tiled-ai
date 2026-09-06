import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const excluded = new Set(["node_modules", "dist", ".tmp", ".git"]);
export function findings(path, text) {
  const found = [];
  // Construct patterns so the scanner's source does not contain matching examples.
  const personal = new RegExp(
    "(?:/" +
      "home/|/" +
      'Users/)[^/\\s"<>]+/|[A-Za-z]:[\\\\/]' +
      "Users[\\\\/][^\\\\/\\s]+[\\\\/]",
    "g",
  );
  if (personal.test(text)) found.push("personal absolute path");
  if (
    new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----").test(
      text,
    )
  )
    found.push("private key");
  if (
    new RegExp(
      "(?:gh[pousr]_" +
        "[A-Za-z0-9]{30,}|github_pat_" +
        "[A-Za-z0-9_]{50,}|sk-" +
        "[A-Za-z0-9_-]{32,}|AKIA" +
        "[A-Z0-9]{16})",
    ).test(text)
  )
    found.push("credential pattern");
  if (
    /"(?:secret|token|password|access_token|refresh_token)"\s*:\s*"[^"\s]{16,}"/i.test(
      text,
    )
  )
    found.push("literal local credential");
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|tiled-ai\.config\.json|config\.local\.json|core(?:\.\d+)?|[^/]+\.(?:log|pem|key))$/.test(
      path,
    ) &&
    !path.endsWith(".env.example")
  )
    found.push("runtime or private file");
  return found;
}
export async function scan(root) {
  const files = new Set();
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (excluded.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.add(relative(root, p));
      else files.add(relative(root, p));
    }
  }
  await walk(root);
  try {
    for (const p of execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split("\0")
      .filter(Boolean))
      files.add(p);
  } catch {}
  const problems = [];
  for (const file of files) {
    const bytes = await readFile(join(root, file));
    const text = bytes.toString("utf8");
    for (const reason of findings(file, text))
      problems.push(`${file}: ${reason}`);
  }
  return { files: files.size, problems };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await scan(resolve("."));
  if (result.problems.length) {
    console.error(result.problems.join("\n"));
    process.exitCode = 1;
  } else console.log(`Public-file check passed (${result.files} files).`);
}
