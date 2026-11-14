import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { harnessStatus } from "../src/doctor.js";
import {
  applyInstall,
  backupPath,
  jsoncRemoveMember,
  jsoncWithoutComments,
  planInstall,
  planUninstall,
  removeTomlTable,
  stripGlintHooks,
} from "../src/install.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glint-un-"));
}

const opts = (h: string) => ({ home: h, node: "/usr/bin/node", cli: "/opt/glint/dist/cli.js", opencodeMajor: 2 });

test("backups are timestamped and never overwrite each other", () => {
  const dir = home();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{}");
  const at = new Date(2026, 10, 14, 22, 5, 9);
  const first = backupPath(file, at);
  assert.equal(path.basename(first), "settings.json.glint-backup-20261114-220509");
  fs.writeFileSync(first, "x");
  const second = backupPath(file, at);
  assert.equal(path.basename(second), "settings.json.glint-backup-20261114-220509-2");
});

test("claude: uninstall removes only Glint's hook, server and rule", () => {
  const h = home();
  fs.mkdirSync(path.join(h, ".claude"));
  const settingsFile = path.join(h, ".claude", "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "agent-event.sh claude" }] }] } }));
  fs.writeFileSync(path.join(h, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  fs.writeFileSync(path.join(h, ".claude", "CLAUDE.md"), "# Mine\n\nKeep this.\n");
  applyInstall(planInstall("claude", opts(h)));
  assert.deepEqual(harnessStatus("claude", h), { mcp: true, hook: true, rule: true });

  const preview = planUninstall("claude", { home: h });
  assert.equal(preview.steps.length, 3);
  const written = applyInstall(preview);
  assert.equal(written.length, 3);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings, { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "agent-event.sh claude" }] }] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, ".claude.json"), "utf8")), { mcpServers: { other: { command: "x" } } });
  assert.equal(fs.readFileSync(path.join(h, ".claude", "CLAUDE.md"), "utf8"), "# Mine\n\nKeep this.\n");
  assert.deepEqual(harnessStatus("claude", h), { mcp: false, hook: false, rule: false });
  assert.deepEqual(applyInstall(planUninstall("claude", { home: h })), [], "second uninstall is a no-op");
});

test("codex: uninstall drops the notify line, the [mcp_servers.glint] tables and the Stop hook", () => {
  const h = home();
  fs.mkdirSync(path.join(h, ".codex"));
  const original = 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "x"\n';
  fs.writeFileSync(path.join(h, ".codex", "config.toml"), original);
  applyInstall(planInstall("codex", opts(h)));
  applyInstall(planUninstall("codex", { home: h }));
  const toml = fs.readFileSync(path.join(h, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(toml, /glint/);
  assert.match(toml, /model = "gpt-5"/);
  assert.match(toml, /\[profiles\.fast\]\nmodel = "x"/);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks, undefined);
});

test("agy: uninstall removes the named glint hook and server, keeps the rest", () => {
  const h = home();
  const cfg = path.join(h, ".gemini", "config");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "hooks.json"), JSON.stringify({ mine: { Stop: [{ type: "command", command: "echo hi" }] } }));
  fs.writeFileSync(path.join(cfg, "mcp_config.json"), JSON.stringify({ mcpServers: { godot: { command: "g" } } }));
  applyInstall(planInstall("agy", opts(h)));
  applyInstall(planUninstall("agy", { home: h }));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, "hooks.json"), "utf8")), { mine: { Stop: [{ type: "command", command: "echo hi" }] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, "mcp_config.json"), "utf8")), { mcpServers: { godot: { command: "g" } } });
});

test("opencode: uninstall deletes the plugin and removes mcp.glint from a commented jsonc", () => {
  const h = home();
  const dir = path.join(h, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const original = [
    "{",
    "  // provider note",
    '  "mcp": {',
    '    "godot": { "type": "remote", "url": "http://127.0.0.1:9090/mcp" } // inline',
    "  },",
    '  "theme": "tokyo"',
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), original);
  applyInstall(planInstall("opencode", opts(h)));
  assert.ok(fs.existsSync(path.join(dir, "plugin", "glint.js")));
  applyInstall(planUninstall("opencode", { home: h }));
  assert.equal(fs.existsSync(path.join(dir, "plugin", "glint.js")), false);
  assert.ok(fs.readdirSync(path.join(dir, "plugin")).some((f) => f.startsWith("glint.js.glint-backup-")), "plugin backed up");
  const text = fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8");
  assert.equal(text, original, "jsonc is back to the original, comments included");
});

test("jsoncRemoveMember handles first, middle and last members", () => {
  const doc = '{\n  "mcp": {\n    "a": { "x": 1 },\n    "glint": { "command": ["n", "c"] },\n    "b": 2\n  }\n}';
  const mid = jsoncRemoveMember(doc, "mcp", "glint")!;
  assert.deepEqual(JSON.parse(mid), { mcp: { a: { x: 1 }, b: 2 } });
  const last = jsoncRemoveMember('{ "mcp": { "a": 1, "glint": {"k": "}"} } }', "mcp", "glint")!;
  assert.deepEqual(JSON.parse(last), { mcp: { a: 1 } });
  const only = jsoncRemoveMember('{ "mcp": {\n    "glint": {}\n  } // c\n}', "mcp", "glint")!;
  assert.deepEqual(JSON.parse(jsoncWithoutComments(only).stripped), { mcp: {} });
  assert.equal(jsoncRemoveMember('{ "mcp": { "a": 1 } }', "mcp", "glint"), null);
});

test("removeTomlTable removes a table and its sub-tables only", () => {
  const toml = '[a]\nx = 1\n\n[mcp_servers.glint]\ncommand = "n"\n\n[mcp_servers.glint.env]\nK = "v"\n\n[mcp_servers.glintx]\ny = 2\n';
  const out = removeTomlTable(toml, "mcp_servers.glint");
  assert.doesNotMatch(out, /\[mcp_servers\.glint\]|K = "v"/);
  assert.match(out, /\[mcp_servers\.glintx\]\ny = 2/);
  assert.match(out, /\[a\]\nx = 1/);
});

test("stripGlintHooks leaves other tools' handlers and other harnesses alone", () => {
  const hooks = {
    Stop: [
      { hooks: [{ command: "other-tool stop" }, { command: "node /x/glint/dist/cli.js hook claude Stop" }] },
      { hooks: [{ command: "node /x/glint/dist/cli.js hook claude Stop" }] },
    ],
    PreToolUse: [{ matcher: "*", hooks: [{ command: "node /x/glint/dist/cli.js hook codex PreToolUse" }] }],
  };
  assert.deepEqual(stripGlintHooks(hooks, "claude"), {
    Stop: [{ hooks: [{ command: "other-tool stop" }] }],
    PreToolUse: hooks.PreToolUse,
  });
});
