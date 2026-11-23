import fs from "node:fs";
import path from "node:path";
import { glintHome } from "./paths.js";

/** Delivery is resolved per call; only executable and option positions are inspected. */
export type DeliveryMode = "ring" | "notify" | "off";
export interface DeliveryDecision {
  mode: DeliveryMode;
  reason?: string;
}

export interface ProcessSnapshot {
  comm: string;
  ppid: number;
  argv: string[];
}

export interface SuppressOptions {
  env?: NodeJS.ProcessEnv;
  /** Where the walk starts. Defaults to the parent of this process. */
  ppid?: number;
  /** Read one process; null when it is gone or unreadable. */
  proc?: (pid: number) => ProcessSnapshot | null;
}

export interface SuppressDecision {
  suppressed: boolean;
  reason?: string;
}

function baseName(token: string): string {
  return token.split(/[\\/]/).pop() ?? token;
}

/** Read comm, ppid and argv for one pid. Linux /proc only; null elsewhere. */
export function readProcess(pid: number): ProcessSnapshot | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    let argv: string[] = [];
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {}
    return { comm, ppid, argv };
  } catch {
    return null;
  }
}

/**
 * True for the gateway process itself: `takopi`, `python …/takopi`,
 * `uv run takopi`. Only executable positions are inspected, so an agent prompt
 * that merely contains the word "takopi" never matches.
 */
export function isTakopiProcess(entry: ProcessSnapshot): boolean {
  if (baseName(entry.comm).toLowerCase() === "takopi") return true;
  if (entry.argv.slice(0, 2).some((arg) => baseName(arg).toLowerCase() === "takopi")) return true;
  const sub = entry.argv[1];
  return (sub === "-m" || sub === "run") && baseName(entry.argv[2] ?? "").toLowerCase() === "takopi";
}

export const SUPPRESS_SESSIONS_FILE = "suppress-sessions";

/**
 * A file of session ids, one per line (blank lines and `#` comments ignored),
 * mutes Glint for those sessions even when neither the process tree nor the
 * environment can tell where they came from. Escape hatch for shared servers.
 */
export function sessionSuppressed(
  session: string,
  options: { home?: string; read?: (file: string) => string | null } = {},
): boolean {
  if (!session.trim()) return false;
  const file = path.join(options.home ?? glintHome(), SUPPRESS_SESSIONS_FILE);
  let text: string;
  try {
    text = (options.read ?? ((f: string) => fs.readFileSync(f, "utf8")))(file) ?? "";
  } catch {
    return false;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#") && line === session.trim());
}

/**
 * Stop scanning at the first positional argument or `--`: subsequent text is
 * a prompt, not flags. Skip known option values even if they look like flags.
 * Unknown options fail open rather than treating their values as commands.
 */
export function isHeadlessProcess(entry: ProcessSnapshot): boolean {
  const argv = entry.argv;
  const first = baseName(argv[0] ?? "").toLowerCase();
  const runtime = /^(node|nodejs|bun|python[0-9.]*)$/.test(first);
  const index = runtime ? 1 : 0;
  const executable = baseName(argv[index] ?? "").toLowerCase().replace(/\.(?:js|mjs|cjs)$/, "");
  const flags: Record<string, string[]> = {
    claude: ["-p", "--print"], agy: ["-p", "--print"], gemini: ["-p", "--prompt"],
  };
  const command = executable === "codex" ? "exec" : executable === "opencode" ? "run" : undefined;
  if (!command && !flags[executable]) return false;
  const valued = new Set([
    "-c", "--config", "-C", "--cd", "--cwd", "-m", "--model", "--profile", "--provider",
    "--session", "--session-id", "--resume", "--permission-mode", "--output-format", "--input-format",
    "--system-prompt", "--append-system-prompt", "--settings", "--allowedTools", "--disallowedTools",
    "--sandbox", "--ask-for-approval", "-a", "--add-dir", "--directory", "--agent", "--log-level",
  ]);
  const switches = new Set([
    "--json", "--verbose", "--debug", "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-skip-permissions", "--yolo", "--continue", "--skip-git-repo-check",
  ]);
  for (let i = index + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return false;
    if (command && arg === command) return true;
    const flag = arg.split("=", 1)[0];
    if (flags[executable]?.includes(flag)) return true;
    if (valued.has(flag)) {
      if (!arg.includes("=")) i++;
      continue;
    }
    if (switches.has(arg)) continue;
    return false;
  }
  return false;
}

/**
 * OpenMausBot runs its bots (and its own memory/triage jobs) as child harness
 * processes such as `opencode acp`. Their replies already show in the
 * OpenMausBot window, so Glint stays silent for anything it spawned.
 */
export function isOpenMausBotProcess(entry: ProcessSnapshot): boolean {
  const names = [entry.comm, ...entry.argv.slice(0, 1)].map((v) => baseName(v ?? "").toLowerCase());
  return names.some((name) => name === "openmausbot" || name === "openmausbot.appimage");
}

/** Explicit suppression and Takopi always stay silent, including with GLINT_MODE. */
export function glintDeliveryMode(options: SuppressOptions = {}): DeliveryDecision {
  const env = options.env ?? process.env;
  if (env.GLINT_SUPPRESS === "1") return { mode: "off", reason: "GLINT_SUPPRESS=1" };
  if ((env.AGENTOS_TRANSPORT ?? "").trim().toLowerCase() === "takopi") {
    return { mode: "off", reason: "AGENTOS_TRANSPORT=takopi" };
  }
  const explicit = env.GLINT_MODE;
  let headless = false;
  if (process.platform === "linux" || options.proc) {
    const proc = options.proc ?? readProcess;
    let pid = options.ppid ?? process.ppid;
    for (let i = 0; i < 24 && pid > 1; i++) {
      const entry = proc(pid);
      if (!entry) break;
      if (isTakopiProcess(entry)) return { mode: "off", reason: "takopi ancestor" };
      if (isOpenMausBotProcess(entry)) return { mode: "off", reason: "openmausbot ancestor" };
      headless ||= isHeadlessProcess(entry);
      pid = entry.ppid;
    }
  }
  if (explicit === "ring" || explicit === "notify" || explicit === "off") {
    return { mode: explicit, reason: `GLINT_MODE=${explicit}` };
  }
  return headless ? { mode: "off", reason: "headless ancestor" } : { mode: "ring" };
}

/** Backward-compatible boolean view of the delivery decision. */
export function glintSuppressed(options: SuppressOptions = {}): SuppressDecision {
  const { mode, reason } = glintDeliveryMode(options);
  return { suppressed: mode === "off", ...(reason ? { reason } : {}) };
}
