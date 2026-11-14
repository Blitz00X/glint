import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, readConfig, resolveStartLayout } from "./config.js";
import { HARNESSES, type Harness } from "./hooks.js";
import { glintHome } from "./paths.js";
import type { DaemonInfo } from "./protocol.js";

export type CheckLevel = "ok" | "warn" | "fail" | "info";

export interface Check {
  level: CheckLevel;
  label: string;
  detail: string;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Where each harness keeps the pieces `glint install` writes (global install). */
export function harnessFiles(harness: Harness, home: string): { mcp: string[]; hook: string[]; rule: string } {
  switch (harness) {
    case "claude":
      return { mcp: [path.join(home, ".claude.json")], hook: [path.join(home, ".claude", "settings.json")], rule: path.join(home, ".claude", "CLAUDE.md") };
    case "codex":
      return { mcp: [path.join(home, ".codex", "config.toml")], hook: [path.join(home, ".codex", "hooks.json")], rule: path.join(home, ".codex", "AGENTS.md") };
    case "agy":
      return {
        mcp: [path.join(home, ".gemini", "config", "mcp_config.json")],
        hook: [path.join(home, ".gemini", "config", "hooks.json")],
        rule: path.join(home, ".gemini", "config", "AGENTS.md"),
      };
    case "opencode":
      return {
        mcp: [path.join(home, ".config", "opencode", "opencode.jsonc"), path.join(home, ".config", "opencode", "opencode.json")],
        hook: [path.join(home, ".config", "opencode", "plugin", "glint.js")],
        rule: path.join(home, ".config", "opencode", "AGENTS.md"),
      };
  }
}

/** Which Glint pieces are present for a harness: MCP server, hook, rule. */
export function harnessStatus(harness: Harness, home: string): { mcp: boolean; hook: boolean; rule: boolean } {
  const files = harnessFiles(harness, home);
  const anyText = (list: string[]) => list.map(read).filter((text): text is string => text != null);
  const mcpTexts = anyText(files.mcp);
  const mcp =
    harness === "codex"
      ? mcpTexts.some((text) => /^\s*\[mcp_servers\.glint\]/m.test(text))
      : mcpTexts.some((text) => /"glint"\s*:\s*\{/.test(text));
  const hookTexts = anyText(files.hook);
  const hook =
    harness === "opencode" ? hookTexts.some((text) => /Glint/.test(text)) : hookTexts.some((text) => text.includes(`hook ${harness} Stop`));
  const rule = (read(files.rule) ?? "").includes("<!-- glint:rule -->");
  return { mcp, hook, rule };
}

export interface DoctorDeps {
  home?: string;
  glintHome?: string;
  env?: NodeJS.ProcessEnv;
  daemon?: () => Promise<(DaemonInfo & { layout?: string; pending?: number }) | null>;
  run?: (cmd: string, args: string[]) => string | null;
  electron?: () => string | null;
}

function defaultRun(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<Check[]> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? os.homedir();
  const gHome = deps.glintHome ?? glintHome();
  const run = deps.run ?? defaultRun;
  const checks: Check[] = [];
  const add = (level: CheckLevel, label: string, detail: string) => checks.push({ level, label, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "fail", "node", `v${process.versions.node}${major >= 20 ? "" : " (Glint needs Node.js 20+)"}`);

  const electron = deps.electron ? deps.electron() : null;
  if (deps.electron) add(electron ? "ok" : "fail", "electron", electron ?? "not found; run npm install in the glint folder");

  if (process.platform === "linux") {
    const display = env.DISPLAY || env.WAYLAND_DISPLAY;
    add(display ? "ok" : "warn", "display", display ? `DISPLAY=${env.DISPLAY ?? ""} WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY ?? ""}` : "no DISPLAY/WAYLAND_DISPLAY; the overlay falls back to :0");
    if (env.WAYLAND_DISPLAY) add("info", "wayland", "the overlay runs through XWayland (--ozone-platform=x11); set GLINT_OZONE_PLATFORM to override");
  }

  const info = deps.daemon ? await deps.daemon().catch(() => null) : null;
  if (deps.daemon) {
    add(info ? "ok" : "warn", "daemon", info ? `running, pid ${info.pid}, port ${info.port}${info.layout ? `, layout ${info.layout}` : ""}${info.pending != null ? `, ${info.pending} open call(s)` : ""}` : "not running (it starts on the first call)");
  }

  const start = resolveStartLayout(env, gHome);
  const saved = readConfig(gHome).layout;
  add("info", "layout", `starts with ${start.layout} (from ${start.source === "env" ? "GLINT_LAYOUT" : start.source === "config" ? "config.json" : "default"})${saved && start.source === "env" ? `; config.json says ${saved} but GLINT_LAYOUT wins` : ""}`);
  try {
    const mode = fs.statSync(configPath(gHome)).mode & 0o777;
    add(mode & 0o077 ? "warn" : "ok", "config.json", `${configPath(gHome)} mode ${mode.toString(8)}${mode & 0o077 ? " (should be 600)" : ""}`);
  } catch {
    add("info", "config.json", "not created yet (pick a concept with `glint pick`)");
  }
  try {
    const mode = fs.statSync(path.join(gHome, "daemon.json")).mode & 0o777;
    if (mode & 0o077) add("warn", "daemon.json", `mode ${mode.toString(8)} (should be 600; it holds the bearer token)`);
  } catch {
    // no daemon.json while the daemon is down
  }
  if (fs.existsSync(path.join(gHome, "hook-payloads.jsonl"))) {
    add("info", "hook log", `${path.join(gHome, "hook-payloads.jsonl")} exists (GLINT_HOOK_LOG; redacted). Delete it when you are done debugging.`);
  }

  if (process.platform === "linux") {
    const writable = run("gsettings", ["writable", "org.gnome.desktop.notifications", "show-banners"]);
    if (env.GLINT_DND === "0") add("info", "do not disturb", "disabled by GLINT_DND=0");
    else add(writable === "true" ? "ok" : "info", "do not disturb", writable === "true" ? "GNOME banners are paused during calls" : "GNOME gsettings not available; banners are not paused");
  }
  if (env.GLINT_HOOK === "0" || env.GLINT_HOOKS === "0") add("warn", "hooks", "GLINT_HOOK=0: every hook is a no-op in this environment");

  for (const harness of HARNESSES) {
    const status = harnessStatus(harness, home);
    const parts = [`mcp ${status.mcp ? "yes" : "no"}`, `hook ${status.hook ? "yes" : "no"}`, `rule ${status.rule ? "yes" : "no"}`];
    const all = status.mcp && status.hook && status.rule;
    const none = !status.mcp && !status.hook && !status.rule;
    add(all ? "ok" : none ? "info" : "warn", harness, `${parts.join(", ")}${none ? ` (run: glint install ${harness} --write)` : all ? "" : ` (partial; rerun glint install ${harness} --write)`}`);
    if (harness === "codex" && status.hook) add("info", "codex trust", "Codex runs hooks.json hooks only after you trust them once with /hooks in the Codex TUI");
  }
  return checks;
}

export function renderChecks(checks: Check[]): string {
  const mark: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  const width = Math.max(...checks.map((check) => check.label.length));
  return checks.map((check) => `${mark[check.level]} ${check.label.padEnd(width)}  ${check.detail}`).join("\n");
}
