import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "./paths.js";
import { type Harness } from "./hooks.js";

/**
 * `glint install <harness>` prints (or with --write, merges) the MCP server,
 * lifecycle hook, and rule snippets for one harness. Writes are additive:
 * existing settings and other hooks are kept, and running it twice is a no-op.
 */

export interface InstallOptions {
  home?: string;
  /** Write project-level config into this directory instead of $HOME. */
  target?: string;
  write?: boolean;
  approvals?: boolean;
  node?: string;
  cli?: string;
  /** OpenCode major version; detected with `opencode --version` when omitted. */
  opencodeMajor?: number;
}

export function detectOpencodeMajor(): number {
  try {
    const out = execFileSync("opencode", ["--version"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const match = /(\d+)\.\d+/.exec(out);
    return match ? Number(match[1]) : 1;
  } catch {
    return 1;
  }
}

export interface InstallStep {
  file: string;
  description: string;
  /** New full file content, or null when we could only print a snippet. */
  content: string | null;
  /** Delete the file instead of writing it (a superseded Glint file). */
  remove?: boolean;
  snippet: string;
  changed: boolean;
}

export interface InstallPlan {
  harness: Harness;
  steps: InstallStep[];
  notes: string[];
}

const MARKER = "<!-- glint:rule -->";
const END_MARKER = "<!-- /glint:rule -->";
/** Rule texts written by older Glint versions (no end marker), so install can upgrade them in place. */
const LEGACY_RULES = [
  "## Glint (reach the user without the terminal)\n\nThe user does not watch this terminal. Whenever you would stop and wait for them, call them through Glint instead:\n\n- **Finished**, **blocked on a decision**, or **need approval** \u2192 call the `glint` MCP tool `ask_user` (the tool may appear as `glint_ask_user` or `mcp__glint__ask_user`). Start the question with a one-line summary of where you are, then ask. Offer 2\u20134 short `choices` when you can; the user may also type a free answer. Use the answer as their next message and keep going.\n- **Progress or FYI** that needs no reply \u2192 `notify`.\n- Always set `agent` (your product name, e.g. \"Claude Code\", \"Codex\", \"OpenCode\", \"Antigravity\") and `project` (the repo or folder name).\n- If `ask_user` returns `dismissed` or `timeout`, stop and summarize; do not call again in a loop.",
  "## Glint\n\nWhen you finish, get blocked, or need approval, call the glint MCP tool `ask_user` instead of waiting in the terminal.",
];

/** Where the Glint rule block sits in a CLAUDE.md/AGENTS.md, or null if it was edited by hand. */
export function findRuleBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(MARKER);
  if (start < 0) return null;
  const endAt = text.indexOf(END_MARKER, start);
  if (endAt >= 0) return { start, end: endAt + END_MARKER.length };
  for (const rule of [ruleText(), ...LEGACY_RULES]) {
    const candidate = `${MARKER}\n${rule}`;
    if (text.startsWith(candidate, start)) return { start, end: start + candidate.length };
  }
  return null;
}

export function defaultCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(packageRoot(), "dist", "cli.js");
  if (fs.existsSync(dist)) return dist;
  return path.join(here, "cli.js");
}

