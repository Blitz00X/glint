#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseArgs } from "./args.js";
import {
  askUser,
  daemonHealth,
  daemonStatus,
  electronBinary,
  ensureDaemon,
  focusOverlay,
  getDaemonLayout,
  getEvents,
  notifyUser,
  openPicker,
  runDaemonForeground,
  setDaemonLayout,
} from "./client.js";
import { renderChecks, runDoctor } from "./doctor.js";
import { HARNESSES, parseHarness, parseHookEvent, readStdin, runHook } from "./hooks.js";
import { applyInstall, INSTALL_TARGETS, parseInstallTarget, planInstall, planUninstall, renderPlan } from "./install.js";
import { createGlintServer, serveMcpHttp } from "./mcp.js";
import { packageRoot } from "./paths.js";
import { demoGuide, isWsl } from "./platform.js";
import { formatAskResult, GlintError, LAYOUT_MODES, parseLayout, type OverlayLayout } from "./protocol.js";

const HELP = `Glint — holographic prompts for AI coding agents

Usage
  glint daemon [--no-sandbox]     Start the overlay and keep it in the foreground
  glint mcp                       Serve the MCP tools on stdio
  glint mcp --http [--port N]     Serve the MCP tools over streamable HTTP
  glint ask <question> [options]  Ask from the shell, like an agent would
  glint notify <message>          Show a notice and return immediately
  glint focus                     Focus the newest panel (use for a Wayland keybinding)
  glint pick                      Open the concept picker (alias: glint settings)
  glint layout [name]             Show or switch the active overlay layout (saved)
                                  ${LAYOUT_MODES.join(" | ")}
  glint demo [--no-sandbox]       Ring a few sample calls and post to the feed
  glint status                    Print whether the daemon is up
  glint feed [--since N] [--json] Print the group-chat feed (last 100 events)
  glint hook <harness> <event>    Lifecycle hook: reads the harness JSON on stdin,
                                  rings a call, prints the harness's reply JSON.
                                  harness: claude | codex | agy | opencode
                                  event:   Stop | PreToolUse | notify | session.idle
  glint install <harness> [--write] [--approvals] [--target DIR]
                                  Print (or merge) MCP + hook + rule config
                                  harness: claude | codex | agy | opencode |
                                           codex-desktop | claude-desktop
  glint uninstall <harness> [--write] [--target DIR]
                                  Print (or apply) the removal of Glint's config
  glint doctor                    Check the install, daemon, layout and harnesses

ask / notify options
  --choice <text>     Repeat for numbered choices (ask only, max 9)
  --agent <name>      Label on the panel. Default: agent
  --project <name>    Project label. Default: this directory
  --timeout <ms>      Give up after this many milliseconds (ask only)
  --layout <mode>     Overlay layout for this call only (see glint layout)
  --session <id>      Session id; sets the stable #tag and color

Environment
  GLINT_HOME          State directory. Default: ~/.glint
  GLINT_AGENT         Default agent label
  GLINT_PROJECT       Default project label
  GLINT_LAYOUT        Start layout; when set it wins over the picker's saved choice
  GLINT_HOTKEY        Electron accelerator. Default: CommandOrControl+Shift+G
  GLINT_NO_SANDBOX    Set to 1 if Chromium's sandbox cannot start
  GLINT_MUTE          Set to 1 to silence call sounds
  GLINT_FEED_HOTKEY   Feed toggle accelerator. Default: CommandOrControl+Shift+F
  GLINT_PICKER_HOTKEY Concept picker accelerator. Default: CommandOrControl+Shift+L
  GLINT_HOOK          Set to 0 to make every hook a no-op
  GLINT_HOOK_TIMEOUT_MS      How long a Stop hook rings. Default: 600000
  GLINT_APPROVAL_TIMEOUT_MS  How long an approval call rings. Default: 120000
  GLINT_HOOK_MAX_CHAIN       Max continuations in a row before a hook lets go. Default: 50; 0 disables the cap
`;

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.has("help") || args.command === "help") {
    console.log(HELP);
    return;
  }
  if (args.flags.has("version") || args.command === "version") {
    console.log(readVersion());
    return;
  }
  if (args.flags.has("no-sandbox")) process.env.GLINT_NO_SANDBOX = "1";

  switch (args.command) {
    case "daemon":
      await daemonCommand();
      return;
    case "mcp":
      await mcpCommand(args.flags.has("http"), args.options.get("port"));
      return;
    case "ask":
      await askCommand(args);
      return;
    case "notify":
      await notifyCommand(args);
      return;
    case "layout":
      await layoutCommand(args);
      return;
    case "demo":
      await demoCommand();
      return;
    case "status":
      await statusCommand();
      return;
    case "focus":
      await focusOverlay();
      console.log("focused the newest Glint panel");
      return;
    case "hook":
      await hookCommand(args);
      return;
    case "install":
      installCommand(args);
      return;
    case "uninstall":
      uninstallCommand(args);
      return;
    case "doctor":
      await doctorCommand();
      return;
    case "pick":
    case "settings":
      await pickCommand();
      return;
    case "feed":
      await feedCommand(args);
      return;
    default:
      throw new GlintError(`Unknown command "${args.command}".\n\n${HELP}`);
  }
}

