import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import http from "node:http";
import { homedir } from "node:os";

export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export function requireUnix() {
  if (process.platform === "win32")
    throw Error(
      "Native Windows IPC is not supported. Run Node and Linux Tiled together inside WSL; TCP fallback is disabled.",
    );
}

// Resolve system aliases (e.g. macOS /tmp) only when creating our own directory.
// Configured endpoints must already be canonical: never follow a supplied symlink.
export async function createEndpoint(parent = homedir()) {
  requireUnix();
  const directory = await mkdtemp(join(await realpath(parent), ".tiled-ai-"));
  return join(directory, "bridge.sock");
}

export async function validateEndpoint(socketPath: string) {
  requireUnix();
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath) > 100
  )
    throw Error(
      "Invalid private socket path (use an absolute canonical path of at most 100 bytes)",
    );
  const uid = process.getuid!();
  const parent = dirname(socketPath);
  for (let path = parent; ; path = dirname(path)) {
    const st = await lstat(path);
    if (
      !st.isDirectory() ||
      (st.uid !== uid && st.uid !== 0) ||
      (path === parent
        ? st.uid !== uid || (st.mode & 0o777) !== 0o700
        : (st.mode & 0o022) !== 0 && !(st.uid === 0 && st.mode & 0o1000))
    )
      throw Error(
        "Unsafe IPC directory: require an owned 0700 directory and trusted, non-symlink ancestors",
      );
    if (dirname(path) === path) break;
  }
  try {
    const st = await lstat(socketPath);
    if (!st.isSocket() || st.uid !== uid || (st.mode & 0o077) !== 0)
      throw Error(
        "Unsafe IPC endpoint: require an owned private socket, never a symlink",
      );
    return true;
  } catch (e: any) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

export async function ipcPost(
  socketPath: string,
  path: string,
  body: unknown,
  timeout = 40000,
  headers: Record<string, string> = {},
) {
  await validateEndpoint(socketPath);
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
    throw Error("Body too large");
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        signal: AbortSignal.timeout(timeout),
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MESSAGE_BYTES)
            res.destroy(Error("Response too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch {
            reject(Error("Invalid bridge response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