export function ruleText(): string {
  try {
    return fs.readFileSync(path.join(packageRoot(), "skills", "glint", "RULE.md"), "utf8").trim();
  } catch {
    return "## Glint\n\nWhen you finish, get blocked, or need approval, call the glint MCP tool `ask_user` instead of waiting in the terminal.";
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(file: string): Record<string, unknown> | null | "invalid" {
  const text = readText(file);
  if (text == null) return null;
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : "invalid";
  } catch {
    return "invalid";
  }
}

/** Strip // and /* *\/ comments outside strings. Returns null if there were any. */
export function jsoncWithoutComments(text: string): { stripped: string; hadComments: boolean } {
  let out = "";
  let inString = false;
  let hadComments = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      hadComments = true;
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      hadComments = true;
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return { stripped: out, hadComments };
}

/**
 * Insert `"key": value` into the top-level object member `parent` of a JSONC
 * document without touching comments or formatting elsewhere. Creates the
 * parent member when it is missing. Returns null if the text can't be scanned.
 */
function findTopLevelOpen(text: string, parent: string, open: "{" | "["): { rootOpen: number; parentOpen: number } {
  let depth = 0;
  let rootOpen = -1;
  let parentOpen = -1;
  let lastTopLevelString: string | null = null;
  let expectParentValue = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          value += text[j]! + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        value += text[j];
        j++;
      }
      if (depth === 1) lastTopLevelString = value;
      i = j;
      continue;
    }
    if (c === ":" && depth === 1) {
      expectParentValue = lastTopLevelString === parent;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (depth === 1 && c === "{") rootOpen = i;
      if (depth === 2 && c === open && expectParentValue) {
        parentOpen = i;
        break;
      }
      expectParentValue = false;
      continue;
    }
    if (c === "}" || c === "]") depth--;
    else if (!/\s/.test(c)) expectParentValue = false;
  }
  return { rootOpen, parentOpen };
}

export function jsoncInsertMember(text: string, parent: string, key: string, value: unknown, parsed: Record<string, unknown>): string | null {
  const { rootOpen, parentOpen } = findTopLevelOpen(text, parent, "{");
  const indent = (s: string, pad: string) => s.split("\n").join(`\n${pad}`);
  const member = `${JSON.stringify(key)}: ${indent(JSON.stringify(value, null, 2), "    ")}`;
  if (parentOpen >= 0) {
    const parentValue = parsed[parent];
    const empty = !parentValue || typeof parentValue !== "object" || Object.keys(parentValue).length === 0;
    return `${text.slice(0, parentOpen + 1)}\n    ${member}${empty ? "" : ","}${text.slice(parentOpen + 1)}`;
  }
  if (rootOpen < 0) return null;
  const empty = Object.keys(parsed).length === 0;
  const block = `${JSON.stringify(parent)}: {\n    ${member}\n  }`;
  return `${text.slice(0, rootOpen + 1)}\n  ${block}${empty ? "" : ","}${text.slice(rootOpen + 1)}`;
}

