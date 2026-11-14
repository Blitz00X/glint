import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { ensureHome, glintHome, lockPath, logPath, packageRoot, statePath } from "./paths.js";
import {
  type AskInput,
  type AskResult,
  type DaemonInfo,
  type FeedEvent,
  type NotifyInput,
  type NotifyResult,
  type OverlayLayout,
  GlintError,
  PROTOCOL_VERSION,
} from "./protocol.js";

export interface ClientOptions {
  home?: string;
  /** Start the overlay daemon when it is not already running. Defaults to true. */
  spawn?: boolean;
  signal?: AbortSignal;
  noSandbox?: boolean;
}

export async function askUser(input: AskInput, options: ClientOptions = {}): Promise<AskResult> {
  const info = await ensureDaemon(options);
  return postJson<AskResult>(info, "/v1/ask", input, options.signal);
}

export async function notifyUser(input: NotifyInput, options: ClientOptions = {}): Promise<NotifyResult> {
  const info = await ensureDaemon(options);
  return postJson<NotifyResult>(info, "/v1/notify", input, options.signal);
}

export async function getEvents(since = 0, options: ClientOptions = {}): Promise<FeedEvent[]> {
  const info = await ensureDaemon(options);
  const res = await requestJson<{ events: FeedEvent[] }>(info, "GET", `/v1/events?since=${since}`, undefined, options.signal);
  return res.events;
}

export async function daemonStatus(home = glintHome()): Promise<DaemonInfo | null> {
  return readHealthy(home);
}

export async function getDaemonLayout(options: ClientOptions = {}): Promise<OverlayLayout> {
  const info = await ensureDaemon(options);
  const res = await requestJson<{ layout: OverlayLayout }>(info, "GET", "/v1/layout", undefined, options.signal);
  return res.layout;
}

export async function setDaemonLayout(layout: OverlayLayout, options: ClientOptions = {}): Promise<OverlayLayout> {
  const info = await ensureDaemon(options);
  const res = await postJson<{ layout: OverlayLayout }>(info, "/v1/layout", { layout }, options.signal);
  return res.layout;
}

export async function openPicker(options: ClientOptions = {}): Promise<boolean> {
  const info = await ensureDaemon(options);
  const res = await postJson<{ opened: boolean }>(info, "/v1/picker", {}, options.signal);
  return res.opened === true;
}

export async function ensureDaemon(options: ClientOptions = {}): Promise<DaemonInfo> {
  const home = glintHome(options.home);
  const existing = await readHealthy(home);
  if (existing) return existing;
  if (options.spawn === false) {
    throw new GlintError("Glint daemon is not running. Start it with `glint daemon`.", 503);
  }

  const locked = acquireLock(home);
  if (!locked) {
    const waited = await pollHealthy(home, 20_000);
    if (waited) return waited;
    throw new GlintError("Glint daemon did not become ready while another launch was in progress.", 503);
  }

  try {
    const again = await readHealthy(home);
    if (again) return again;
    const info = await launchOverlay(home, options.noSandbox === true || process.env.GLINT_NO_SANDBOX === "1");
    return info;
  } finally {
    releaseLock(home);
  }
}

async function launchOverlay(home: string, noSandbox: boolean): Promise<DaemonInfo> {
  const first = spawnElectron(home, noSandbox);
  const ready = await waitForReady(home, first.exited, 12_000);
  if (ready !== "exited" && ready !== "timeout") return ready;

  const log = tail(logPath(home));
  const sandboxFailed = !noSandbox && (ready === "exited" || looksLikeSandboxFailure(log));
  if (sandboxFailed) {
    killPid(first.pid);
    const retry = spawnElectron(home, true);
    const second = await waitForReady(home, retry.exited, 12_000);
    if (second !== "exited" && second !== "timeout") return second;
    killPid(retry.pid);
    throw new GlintError(
      `Glint overlay failed to start even without the Chromium sandbox.\n${tail(logPath(home))}`,
      503,
    );
  }

  killPid(first.pid);
  throw new GlintError(
    `Glint overlay failed to start. Is a graphical session available?\n${log || "(no daemon log)"}`,
    503,
  );
}

