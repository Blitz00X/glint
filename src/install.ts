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
  const already = JSON.stringify(current).includes(needle);
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
  return { file, description, content, snippet: snippetText, changed: content !== readText(file) };
}

function ruleStep(file: string, description: string): InstallStep {
  const existing = readText(file) ?? "";
  const block = `${MARKER}\n${ruleText()}\n`;
  if (existing.includes(MARKER)) {
    return { file, description, content: existing, snippet: block, changed: false };
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
    steps.push(
      jsonStep(
        settings,
        "Stop hook (and PreToolUse with --approvals) in Claude Code settings",
        (obj) => {
          const hooks = (obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {}) as Record<string, unknown>;
          hooks.Stop = addHook(hooks.Stop, stop, "hook claude Stop");
          if (options.approvals) hooks.PreToolUse = addHook(hooks.PreToolUse, pre, "hook claude PreToolUse");
          obj.hooks = hooks;
        },
        { hooks: { Stop: [stop], ...(options.approvals ? { PreToolUse: [pre] } : {}) } },
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
    steps.push(
      jsonStep(
        path.join(dir, "hooks.json"),
        "Stop hook in Codex hooks.json",
        (obj) => {
          const hooks = (obj.hooks && typeof obj.hooks === "object" ? obj.hooks : {}) as Record<string, unknown>;
          hooks.Stop = addHook(hooks.Stop, stop, "hook codex Stop");
          if (options.approvals) hooks.PreToolUse = addHook(hooks.PreToolUse, pre, "hook codex PreToolUse");
          obj.hooks = hooks;
        },
        { hooks: { Stop: [stop], ...(options.approvals ? { PreToolUse: [pre] } : {}) } },
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
          if (options.approvals) current.PreToolUse = addHook(current.PreToolUse, preEntry, "hook agy PreToolUse");
          obj.glint = current;
        },
        { glint: { Stop: [stopHandler], ...(options.approvals ? { PreToolUse: [preEntry] } : {}) } },
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

export function applyInstall(plan: InstallPlan): string[] {
  const written: string[] = [];
  for (const step of plan.steps) {
    if (!step.changed || step.content == null) continue;
    if (step.remove) {
      if (fs.existsSync(step.file)) {
        fs.copyFileSync(step.file, `${step.file}.glint-backup`);
        fs.rmSync(step.file);
        written.push(step.file);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(step.file), { recursive: true });
    if (fs.existsSync(step.file)) fs.copyFileSync(step.file, `${step.file}.glint-backup`);
    fs.writeFileSync(step.file, step.content);
    written.push(step.file);
  }
  return written;
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
  if (!written) lines.push("Run again with --write to apply (existing files are backed up as *.glint-backup).");
  return lines.join("\n");
}