function hookCommand(node: string, cli: string, harness: Harness, event: string): string {
  return `${shellQuote(node)} ${shellQuote(cli)} hook ${harness} ${event}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

type HookList = Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>;

function addHook(list: unknown, entry: { matcher?: string; hooks: Array<Record<string, unknown>> }, needle: string): HookList {
  const current: HookList = Array.isArray(list) ? (list as HookList) : [];
  // Same command under a different matcher (ask tools vs. approvals) is a separate entry.
  const already = current.some((e) => (e.matcher ?? "") === (entry.matcher ?? "") && JSON.stringify(e).includes(needle));
  return already ? current : [...current, entry];
}

function jsonStep(file: string, description: string, mutate: (obj: Record<string, unknown>) => void, snippet: unknown): InstallStep {
  const existing = readJsonObject(file);
  const snippetText = JSON.stringify(snippet, null, 2);
  if (existing === "invalid") {
    return { file, description: `${description} (existing file is not plain JSON; merge by hand)`, content: null, snippet: snippetText, changed: false };
  }
  const obj = structuredClone(existing ?? {});
  mutate(obj);
  const content = `${JSON.stringify(obj, null, 2)}\n`;
  // A missing trailing newline alone is not a change (Claude rewrites its JSON without one).
  return { file, description, content, snippet: snippetText, changed: content.trimEnd() !== (readText(file) ?? "").trimEnd() };
}

function ruleStep(file: string, description: string): InstallStep {
  const existing = readText(file) ?? "";
  const body = `${MARKER}\n${ruleText()}\n${END_MARKER}`;
  const block = `${body}\n`;
  if (existing.includes(MARKER)) {
    const found = findRuleBlock(existing);
    if (!found) return { file, description: `${description} (rule was edited by hand; left alone)`, content: existing, snippet: block, changed: false };
    // Replace an older rule text with the current one, in place.
    const content = `${existing.slice(0, found.start)}${body}${existing.slice(found.end)}`;
    return { file, description: content === existing ? description : `${description} (updated to the current rule)`, content, snippet: block, changed: content !== existing };
  }
  const content = existing ? `${existing.replace(/\s*$/, "")}\n\n${block}` : block;
  return { file, description, content, snippet: block, changed: true };
}

export function planInstall(harness: Harness, options: InstallOptions = {}): InstallPlan {
  const home = options.home ?? process.env.HOME ?? os.homedir();
  const node = options.node ?? process.execPath;
  const cli = options.cli ?? defaultCliPath();
  const target = options.target ? path.resolve(options.target) : null;
  const steps: InstallStep[] = [];
  const notes: string[] = [];
  const mcpArgs = [cli, "mcp"];

  if (harness === "claude") {
    const settings = target ? path.join(target, ".claude", "settings.json") : path.join(home, ".claude", "settings.json");
    const stop = { hooks: [{ type: "command", command: hookCommand(node, cli, "claude", "Stop"), timeout: 900 }] };
    const pre = {
      matcher: "Bash|Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: hookCommand(node, cli, "claude", "PreToolUse"), timeout: 180 }],
    };
    // AskUserQuestion is always routed to Glint (answered there, fed back as the tool's answers).
    const askPre = {
      matcher: "AskUserQuestion",
      hooks: [{ type: "command", command: hookCommand(node, cli, "claude", "PreToolUse"), timeout: 900 }],
    };
    steps.push(
      jsonStep(
        settings,
        "Stop hook + AskUserQuestion PreToolUse hook (and approvals with --approvals) in Claude Code settings",
        (obj) => {
          const hooks = (obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {}) as Record<string, unknown>;
          hooks.Stop = addHook(hooks.Stop, stop, "hook claude Stop");
          hooks.PreToolUse = addHook(hooks.PreToolUse, askPre, "hook claude PreToolUse");
          if (options.approvals) hooks.PreToolUse = addHook(hooks.PreToolUse, pre, "hook claude PreToolUse");
          obj.hooks = hooks;
        },
        { hooks: { Stop: [stop], PreToolUse: [askPre, ...(options.approvals ? [pre] : [])] } },
      ),
    );
    const mcpFile = target ? path.join(target, ".mcp.json") : path.join(home, ".claude.json");
    const server = { type: "stdio", command: node, args: mcpArgs, env: { GLINT_HARNESS: "claude" } };
    steps.push(
      jsonStep(
        mcpFile,
        "glint MCP server for Claude Code (same as `claude mcp add -s user glint -- node <cli> mcp`)",
        (obj) => {
          const servers = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {}) as Record<string, unknown>;
          servers.glint = server;
          obj.mcpServers = servers;
        },
        { mcpServers: { glint: server } },
      ),
    );
    steps.push(ruleStep(target ? path.join(target, "CLAUDE.md") : path.join(home, ".claude", "CLAUDE.md"), "Glint rule in CLAUDE.md"));
    notes.push("Claude Code: the Stop hook blocks the stop with your answer as the reason, so Claude keeps going. It respects stop_hook_active and GLINT_HOOK_MAX_CHAIN.");
  }

  if (harness === "codex") {
    const dir = target ? path.join(target, ".codex") : path.join(home, ".codex");
    const configFile = path.join(dir, "config.toml");
    const existing = readText(configFile) ?? "";
    const tomlArray = (items: string[]) => `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
    const mcpBlock = [
      "[mcp_servers.glint]",
      `command = ${JSON.stringify(node)}`,
      `args = ${tomlArray(mcpArgs)}`,
      "tool_timeout_sec = 900",
      "",
      "[mcp_servers.glint.env]",
      'GLINT_HARNESS = "codex"',
      "",
    ].join("\n");
    const notifyLine = `notify = ${tomlArray([node, cli, "hook", "codex", "notify"])}`;
    let content = existing;
    if (!/^\s*\[mcp_servers\.glint\]/m.test(content)) content = `${content.replace(/\s*$/, "")}${content.trim() ? "\n\n" : ""}${mcpBlock}`;
    if (/^\s*notify\s*=/m.test(existing)) {
      if (!existing.includes("hook codex notify") && !existing.includes('"hook", "codex", "notify"')) {
        notes.push("Codex: config.toml already has a top-level notify program, so it was left alone. The Stop hook below covers Glint.");
      }
    } else {
      content = `${notifyLine}\n${content.startsWith("\n") ? "" : "\n"}${content}`;
    }
    steps.push({
      file: configFile,
      description: "glint MCP server + notify program in Codex config.toml",
      content,
      snippet: `${notifyLine}\n\n${mcpBlock}`,
      changed: content !== existing,
    });
    const stop = { hooks: [{ type: "command", command: hookCommand(node, cli, "codex", "Stop"), timeout: 900 }] };
    const pre = { matcher: "*", hooks: [{ type: "command", command: hookCommand(node, cli, "codex", "PreToolUse"), timeout: 180 }] };
    const askPre = { matcher: "request_user_input", hooks: [{ type: "command", command: hookCommand(node, cli, "codex", "PreToolUse"), timeout: 900 }] };
    steps.push(
      jsonStep(
        path.join(dir, "hooks.json"),
        "Stop hook + request_user_input PreToolUse hook in Codex hooks.json",
        (obj) => {
          const hooks = (obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {}) as Record<string, unknown>;
          hooks.Stop = addHook(hooks.Stop, stop, "hook codex Stop");
          if (options.approvals) hooks.PreToolUse = addHook(hooks.PreToolUse, pre, "hook codex PreToolUse");
          else hooks.PreToolUse = addHook(hooks.PreToolUse, askPre, "hook codex PreToolUse");
          obj.hooks = hooks;
        },
        { hooks: { Stop: [stop], PreToolUse: [options.approvals ? pre : askPre] } },
      ),
    );
    steps.push(ruleStep(target ? path.join(target, "AGENTS.md") : path.join(dir, "AGENTS.md"), "Glint rule in AGENTS.md"));
    notes.push("Codex: lifecycle hooks may need `[features] codex_hooks = true` in config.toml on older builds. notify only posts to the feed; the Stop hook is what feeds your answer back.");
  }

  if (harness === "agy") {
    // agy's global customization root is ~/.gemini/config (hooks.json,
    // mcp_config.json, AGENTS.md); a project root uses .agents/ instead.
    const root = target ? path.join(target, ".agents") : path.join(home, ".gemini", "config");
    // Stop and other non-tool events take a flat list of handlers; only
    // PreToolUse/PostToolUse use the {matcher, hooks} wrapper.
    const stopHandler = { type: "command", command: hookCommand(node, cli, "agy", "Stop"), timeout: 900 };
    const askEntry = { matcher: "notify_user", hooks: [{ type: "command", command: hookCommand(node, cli, "agy", "PreToolUse"), timeout: 900 }] };
    const preEntry = { matcher: "run_command", hooks: [{ type: "command", command: hookCommand(node, cli, "agy", "PreToolUse"), timeout: 180 }] };
    steps.push(
      jsonStep(
        path.join(root, "hooks.json"),
        `named \`glint\` hook (Stop) in Antigravity ${target ? ".agents/hooks.json" : "~/.gemini/config/hooks.json"}`,
        (obj) => {
          const current = (obj.glint && typeof obj.glint === "object" ? obj.glint : {}) as Record<string, unknown>;
          // Drop handlers written in the old (wrapped) shape by Glint 0.2.0.
          const stops = (Array.isArray(current.Stop) ? current.Stop : []).filter(
            (h) => !(h && typeof h === "object" && Array.isArray((h as { hooks?: unknown }).hooks) && JSON.stringify(h).includes("hook agy Stop")),
          );
          current.Stop = JSON.stringify(stops).includes("hook agy Stop") ? stops : [...stops, stopHandler];
          // notify_user that blocks on the user is rung in Glint and answered there.
          current.PreToolUse = addHook(current.PreToolUse, askEntry, "hook agy PreToolUse");
          if (options.approvals) current.PreToolUse = addHook(current.PreToolUse, preEntry, "hook agy PreToolUse");
          obj.glint = current;
        },
        { glint: { Stop: [stopHandler], PreToolUse: [askEntry, ...(options.approvals ? [preEntry] : [])] } },
      ),
    );
    const server = { command: node, args: mcpArgs, env: { GLINT_HARNESS: "agy", GLINT_AGENT: "Antigravity" } };
    if (target) {
      notes.push(`Antigravity: MCP servers are global only; add to ~/.gemini/config/mcp_config.json: {"mcpServers":{"glint":${JSON.stringify(server)}}}`);
    } else {
      steps.push(
        jsonStep(
          path.join(root, "mcp_config.json"),
          "glint MCP server in ~/.gemini/config/mcp_config.json",
          (obj) => {
            const servers = (obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {}) as Record<string, unknown>;
            const prev = (servers.glint && typeof servers.glint === "object" ? servers.glint : {}) as Record<string, unknown>;
            const prevEnv = (prev.env && typeof prev.env === "object" ? prev.env : {}) as Record<string, unknown>;
            // Keep any env the user already set (layout, display) and point at this build.
            servers.glint = { ...prev, command: node, args: mcpArgs, env: { ...prevEnv, ...server.env }, disabled: false };
            obj.mcpServers = servers;
          },
          { mcpServers: { glint: server } },
        ),
      );
    }
    steps.push(ruleStep(target ? path.join(target, "AGENTS.md") : path.join(root, "AGENTS.md"), "Glint rule in AGENTS.md"));
  }

  if (harness === "opencode") {
    const configDir = target ?? path.join(home, ".config", "opencode");
    const pluginDir = target ? path.join(target, ".opencode", "plugin") : path.join(configDir, "plugin");
    const pluginFile = path.join(pluginDir, "glint.js");
    const v2 = (options.opencodeMajor ?? detectOpencodeMajor()) >= 2;
    // Both versions load files from plugin/. OpenCode 1.x calls named export
    // functions; 2.x needs a default {id, setup} export (and treats entries
    // under "plugin" in the config as package directories, not files).
    const template = readText(path.join(packageRoot(), "plugins", "opencode", v2 ? "glint-v2.js" : "glint.js")) ?? "";
    const plugin = template.replaceAll("__GLINT_NODE__", node).replaceAll("__GLINT_CLI__", cli);
    steps.push({
      file: pluginFile,
      description: v2 ? "OpenCode 2.x plugin (experimental.idle → Glint call → synthetic reply)" : "OpenCode plugin (session.idle → Glint call → promptAsync)",
      content: plugin,
      snippet: `(plugin file ${pluginFile})`,
      changed: plugin !== readText(pluginFile),
    });
    const server = {
      type: "local",
      command: [node, ...mcpArgs],
      enabled: true,
      environment: { GLINT_HARNESS: "opencode", GLINT_AGENT: "OpenCode" },
    };
    const jsonFile = path.join(configDir, "opencode.json");
    const jsoncFile = path.join(configDir, "opencode.jsonc");
    const jsonc = readText(jsoncFile);
    if (jsonc != null && readText(jsonFile) == null) {
      const { stripped } = jsoncWithoutComments(jsonc);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(stripped) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const snippet = JSON.stringify({ mcp: { glint: server } }, null, 2);
      let content: string | null = parsed ? jsonc : null;
      let manual = false;
      if (parsed && content != null) {
        const existingGlint = parsed.mcp && typeof parsed.mcp === "object" ? (parsed.mcp as Record<string, unknown>).glint : undefined;
        if (existingGlint === undefined) {
          content = jsoncInsertMember(content, "mcp", "glint", server, parsed);
        } else if (JSON.stringify(existingGlint) !== JSON.stringify(server)) {
          manual = true;
        }
      }
      if (content != null && !manual) {
        steps.push({ file: jsoncFile, description: "glint MCP server in opencode.jsonc (comments kept)", content, snippet, changed: content !== jsonc });
      } else {
        steps.push({ file: jsoncFile, description: "glint MCP server (opencode.jsonc could not be merged automatically; merge by hand)", content: null, snippet, changed: false });
      }
    } else {
      steps.push(
        jsonStep(
          jsonFile,
          "glint MCP server in opencode.json",
          (obj) => {
            if (!obj.$schema) obj.$schema = "https://opencode.ai/config.json";
            const mcp = (obj.mcp && typeof obj.mcp === "object" ? obj.mcp : {}) as Record<string, unknown>;
            mcp.glint = server;
            obj.mcp = mcp;
          },
          { mcp: { glint: server } },
        ),
      );
    }
    steps.push(ruleStep(path.join(configDir, "AGENTS.md"), "Glint rule in AGENTS.md"));
    notes.push("OpenCode: the plugin runs inside OpenCode's server, so it works in the TUI and with `opencode serve`. Plain `opencode run` exits as soon as the session idles, before a call can be answered.");
    if (options.approvals) notes.push("OpenCode: set GLINT_APPROVALS=1 in OpenCode's environment to route permission prompts to Glint.");
  }

  return { harness, steps, notes };
}

