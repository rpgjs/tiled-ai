// One request per child. Tiled owns the anonymous stdin/stdout pipes; neither
// credentials nor editor data are sent to any TCP listener or process argument.
import { ipcPost, MAX_MESSAGE_BYTES } from "./ipc";
async function main() {
  const [socketPath, path] = process.argv.slice(2);
  if (!["/connect", "/poll", "/result"].includes(path))
    throw Error("Invalid relay route");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const part of process.stdin) {
    size += part.length;
    if (size > MAX_MESSAGE_BYTES) throw Error("Body too large");
    chunks.push(part);
  }
  const response = await ipcPost(
    socketPath,
    path,
    JSON.parse(Buffer.concat(chunks).toString()),
  );
  process.stdout.write(JSON.stringify(response) + "\n");
}
main().catch(() => {
  process.stdout.write(JSON.stringify({ status: 0, body: {} }) + "\n");
  console.error(
    "Private bridge request failed. Check socket permissions and restart/reconnect; do not blindly replay edits.",
  );
  process.exitCode = 1;
});