async function daemonCommand(): Promise<void> {
  const running = await daemonStatus();
  if (running) {
    console.error(`Glint is already running (pid ${running.pid}, port ${running.port}).`);
    return;
  }
  runDaemonForeground(process.env.GLINT_NO_SANDBOX === "1");
}

async function mcpCommand(http: boolean, portValue: string | undefined): Promise<void> {
  if (!http) {
    console.error("glint mcp listening on stdio");
    const handle = serveStdio(() => createGlintServer());
    const shutdown = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  const port = portValue === undefined ? 47821 : parsePort(portValue);
  const server = await serveMcpHttp(port);
  console.error(`glint mcp listening on ${server.url}`);
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function askCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const question = args.positionals.join(" ").trim();
  if (!question) throw new GlintError("Usage: glint ask <question> [--choice <text> ...]");
  const choices = args.repeated.get("choice");
  const timeout = args.options.get("timeout");
  const layout = parseLayoutOption(args.options.get("layout"));
  const result = await askUser({
    question,
    choices: choices && choices.length > 0 ? choices : undefined,
    agent: args.options.get("agent"),
    project: args.options.get("project"),
    timeoutMs: timeout === undefined ? undefined : parseTimeout(timeout),
    layout,
    session: args.options.get("session"),
  });
  console.log(formatAskResult(result));
  if (result.status !== "answered") process.exitCode = 2;
}

async function notifyCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const message = args.positionals.join(" ").trim();
  if (!message) throw new GlintError("Usage: glint notify <message>");
  const layout = parseLayoutOption(args.options.get("layout"));
  const result = await notifyUser({
    message,
    agent: args.options.get("agent"),
    project: args.options.get("project"),
    layout,
    session: args.options.get("session"),
  });
  console.log(`Delivered ${result.id}`);
}

async function layoutCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const raw = args.positionals[0];
  if (!raw) {
    console.log(await getDaemonLayout());
    return;
  }
  const next = parseLayoutOption(raw);
  if (!next) throw new GlintError(`Invalid layout "${raw}". Expected one of: ${LAYOUT_MODES.join(", ")}.`);
  console.log(await setDaemonLayout(next));
}

