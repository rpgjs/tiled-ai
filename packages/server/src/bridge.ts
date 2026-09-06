import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  VERSION,
  toolSchemas,
  stable,
  RpcError,
  type RpcResult,
} from "../../protocol/src/index";
interface Entry {
  signature: string;
  command: unknown;
  state: "queued" | "dispatched" | "completed";
  result?: RpcResult;
  waiters: ((r: RpcResult) => void)[];
  expires: number;
}
interface Session {
  id: string;
  lastSeen: number;
  queue: Entry[];
  entries: Map<string, Entry>;
  poll?: http.ServerResponse;
  pollTimer?: ReturnType<typeof setTimeout>;
}
export class Bridge {
  clientCall?: (method: string, input: unknown) => Promise<unknown>;
  onStop?: () => void;
  readonly sessions = new Map<string, Session>();
  readonly server: http.Server;
  constructor(
    private token: string,
    private timeoutMs = 30000,
  ) {
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((e) => {
        if (!res.headersSent) this.send(res, 400, { error: String(e) });
        else res.end();
      });
    });
  }
  async listen(port: number) {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
    return (this.server.address() as { port: number }).port;
  }
  async close() {
    for (const s of this.sessions.values()) {
      clearTimeout(s.pollTimer);
      s.poll?.end();
      for (const e of s.entries.values())
        e.waiters.splice(0).forEach((f) =>
          f({
            id: (e.command as any).id,
            ok: false,
            error: { code: "BRIDGE_CLOSED", message: "Bridge stopped" },
          }),
        );
    }
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private send(res: http.ServerResponse, status: number, value: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + this.token);
    if (
      req.method !== "POST" ||
      req.headers.origin ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      ) ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      this.send(res, 403, { error: "Forbidden" });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const part of req) {
      size += part.length;
      if (size > 32 * 1024 * 1024) {
        this.send(res, 413, { error: "Body too large" });
        return;
      }
      chunks.push(part);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/health" && this.clientCall) {
      this.send(res, 200, {
        service: "tiled-ai-shared-bridge",
        version: 1,
        pid: process.pid,
      });
      return;
    }
    if (req.url === "/stop" && this.onStop) {
      this.send(res, 200, { stopping: true });
      setImmediate(this.onStop);
      return;
    }
    if (req.url === "/mcp-call" && this.clientCall) {
      try {
        this.send(res, 200, {
          ok: true,
          result: await this.clientCall(body.method, body.input),
        });
      } catch (e) {
        this.send(res, 200, {
          ok: false,
          error: {
            code: e instanceof RpcError ? e.code : "INVALID_REQUEST",
            message: e instanceof Error ? e.message : String(e),
            details: e instanceof RpcError ? e.details : undefined,
          },
        });
      }
      return;
    }
    if (req.url === "/connect") {
      if (body.version !== VERSION) {
        this.send(res, 400, { error: "Protocol version mismatch" });
        return;
      }
      let s = this.sessions.get(body.previousSessionId);
      if (!s) {
        if (this.sessions.size >= 8) {
          this.send(res, 429, {
            error: "Session limit reached; restart bridge",
          });
          return;
        }
        s = {
          id: randomUUID(),
          lastSeen: Date.now(),
          queue: [],
          entries: new Map(),
        };
        this.sessions.set(s.id, s);
      }
      s.lastSeen = Date.now();
      // A surviving extension retains its result cache. Re-deliver only to that
      // same session so a lost POST response can be recovered without reapplying.
      if (body.previousSessionId === s.id) {
        clearTimeout(s.pollTimer);
        if (s.poll) this.send(s.poll, 200, {});
        s.poll = undefined;
        for (const e of s.entries.values())
          if (e.state === "dispatched") {
            e.expires = Infinity;
            if (!s.queue.includes(e)) s.queue.push(e);
          }
      }
      this.send(res, 200, { sessionId: s.id });
      return;
    }
    const s = this.sessions.get(body.sessionId);
    if (!s) {
      this.send(res, 404, { error: "Session not found" });
      return;
    }
    s.lastSeen = Date.now();
    if (req.url === "/poll") {
      if (s.poll) {
        this.send(res, 409, { error: "A poll is already active" });
        return;
      }
      s.poll = res;
      s.pollTimer = setTimeout(() => {
        if (s.poll === res) {
          s.poll = undefined;
          this.send(res, 200, {});
        }
      }, 20000);
      res.on("close", () => {
        if (s.poll === res) {
          s.poll = undefined;
          clearTimeout(s.pollTimer);
        }
      });
      this.dispatch(s);
      return;
    }
    if (req.url === "/result") {
      const e = s.entries.get(body.id);
      if (
        !e ||
        e.state === "queued" ||
        typeof body.ok !== "boolean" ||
        (!body.ok && (!body.error || typeof body.error.code !== "string"))
      ) {
        this.send(res, 400, { error: "Invalid result" });
        return;
      }
      if (e.state !== "completed") {
        e.state = "completed";
        e.result = {
          id: body.id,
          ok: body.ok,
          result: body.result,
          error: body.error,
        };
        e.waiters.splice(0).forEach((f) => f(e.result!));
      }
      this.send(res, 200, { accepted: true });
      return;
    }
    this.send(res, 404, { error: "Unknown endpoint" });
  }
  private dispatch(s: Session) {
    while (s.poll && s.queue.length) {
      const e = s.queue.shift()!;
      if (e.state === "completed") continue;
      if (e.expires < Date.now()) {
        e.state = "completed";
        e.result = {
          id: (e.command as any).id,
          ok: false,
          error: {
            code: "EXPIRED",
            message: "Command expired before dispatch",
          },
        };
        e.waiters.splice(0).forEach((f) => f(e.result!));
        continue;
      }
      const res = s.poll;
      s.poll = undefined;
      clearTimeout(s.pollTimer);
      e.state = "dispatched";
      this.send(res, 200, { command: e.command });
    }
  }
  private session(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new RpcError("SESSION_NOT_FOUND", "Connect Tiled first");
    return s;
  }
  status(sessionId: string, requestId: string) {
    const e = this.session(sessionId).entries.get(requestId);
    return e
      ? {
          state: e.state,
          ...(e.result
            ? { response: e.result }
            : {
                outcome:
                  e.state === "dispatched"
                    ? "unknown until Tiled responds"
                    : "not yet applied",
              }),
        }
      : {
          state: "unknown",
          note: "Do not assume a mutation was not applied after a server restart",
        };
  }
  async call(method: string, input: unknown): Promise<unknown> {
    if (!toolSchemas[method]) throw new RpcError("UNKNOWN_METHOD", method);
    const p = toolSchemas[method].parse(input);
    if (method === "get_request_status")
      return this.status(p.sessionId, p.requestId);
    if (method === "get_editor_state") {
      const sessions = Array.from(this.sessions.values()).filter(
        (s) => Date.now() - s.lastSeen < 60000,
      );
      return {
        sessions: await Promise.all(
          sessions.map(async (s) => {
            try {
              return await this.invoke(s, method, p);
            } catch (e) {
              return { sessionId: s.id, error: String(e) };
            }
          }),
        ),
      };
    }
    return this.invoke(this.session(p.sessionId), method, p);
  }
  private async invoke(s: Session, method: string, p: any) {
    const id = p.requestId ?? randomUUID(),
      signature = stable({ method, params: p });
    let e = s.entries.get(id);
    if (e && e.signature !== signature)
      throw new RpcError(
        "REQUEST_ID_REUSED",
        "Reuse requires identical method and arguments",
      );
    if (!e) {
      if (Date.now() - s.lastSeen > 60000)
        throw new RpcError("DISCONNECTED", "Reconnect the Tiled extension");
      if (s.entries.size >= 10000)
        throw new RpcError(
          "SESSION_FULL",
          "Restart bridge and reconnect after outstanding edits complete",
        );
      e = {
        signature,
        command: { version: VERSION, id, method, params: p },
        state: "queued",
        waiters: [],
        expires: Date.now() + this.timeoutMs,
      };
      s.entries.set(id, e);
      s.queue.push(e);
      this.dispatch(s);
    }
    let response = e.result;
    if (!response) {
      const entry = e;
      response = await new Promise<RpcResult>((resolve, reject) => {
        const waiter = (v: RpcResult) => {
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => {
          entry.waiters = entry.waiters.filter((f) => f !== waiter);
          reject(
            new RpcError(
              "TIMEOUT",
              "Check get_request_status before retrying",
              { requestId: id, state: entry.state },
            ),
          );
        }, this.timeoutMs);
        entry.waiters.push(waiter);
      });
    }
    if (!p.requestId) s.entries.delete(id);
    if (!response.ok)
      throw new RpcError(
        response.error?.code ?? "EDITOR_ERROR",
        response.error?.message ?? "Editor operation failed",
        response.error?.details,
      );
    return response.result;
  }
}
