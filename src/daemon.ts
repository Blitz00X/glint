import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { callerFor } from "./identity.js";
import { ensureHome, statePath } from "./paths.js";
import {
  DEFAULT_NOTICE_MS,
  type AskInput,
  type AskResult,
  type DaemonInfo,
  type FeedEvent,
  type Notice,
  type NotifyInput,
  type OverlayLayout,
  type OverlaySink,
  type Question,
  type SettleInput,
  GlintError,
  MAX_EVENTS,
  MAX_PENDING,
  PROTOCOL_VERSION,
  parseAskInput,
  parseLayoutInput,
  parseNotifyInput,
  parseSettleInput,
} from "./protocol.js";

export interface DaemonHandle {
  port: number;
  token: string;
  baseUrl: string;
  info: DaemonInfo;
  layout(): OverlayLayout;
  setLayout(layout: OverlayLayout): OverlayLayout;
  pending(): Question[];
  /** Feed history, oldest first. Pass `since` to get only newer events. */
  events(since?: number): FeedEvent[];
  settle(input: SettleInput): { ok: true; result: AskResult } | { ok: false; error: string; status: number };
  /** Ask the overlay to focus the newest panel. */
  focus(): void;
  close(): Promise<void>;
}

export interface CreateDaemonOptions {
  host?: string;
  port?: number;
  token?: string;
  initialLayout?: OverlayLayout;
  /** Write daemon.json here. Omit to keep the daemon unadvertised (tests). */
  stateFile?: string | null;
  sink?: OverlaySink;
  log?: (line: string) => void;
  /** Feed history size. Defaults to MAX_EVENTS (100). */
  maxEvents?: number;
  /** Called with the number of open calls whenever it changes (used for Do Not Disturb). */
  onPendingChange?: (count: number) => void;
}