async function demoCommand(): Promise<void> {
  for (const line of demoGuide(isWsl())) console.error(line);
  console.error("Starting the Glint overlay…");
  const info = await ensureDaemon();
  console.error(`Overlay is up on 127.0.0.1:${info.port}. Answer the calls — results print here.`);
  await notifyUser({
    message: "Refactor done: 42 files touched, all 311 tests green.",
    agent: "Codex",
    project: "payments-api",
    harness: "codex",
    session: "demo-codex-1",
    durationMs: 8_000,
  });
  await notifyUser({
    message: "Indexing the monorepo, this takes a minute.",
    agent: "OpenCode",
    project: "infra",
    harness: "opencode",
    session: "demo-oc-1",
    durationMs: 6_000,
  });
  const first = askUser({
    question:
      "Done with the payments migration. It adds a NOT NULL column to charges. Apply it in one step, or split expand and contract?",
    choices: ["Apply it now", "Expand, then contract", "Stop. I'll take it from here"],
    agent: "Claude Code",
    project: "payments-api",
    harness: "claude",
    session: "demo-claude-1",
    kind: "stop",
  });
  // A demo is explicitly interactive: focus the first panel so the person can
  // answer with 1–9 straight away instead of guessing that they must click.
  void (async () => {
    await delay(900);
    try {
      await focusOverlay();
    } catch (error) {
      console.error(`could not focus the first panel: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  await delay(400);
  const second = askUser({
    question: "Approve this tool call?\nBash: git push --force-with-lease origin feat/holocall",
    choices: ["Allow", "Deny", "Decide in the terminal"],
    agent: "Antigravity",
    project: "glint",
    harness: "agy",
    session: "demo-agy-1",
    kind: "approval",
  });
  await delay(400);
  const third = askUser({
    question: "What should the README call the group feed, in two or three words?",
    agent: "OpenCode",
    project: "glint",
    harness: "opencode",
    session: "demo-oc-2",
  });
  const results = await Promise.all([first, second, third]);
  for (const result of results) console.log(formatAskResult(result));
}

async function hookCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  // A hook must never break the harness: any problem means "say nothing, exit 0".
  try {
    const harness = parseHarness(args.positionals[0]);
    const event = parseHookEvent(args.positionals[1] ?? "stop");
    if (!harness || !event) {
      console.error(`Usage: glint hook <${HARNESSES.join("|")}> <Stop|PreToolUse|notify|session.idle>`);
      return;
    }
    // Codex passes its notify payload as the last argv entry, not on stdin.
    const argvPayload = args.positionals.slice(2).join(" ").trim();
    const raw = argvPayload.startsWith("{") ? argvPayload : await readStdin();
    const outcome = await runHook(harness, event, raw, {
      ask: (input, signal) => askUser(input, { signal }),
      notify: (input) => notifyUser(input),
    });
    if (process.env.GLINT_DEBUG === "1") {
      console.error(`glint hook ${harness} ${event}: ${outcome.action}${outcome.reason ? ` (${outcome.reason})` : ""}`);
    }
    if (outcome.stdout) process.stdout.write(`${outcome.stdout}\n`);
  } catch (error) {
    if (process.env.GLINT_DEBUG === "1") console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 0;
}

function installCommand(args: ReturnType<typeof parseArgs>): void {
  const harness = parseInstallTarget(args.positionals[0]);
  if (!harness) throw new GlintError(`Usage: glint install <${INSTALL_TARGETS.join("|")}> [--write] [--approvals] [--target DIR]`);
  const plan = planInstall(harness, {
    write: args.flags.has("write"),
    approvals: args.flags.has("approvals"),
    target: args.options.get("target"),
  });
  const written = args.flags.has("write") ? applyInstall(plan) : null;
  console.log(renderPlan(plan, written));
}

function uninstallCommand(args: ReturnType<typeof parseArgs>): void {
  const harness = parseInstallTarget(args.positionals[0]);
  if (!harness) throw new GlintError(`Usage: glint uninstall <${INSTALL_TARGETS.join("|")}> [--write] [--target DIR]`);
  const plan = planUninstall(harness, { target: args.options.get("target") });
  const written = args.flags.has("write") ? applyInstall(plan) : null;
  console.log(renderPlan(plan, written).replace(/^# Glint for /, "# Remove Glint from "));
}

async function doctorCommand(): Promise<void> {
  const checks = await runDoctor({
    daemon: () => daemonHealth(),
    electron: () => {
      try {
        return electronBinary();
      } catch {
        return null;
      }
    },
  });
  console.log(renderChecks(checks));
  if (checks.some((check) => check.level === "fail")) process.exitCode = 1;
}

async function pickCommand(): Promise<void> {
  await openPicker();
  console.error("Opened the Glint concept picker.");
}

async function feedCommand(args: ReturnType<typeof parseArgs>): Promise<void> {
  const since = Number(args.options.get("since") ?? "0");
  const events = await getEvents(Number.isFinite(since) ? since : 0, { spawn: false });
  if (args.flags.has("json")) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  for (const event of events) {
    const time = new Date(event.at).toLocaleTimeString();
    const who = event.type === "answer" ? `you → ${event.caller.name}` : event.caller.name;
    const where = event.caller.project ? ` · ${event.caller.project}` : "";
    const mark = event.type === "call" ? "☎" : event.type === "answer" ? "↩" : "•";
    console.log(`${time} ${mark} ${who}${where} #${event.caller.tag}: ${event.text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

async function statusCommand(): Promise<void> {
  const info = await daemonStatus();
  if (!info) {
    console.log("stopped");
    process.exitCode = 1;
    return;
  }
  console.log(`running pid=${info.pid} port=${info.port}`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new GlintError(`Invalid port "${value}"`);
  }
  return port;
}

function parseTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) throw new GlintError(`Invalid timeout "${value}"`);
  return timeout;
}

function parseLayoutOption(value: string | undefined): OverlayLayout | undefined {
  if (value === undefined) return undefined;
  const layout = parseLayout(value);
  if (!layout) throw new GlintError(`Invalid layout "${value}". Expected one of: ${LAYOUT_MODES.join(", ")}.`);
  return layout;
}

function readVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