/** `file.glint-backup-YYYYMMDD-HHMMSS`, with a counter if that name is taken. Never overwrites. */
export function backupPath(file: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let candidate = `${file}.glint-backup-${stamp}`;
  for (let i = 2; fs.existsSync(candidate); i++) candidate = `${file}.glint-backup-${stamp}-${i}`;
  return candidate;
}

export function applyInstall(plan: InstallPlan, now: Date = new Date()): string[] {
  const written: string[] = [];
  for (const step of plan.steps) {
    if (!step.changed || step.content == null) continue;
    if (step.remove) {
      if (fs.existsSync(step.file)) {
        fs.copyFileSync(step.file, backupPath(step.file, now));
        fs.rmSync(step.file);
        written.push(step.file);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(step.file), { recursive: true });
    if (fs.existsSync(step.file)) fs.copyFileSync(step.file, backupPath(step.file, now));
    fs.writeFileSync(step.file, step.content);
    written.push(step.file);
  }
  return written;
}

/* ----------------------------------------------------------------- uninstall */

function isGlintCommand(command: unknown, harness: Harness): boolean {
  return typeof command === "string" && /glint/i.test(command) && command.includes(`hook ${harness} `);
}

/** Remove Glint handlers from a hooks map ({Event: [entry...]}); drops events left empty. */
export function stripGlintHooks(hooks: Record<string, unknown>, harness: Harness): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      out[event] = list;
      continue;
    }
    const kept: unknown[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") {
        kept.push(entry);
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (Array.isArray(record.hooks)) {
        const inner = record.hooks.filter((h) => !(h && typeof h === "object" && isGlintCommand((h as Record<string, unknown>).command, harness)));
        if (inner.length > 0) kept.push(inner.length === record.hooks.length ? entry : { ...record, hooks: inner });
        continue;
      }
      if (!isGlintCommand(record.command, harness)) kept.push(entry);
    }
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