function spawnElectron(home: string, noSandbox: boolean): { pid: number | undefined; exited: Promise<number | null> } {
  ensureHome(home);
  const bin = electronBinary();
  const root = packageRoot();
  const platformArgs = process.platform === "linux" ? ["--ozone-platform=x11"] : [];
  const args = noSandbox
    ? ["--no-sandbox", "--disable-setuid-sandbox", ...platformArgs, root]
    : [...platformArgs, root];
  const logFile = logPath(home);
  fs.appendFileSync(logFile, `\n--- spawn noSandbox=${noSandbox} ${new Date().toISOString()} ---\n`);
  const logFd = fs.openSync(logFile, "a");
  const env = cleanEnv();
  const child = spawn(bin, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: root,
    env: {
      ...env,
      DISPLAY: env.DISPLAY || ":0",
      GLINT_HOME: home,
      GLINT_NO_SANDBOX: noSandbox ? "1" : "",
    },
  });
  child.unref();
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return { pid: child.pid, exited };
}

export function runDaemonForeground(noSandbox: boolean): void {
  const bin = electronBinary();
  const root = packageRoot();
  const platformArgs = process.platform === "linux" ? ["--ozone-platform=x11"] : [];
  const args = noSandbox
    ? ["--no-sandbox", "--disable-setuid-sandbox", ...platformArgs, root]
    : [...platformArgs, root];
  const child = spawn(bin, args, {
    stdio: "inherit",
    cwd: root,
    env: { ...cleanEnv(), DISPLAY: process.env.DISPLAY || ":0" },
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const resolved = require("electron") as unknown;
  if (typeof resolved !== "string") {
    throw new GlintError("Could not resolve the Electron binary. Run npm install in the glint repo.");
  }
  return resolved;
}

async function waitForReady(
  home: string,
  exited: Promise<number | null>,
  timeoutMs: number,
): Promise<DaemonInfo | "exited" | "timeout"> {
  let exitCode: number | null | undefined;
  void exited.then((code) => {
    exitCode = code;
  });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exitCode !== undefined) return "exited";
    const info = await readHealthy(home);
    if (info) return info;
    await delay(120);
  }
  return exitCode !== undefined ? "exited" : "timeout";
}

async function pollHealthy(home: string, timeoutMs: number): Promise<DaemonInfo | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await readHealthy(home);
    if (info) return info;
    await delay(150);
  }
  return null;
}

/** Daemon info plus its live layout and open-call count, or null when it is down. Never starts it. */
export async function daemonHealth(home = glintHome()): Promise<(DaemonInfo & { layout?: string; pending?: number }) | null> {
  const info = await readHealthy(home);
  if (!info) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(800),
    });
    const body = (await response.json()) as { layout?: string; pending?: number };
    return { ...info, layout: body.layout, pending: body.pending };
  } catch {
    return info;
  }
}

export async function readHealthy(home: string): Promise<DaemonInfo | null> {
  let info: DaemonInfo;
  try {
    info = JSON.parse(fs.readFileSync(statePath(home), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
  if (!info || info.version !== PROTOCOL_VERSION || typeof info.port !== "number" || typeof info.token !== "string") {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    return info;
  } catch {
    return null;
  }
}

async function postJson<T>(info: DaemonInfo, pathname: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(info, "POST", pathname, body, signal);
}

async function requestJson<T>(
  info: DaemonInfo,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${info.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    response = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GlintError(`Lost contact with the Glint daemon: ${message}`, 503);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text || `Glint daemon returned HTTP ${response.status}`;
    throw new GlintError(message, response.status);
  }
  return parsed as T;
}

function acquireLock(home: string): boolean {
  ensureHome(home);
  const file = lockPath(home);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    try {
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
      if (!pidAlive(current.pid)) {
        fs.unlinkSync(file);
        return acquireLock(home);
      }
    } catch {
      return false;
    }
    return false;
  }
}

function releaseLock(home: string): void {
  const file = lockPath(home);
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
    if (current.pid === process.pid) fs.unlinkSync(file);
  } catch {
    // Another launcher already cleared it.
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function looksLikeSandboxFailure(log: string): boolean {
  return /sandbox|namespace|chrome-sandbox|zygote/i.test(log);
}

function tail(file: string, max = 2_400): string {
  try {
    const data = fs.readFileSync(file, "utf8");
    return data.slice(-max).trim();
  } catch {
    return "";
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