interface PendingAsk {
  question: Question;
  resolve: (result: AskResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

export async function createDaemon(options: CreateDaemonOptions = {}): Promise<DaemonHandle> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("hex");
  const log = options.log ?? (() => {});
  const asks = new Map<string, PendingAsk>();
  let currentLayout: OverlayLayout = options.initialLayout ?? "deneme1";
  const feed: FeedEvent[] = [];
  const maxEvents = Math.max(1, options.maxEvents ?? MAX_EVENTS);
  let seq = 0;
  const pendingChanged = () => {
    try {
      options.onPendingChange?.(asks.size);
    } catch (error) {
      log(`pending hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  function record(event: Omit<FeedEvent, "seq" | "at">): FeedEvent {
    const full: FeedEvent = { seq: ++seq, at: Date.now(), ...event };
    feed.push(full);
    if (feed.length > maxEvents) feed.splice(0, feed.length - maxEvents);
    try {
      options.sink?.event?.(full);
    } catch (error) {
      log(`overlay feed sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return full;
  }

  function events(since = 0): FeedEvent[] {
    return feed.filter((event) => event.seq > since);
  }

  function setLayout(next: OverlayLayout): OverlayLayout {
    currentLayout = next;
    try {
      options.sink?.layoutChanged?.(currentLayout);
    } catch (error) {
      log(`overlay layout sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return currentLayout;
  }

  function finish(id: string, result: AskResult): boolean {
    const pending = asks.get(id);
    if (!pending || pending.done) return false;
    pending.done = true;
    if (pending.timer) clearTimeout(pending.timer);
    asks.delete(id);
    pendingChanged();
    pending.resolve(result);
    const text =
      result.status === "answered"
        ? (result.answer ?? "")
        : result.status === "timeout"
          ? "no answer (timed out)"
          : result.via === "disconnect"
            ? "call dropped by the agent"
            : "dismissed";
    record({
      type: "answer",
      ref: id,
      caller: pending.question.caller,
      text,
      kind: pending.question.kind,
      status: result.status,
      via: result.via,
    });
    try {
      options.sink?.resolved(id, result);
    } catch (error) {
      log(`overlay sink failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  function settle(input: SettleInput): { ok: true; result: AskResult } | { ok: false; error: string; status: number } {
    const pending = asks.get(input.id);
    if (!pending || pending.done) {
      return { ok: false, error: "no pending question with that id", status: 404 };
    }
    const question = pending.question;
    if (input.status === "dismissed") {
      const result: AskResult = {
        id: question.id,
        status: "dismissed",
        answer: null,
        choiceIndex: null,
        via: "dismiss",
      };
      finish(question.id, result);
      return { ok: true, result };
    }

    if (input.via === "choice" || (input.choiceIndex != null && input.via !== "text")) {
      const index = input.choiceIndex;
      if (index == null || !question.choices[index]) {
        return { ok: false, error: "choiceIndex is out of range", status: 400 };
      }
      const result: AskResult = {
        id: question.id,
        status: "answered",
        answer: question.choices[index],
        choiceIndex: index,
        via: "choice",
      };
      finish(question.id, result);
      return { ok: true, result };
    }

    const answer = input.answer?.trim() ?? "";
    if (!answer) {
      return { ok: false, error: "answer text is required", status: 400 };
    }
    const matched = question.choices.findIndex((choice) => choice === answer);
    const result: AskResult = {
      id: question.id,
      status: "answered",
      answer,
      choiceIndex: matched >= 0 ? matched : null,
      via: "text",
    };
    finish(question.id, result);
    return { ok: true, result };
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) return;
      const status = error instanceof GlintError ? error.status : 500;
      const message = error instanceof Error ? error.message : "internal error";
      sendJson(res, status, { error: message });
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 5_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!authorized(req.headers.authorization, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, {
        ok: true,
        name: "glint",
        version: PROTOCOL_VERSION,
        pending: asks.size,
        pid: process.pid,
        layout: currentLayout,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/layout") {
      sendJson(res, 200, { layout: currentLayout });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/layout") {
      const body = parseLayoutInput(await readJson(req));
      sendJson(res, 200, { layout: setLayout(body.layout) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/picker") {
      if (!options.sink?.openPicker) {
        sendJson(res, 501, { error: "this daemon has no picker window" });
        return;
      }
      options.sink.openPicker();
      sendJson(res, 200, { opened: true });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1/events" || url.pathname === "/v1/feed")) {
      const since = Number(url.searchParams.get("since") ?? "0");
      sendJson(res, 200, { events: events(Number.isFinite(since) ? since : 0), max: maxEvents });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/pending") {
      sendJson(res, 200, { questions: [...asks.values()].map((pending) => pending.question) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/focus") {
      try {
        options.sink?.focus?.();
      } catch (error) {
        log(`overlay focus sink failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/answer") {
      const body = parseSettleInput(await readJson(req));
      const result = settle(body);
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return;
      }
      sendJson(res, 200, result.result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/notify") {
      const input = parseNotifyInput(await readJson(req));
      const notice: Notice = {
        id: randomUUID(),
        message: input.message,
        agent: input.agent ?? "agent",
        project: input.project ?? "",
        durationMs: input.durationMs ?? DEFAULT_NOTICE_MS,
        ...(input.layout ? { layout: input.layout } : {}),
        createdAt: Date.now(),
        caller: callerFor(input),
      };
      record({ type: "notice", ref: notice.id, caller: notice.caller, text: notice.message });
      options.sink?.notice(notice);
      sendJson(res, 200, { id: notice.id, delivered: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/ask") {
      await handleAsk(req, res);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  async function handleAsk(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const input = parseAskInput(await readJson(req));
    if (asks.size >= MAX_PENDING) {
      sendJson(res, 429, { error: `too many pending questions (max ${MAX_PENDING})` });
      return;
    }

    const question = questionFrom(input);
    req.setTimeout(0);
    res.setTimeout(0);

    const result = await new Promise<AskResult>((resolve) => {
      const pending: PendingAsk = { question, resolve, done: false };
      if (question.timeoutMs != null) {
        pending.timer = setTimeout(() => {
          finish(question.id, {
            id: question.id,
            status: "timeout",
            answer: null,
            choiceIndex: null,
            via: "timeout",
          });
        }, question.timeoutMs);
      }
      asks.set(question.id, pending);
      pendingChanged();
      record({
        type: "call",
        ref: question.id,
        caller: question.caller,
        text: question.question,
        kind: question.kind,
        ...(question.choices.length > 0 ? { choices: question.choices } : {}),
      });
      // `res` closes when the client goes away and also after we finish the response.
      res.on("close", () => {
        if (!res.writableFinished) {
          finish(question.id, {
            id: question.id,
            status: "dismissed",
            answer: null,
            choiceIndex: null,
            via: "disconnect",
          });
        }
      });
      try {
        options.sink?.question(question);
      } catch (error) {
        log(`overlay sink failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    if (!res.writableEnded && !res.destroyed) {
      try {
        sendJson(res, 200, result);
      } catch {
        // The client already left.
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new GlintError("daemon failed to bind a TCP port");
  }

  const info: DaemonInfo = {
    pid: process.pid,
    port: address.port,
    token,
    version: PROTOCOL_VERSION,
    startedAt: Date.now(),
  };

  if (options.stateFile) {
    writeState(options.stateFile, info);
  }

  log(`glint daemon listening on ${host}:${info.port}`);

  return {
    port: info.port,
    token,
    baseUrl: `http://${host}:${info.port}`,
    info,
    layout: () => currentLayout,
    setLayout,
    pending: () => [...asks.values()].map((pending) => pending.question),
    events,
    settle,
    focus() {
      try {
        options.sink?.focus?.();
      } catch (error) {
        log(`overlay focus sink failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async close() {
      for (const id of [...asks.keys()]) {
        finish(id, {
          id,
          status: "dismissed",
          answer: null,
          choiceIndex: null,
          via: "disconnect",
        });
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
      if (options.stateFile) removeStateIfOurs(options.stateFile, info);
    },
  };
}

function questionFrom(input: AskInput): Question {
  return {
    id: randomUUID(),
    question: input.question,
    choices: input.choices ?? [],
    agent: input.agent ?? "agent",
    project: input.project ?? "",
    timeoutMs: input.timeoutMs ?? null,
    ...(input.layout ? { layout: input.layout } : {}),
    createdAt: Date.now(),
    kind: input.kind ?? "question",
    caller: callerFor(input),
  };
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function readJson(req: http.IncomingMessage, limit = 262_144): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new GlintError("request body is too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new GlintError("invalid json", 400));
      }
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function writeState(file: string, info: DaemonInfo): void {
  ensureHome(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms that ignore chmod.
  }
}

function removeStateIfOurs(file: string, info: DaemonInfo): void {
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as DaemonInfo;
    if (current.pid === info.pid && current.token === info.token) fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

export function defaultStateFile(): string {
  return statePath();
}
