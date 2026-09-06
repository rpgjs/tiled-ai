import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import {
  resolve,
  dirname,
  join,
  basename,
  extname,
  isAbsolute,
} from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Bridge } from "./bridge";
import { RpcError, stable, toolSchemas } from "../../protocol/src/index";
import {
  validateGrid,
  suggestedGrids,
  GRASS_SHA256,
  grassDefinition,
} from "../../protocol/src/terrain";
const MAX_BYTES = 16 * 1024 * 1024;
export function imageUrl(source: string) {
  const u = new URL(source);
  if (u.protocol !== "https:" || u.username || u.password)
    throw new RpcError(
      "INVALID_SOURCE",
      "Use a local absolute image path or an HTTPS URL without credentials",
    );
  if (u.hostname === "github.com") {
    const parts = u.pathname.split("/");
    if (parts[3] === "blob") {
      u.hostname = "raw.githubusercontent.com";
      parts.splice(3, 1);
      u.pathname = parts.join("/");
    }
  }
  return u.href;
}
export async function loadImage(source: string) {
  let data: Buffer;
  if (/^https?:/i.test(source)) {
    let url = imageUrl(source);
    let response: Response | undefined;
    for (let n = 0; n < 5; n++) {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new RpcError("INVALID_SOURCE", "Missing redirect location");
        url = imageUrl(new URL(location, url).href);
        continue;
      }
      break;
    }
    if (!response?.ok)
      throw new RpcError("IMAGE_FETCH_FAILED", "Image request did not succeed");
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new RpcError("IMAGE_TOO_LARGE", "Image exceeds 16 MiB");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body as any) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES)
        throw new RpcError("IMAGE_TOO_LARGE", "Image exceeds 16 MiB");
      chunks.push(chunk);
    }
    data = Buffer.concat(chunks);
  } else {
    if (!isAbsolute(source))
      throw new RpcError(
        "INVALID_SOURCE",
        "Local image paths must be absolute",
      );
    if ((await stat(source)).size > MAX_BYTES)
      throw new RpcError("IMAGE_TOO_LARGE", "Image exceeds 16 MiB");
    data = await readFile(source);
  }
  const metadata = await sharp(data, { limitInputPixels: 16777216 }).metadata();
  if (
    !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages ?? 1) > 1
  )
    throw new RpcError(
      "INVALID_IMAGE",
      "Use a non-animated PNG, JPEG or WebP image",
    );
  return {
    data,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format!,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
export class AssetTools {
  private prepared = new Map<
    string,
    { signature: string; promise: Promise<any> }
  >();
  constructor(private bridge: Bridge) {}
  async call(method: string, input: unknown): Promise<unknown> {
    const p = toolSchemas[method].parse(input);
    if (method === "inspect_tileset_image") {
      const im = await loadImage(p.source);
      let suggestedOutputPath: string | null = null;
      if (p.sessionId && p.documentId) {
        const state = (await this.bridge.call("get_editor_state", {})) as any;
        const doc = state.sessions
          .find((s: any) => s.sessionId === p.sessionId)
          ?.documents?.find((d: any) => d.id === p.documentId);
        if (doc?.fileName)
          suggestedOutputPath = join(
            dirname(doc.fileName),
            "tilesets",
            basename(p.source).replace(/\.[^.]+$/, ".tsx"),
          );
      }
      return {
        source: p.source,
        width: im.width,
        height: im.height,
        sha256: im.sha256,
        format: im.format,
        layout: suggestedGrids(im.width, im.height, im.sha256),
        ...(p.grid ? { grid: validateGrid(im.width, im.height, p.grid) } : {}),
        suggestedOutputPath,
        png: (
          await sharp(im.data)
            .resize({
              width: 1024,
              height: 1536,
              fit: "inside",
              withoutEnlargement: true,
              kernel: "nearest",
            })
            .png()
            .toBuffer()
        ).toString("base64"),
      };
    }
    if (method === "create_tileset_from_image") {
      const key = p.sessionId + ":" + p.requestId,
        signature = stable({ method, params: p });
      let entry = this.prepared.get(key);
      if (entry && entry.signature !== signature)
        throw new RpcError(
          "REQUEST_ID_REUSED",
          "Reuse requires identical creation arguments",
        );
      if (!entry) {
        if (this.prepared.size >= 1000)
          throw new RpcError("SESSION_FULL", "Too many file creation requests");
        entry = { signature, promise: this.prepare(p) };
        this.prepared.set(key, entry);
      }
      const normalized = await entry.promise;
      return this.bridge.call(method, normalized);
    }
    if (method === "create_wang_set") {
      if (Boolean(p.definition) === Boolean(p.profile))
        throw new RpcError(
          "INVALID_WANG_SET",
          "Provide exactly one of definition or profile",
        );
      if (p.profile) {
        const info = (await this.bridge.call("get_map_info", {
          sessionId: p.sessionId,
          documentId: p.documentId,
        })) as any;
        const im = await loadImage(info.imageFileName ?? "");
        if (
          im.sha256 !== GRASS_SHA256 ||
          info.tileWidth !== 32 ||
          info.tileHeight !== 32 ||
          info.tileCount !== 528
        )
          throw new RpcError(
            "PROFILE_MISMATCH",
            "This profile only applies to the verified Grass image in its 32x32 grid",
          );
        const { profile, ...args } = p;
        return this.bridge.call(method, {
          ...args,
          definition: grassDefinition(),
        });
      }
    }
    return this.bridge.call(method, p);
  }
  private async prepare(p: any) {
    if (
      !isAbsolute(p.outputPath) ||
      extname(p.outputPath).toLowerCase() !== ".tsx"
    )
      throw new RpcError(
        "INVALID_DESTINATION",
        "outputPath must be an absolute .tsx file path",
      );
    try {
      await stat(p.outputPath);
      throw new RpcError(
        "FILE_EXISTS",
        "Refusing to overwrite an existing TSX; open it instead",
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const im = await loadImage(p.source);
    validateGrid(im.width, im.height, p.grid);
    const directory = dirname(p.outputPath);
    await mkdir(directory, { recursive: true });
    const imagePath = join(
      directory,
      "image-" + im.sha256 + "." + (im.format === "jpeg" ? "jpg" : im.format),
    );
    try {
      await writeFile(imagePath, im.data, { flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (
        createHash("sha256")
          .update(await readFile(imagePath))
          .digest("hex") !== im.sha256
      )
        throw new RpcError(
          "FILE_EXISTS",
          "Destination image differs from the imported image",
        );
    }
    return { ...p, source: imagePath, outputPath: resolve(p.outputPath) };
  }
}