function ruleRemovalStep(file: string, description: string): InstallStep | null {
  const existing = readText(file);
  if (existing == null || !existing.includes(MARKER)) return null;
  const found = findRuleBlock(existing);
  let content: string | null = found ? `${existing.slice(0, found.start)}${existing.slice(found.end)}` : null;
  if (content == null) {
    return { file, description: `${description} (the rule text was edited; remove the block after ${MARKER} by hand)`, content: null, snippet: MARKER, changed: false };
  }
  content = content.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "");
  content = content ? `${content}\n` : "";
  return { file, description, content, snippet: MARKER, changed: content !== existing };
}

/** Remove a TOML table and its sub-tables (e.g. [mcp_servers.glint] and [mcp_servers.glint.env]). */
export function removeTomlTable(text: string, table: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const name = header[1]!.trim();
      skipping = name === table || name.startsWith(`${table}.`);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Remove member `key` from the top-level object `parent` of a JSONC document,
 * keeping comments and formatting elsewhere. Returns null if it isn't there.
 */
export function jsoncRemoveMember(text: string, parent: string, key: string): string | null {
  const { parentOpen } = findTopLevelOpen(text, parent, "{");
  if (parentOpen < 0) return null;
  let depth = 0;
  let keyStart = -1;
  let lastString: { value: string; start: number } | null = null;
  for (let i = parentOpen + 1; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          value += text[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += text[j];
        j++;
      }
      if (depth === 0) lastString = { value, start };
      i = j;
      continue;
    }
    if (c === ":" && depth === 0 && lastString?.value === key) {
      keyStart = lastString.start;
      // Skip the value.
      let j = i + 1;
      let d = 0;
      let started = false;
      for (; j < text.length; j++) {
        const ch = text[j]!;
        if (ch === '"') {
          j++;
          while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
          started = true;
          if (d === 0) {
            j++;
            break;
          }
          continue;
        }
        if (ch === "{" || ch === "[") {
          d++;
          started = true;
          continue;
        }
        if (ch === "}" || ch === "]") {
          if (d === 0) break;
          d--;
          if (d === 0) {
            j++;
            break;
          }
          continue;
        }
        if (d === 0 && started && (ch === "," || /\s/.test(ch))) break;
        if (!/\s/.test(ch)) started = true;
      }
      let end = j;
      // Eat a trailing comma, or else the comma before the member.
      let k = end;
      while (k < text.length && /[ \t\r\n]/.test(text[k]!)) k++;
      let start = keyStart;
      if (text[k] === ",") {
        end = k + 1;
      } else {
        let b = keyStart - 1;
        while (b > parentOpen && /[ \t\r\n]/.test(text[b]!)) b--;
        if (text[b] === ",") start = b;
      }
      // Also drop the whitespace that indented the member.
      let lineStart = start;
      while (lineStart > 0 && (text[lineStart - 1] === " " || text[lineStart - 1] === "\t")) lineStart--;
      if (text[lineStart - 1] === "\n" && text[start] !== ",") start = lineStart - 1;
      return text.slice(0, start) + text.slice(end);
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 0) break;
      depth--;
    }
  }
  return null;
}

export function planUninstall(harness: Harness, options: InstallOptions = {}): InstallPlan {
  const home = options.home ?? process.env.HOME ?? os.homedir();
  const target = options.target ? path.resolve(options.target) : null;
  const steps: InstallStep[] = [];
  const notes: string[] = [];
  const push = (step: InstallStep | null) => {
    if (step && (step.changed || step.content == null)) steps.push(step);
  };
  const jsonRemoval = (file: string, description: string, mutate: (obj: Record<string, unknown>) => void) => {
    const existing = readJsonObject(file);
    if (existing === null) return;
    if (existing === "invalid") {
      steps.push({ file, description: `${description} (not plain JSON; remove by hand)`, content: null, snippet: "", changed: false });
      return;
    }
    const obj = structuredClone(existing);
    mutate(obj);
    const content = `${JSON.stringify(obj, null, 2)}\n`;
    if (JSON.stringify(obj) !== JSON.stringify(existing)) steps.push({ file, description, content, snippet: "", changed: true });
  };
  const dropHooks = (obj: Record<string, unknown>) => {
    if (obj.hooks && typeof obj.hooks === "object" && !Array.isArray(obj.hooks)) {
      const next = stripGlintHooks(obj.hooks as Record<string, unknown>, harness);
      if (Object.keys(next).length === 0) delete obj.hooks;
      else obj.hooks = next;
    }
  };
  const dropServer = (obj: Record<string, unknown>, field: string) => {
    const servers = obj[field];
    if (servers && typeof servers === "object" && "glint" in servers) {
      delete (servers as Record<string, unknown>).glint;
    }
  };

  if (harness === "claude") {
    jsonRemoval(target ? path.join(target, ".claude", "settings.json") : path.join(home, ".claude", "settings.json"), "remove Glint hooks from Claude Code settings", dropHooks);
    jsonRemoval(target ? path.join(target, ".mcp.json") : path.join(home, ".claude.json"), "remove the glint MCP server", (obj) => dropServer(obj, "mcpServers"));
    push(ruleRemovalStep(target ? path.join(target, "CLAUDE.md") : path.join(home, ".claude", "CLAUDE.md"), "remove the Glint rule from CLAUDE.md"));
  }

  if (harness === "codex") {
    const dir = target ? path.join(target, ".codex") : path.join(home, ".codex");
    const configFile = path.join(dir, "config.toml");
    const existing = readText(configFile);
    if (existing != null) {
      let content = removeTomlTable(existing, "mcp_servers.glint");
      content = content
        .split("\n")
        .filter((line) => !(/^\s*notify\s*=/.test(line) && /glint/i.test(line) && line.includes('"hook", "codex", "notify"')))
        .join("\n")
        .replace(/^\n+/, "");
      if (content !== existing) steps.push({ file: configFile, description: "remove the glint MCP server and notify program from config.toml", content, snippet: "", changed: true });
    }
    jsonRemoval(path.join(dir, "hooks.json"), "remove Glint hooks from Codex hooks.json", dropHooks);
    push(ruleRemovalStep(target ? path.join(target, "AGENTS.md") : path.join(dir, "AGENTS.md"), "remove the Glint rule from AGENTS.md"));
  }

  if (harness === "agy") {
    const root = target ? path.join(target, ".agents") : path.join(home, ".gemini", "config");
    jsonRemoval(path.join(root, "hooks.json"), "remove the named `glint` hook from Antigravity hooks.json", (obj) => {
      delete obj.glint;
    });
    if (!target) jsonRemoval(path.join(root, "mcp_config.json"), "remove the glint MCP server from mcp_config.json", (obj) => dropServer(obj, "mcpServers"));
    push(ruleRemovalStep(path.join(root, "AGENTS.md"), "remove the Glint rule from AGENTS.md"));
  }

  if (harness === "opencode") {
    const configDir = target ?? path.join(home, ".config", "opencode");
    const pluginFile = target ? path.join(target, ".opencode", "plugin", "glint.js") : path.join(configDir, "plugin", "glint.js");
    const plugin = readText(pluginFile);
    if (plugin != null) {
      if (/Glint/.test(plugin)) steps.push({ file: pluginFile, description: "remove the Glint OpenCode plugin", content: "", remove: true, snippet: "", changed: true });
      else notes.push(`${pluginFile} does not look like Glint's plugin; left alone.`);
    }
    const jsonFile = path.join(configDir, "opencode.json");
    const jsoncFile = path.join(configDir, "opencode.jsonc");
    const jsonc = readText(jsoncFile);
    if (jsonc != null && readText(jsonFile) == null) {
      const content = jsoncRemoveMember(jsonc, "mcp", "glint");
      if (content != null) steps.push({ file: jsoncFile, description: "remove the glint MCP server from opencode.jsonc (comments kept)", content, snippet: "", changed: content !== jsonc });
    } else {
      jsonRemoval(jsonFile, "remove the glint MCP server from opencode.json", (obj) => dropServer(obj, "mcp"));
    }
    push(ruleRemovalStep(path.join(configDir, "AGENTS.md"), "remove the Glint rule from AGENTS.md"));
    notes.push("Restart OpenCode (and any `opencode serve` service) so the plugin unloads.");
  }

  if (steps.length === 0) notes.push(`Nothing to remove: Glint is not installed for ${harness}.`);
  notes.push("Every changed file is backed up first as <file>.glint-backup-<timestamp>.");
  return { harness, steps, notes };
}

export function renderPlan(plan: InstallPlan, written: string[] | null): string {
  const lines: string[] = [`# Glint for ${plan.harness}`, ""];
  for (const step of plan.steps) {
    const status = written
      ? written.includes(step.file)
        ? "written"
        : step.content == null
          ? "NOT written: merge by hand"
          : "already up to date"
      : step.changed
        ? "would change"
        : step.content == null
          ? "merge by hand"
          : "already up to date";
    lines.push(`## ${step.description}`, `${step.file}  [${status}]`, "", step.snippet, "");
  }
  if (plan.notes.length) lines.push("## Notes", ...plan.notes.map((note) => `- ${note}`), "");
  if (!written) lines.push("Run again with --write to apply (existing files are backed up as <file>.glint-backup-<timestamp>).");
  return lines.join("\n");
}
