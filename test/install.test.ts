import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import { applyInstall, findRuleBlock, jsoncWithoutComments, planInstall, ruleText } from "../src/install.js";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glint-home-"));
}

const opts = (h: string) => ({ home: h, node: "/usr/bin/node", cli: "/opt/glint/dist/cli.js", opencodeMajor: 2 });

test("claude install merges the Stop hook and MCP server, keeps other hooks, is idempotent", () => {
  const h = home();
  fs.mkdirSync(path.join(h, ".claude"));
  fs.writeFileSync(
    path.join(h, ".claude", "settings.json"),
    JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "agent-event.sh claude" }] }] } }),
  );
  const written = applyInstall(planInstall("claude", opts(h)));
  assert.equal(written.length, 3);
  const settings = JSON.parse(fs.readFileSync(path.join(h, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "opus");
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[1].hooks[0].command, "/usr/bin/node /opt/glint/dist/cli.js hook claude Stop");
  assert.ok(settings.hooks.Stop[1].hooks[0].timeout >= 600);
  const claudeJson = JSON.parse(fs.readFileSync(path.join(h, ".claude.json"), "utf8"));
  assert.deepEqual(claudeJson.mcpServers.glint.args, ["/opt/glint/dist/cli.js", "mcp"]);
  assert.match(fs.readFileSync(path.join(h, ".claude", "CLAUDE.md"), "utf8"), /ask_user/);
  assert.ok(fs.readdirSync(path.join(h, ".claude")).some((f) => /^settings\.json\.glint-backup-\d{8}-\d{6}/.test(f)), "timestamped backup");

  const again = applyInstall(planInstall("claude", opts(h)));
  assert.deepEqual(again, [], "second run changes nothing");

  const withApprovals = planInstall("claude", { ...opts(h), approvals: true });
  applyInstall(withApprovals);
  const s2 = JSON.parse(fs.readFileSync(path.join(h, ".claude", "settings.json"), "utf8"));
  assert.match(s2.hooks.PreToolUse[0].hooks[0].command, /hook claude PreToolUse/);
});

test("codex install adds notify only when there is none, plus MCP block and Stop hook", () => {
  const h = home();
  fs.mkdirSync(path.join(h, ".codex"));
  fs.writeFileSync(path.join(h, ".codex", "config.toml"), 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "x"\n');
  applyInstall(planInstall("codex", opts(h)));
  const toml = fs.readFileSync(path.join(h, ".codex", "config.toml"), "utf8");
  assert.ok(toml.startsWith('notify = ["/usr/bin/node", "/opt/glint/dist/cli.js", "hook", "codex", "notify"]'), "notify is a top-level key");
  assert.match(toml, /\[mcp_servers\.glint\]\ncommand = "\/usr\/bin\/node"/);
  assert.match(toml, /tool_timeout_sec = 900/);
  assert.match(toml, /\[profiles\.fast\]/);
  const hooks = JSON.parse(fs.readFileSync(path.join(h, ".codex", "hooks.json"), "utf8"));
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /hook codex Stop/);

  const h2 = home();
  fs.mkdirSync(path.join(h2, ".codex"));
  fs.writeFileSync(path.join(h2, ".codex", "config.toml"), 'notify = ["ai-activity"]\n');
  const plan = planInstall("codex", opts(h2));
  applyInstall(plan);
  const toml2 = fs.readFileSync(path.join(h2, ".codex", "config.toml"), "utf8");
  assert.equal(toml2.match(/^notify/gm)?.length, 1, "an existing notify program is left alone");
  assert.ok(plan.notes.some((note) => note.includes("already has a top-level notify")));
});

test("opencode install writes a filled-in plugin and merges a comment-free jsonc", () => {
  const h = home();
  const dir = path.join(h, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), '{\n  "$schema": "https://opencode.ai/config.json"\n}');
  applyInstall(planInstall("opencode", { ...opts(h), opencodeMajor: 1 }));
  const plugin = fs.readFileSync(path.join(dir, "plugin", "glint.js"), "utf8");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).plugin, undefined, "1.x auto-loads plugin/, no listing");
  assert.ok(!plugin.includes("__GLINT_"), "placeholders are replaced");
  assert.match(plugin, /\/opt\/glint\/dist\/cli\.js/);
  const config = JSON.parse(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"));
  assert.deepEqual(config.mcp.glint.command, ["/usr/bin/node", "/opt/glint/dist/cli.js", "mcp"]);
  assert.equal(config.mcp.glint.environment.GLINT_HARNESS, "opencode");

  const h2 = home();
  const dir2 = path.join(h2, ".config", "opencode");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, "opencode.jsonc"), '{\n  // my theme\n  "theme": "tokyo"\n}');
  const plan = planInstall("opencode", opts(h2));
  const written = applyInstall(plan);
  assert.ok(written.includes(path.join(dir2, "opencode.jsonc")), "a commented jsonc gets a new mcp block");
  const text2 = fs.readFileSync(path.join(dir2, "opencode.jsonc"), "utf8");
  assert.match(text2, /\/\/ my theme/, "comments are kept");
  const parsed2 = JSON.parse(jsoncWithoutComments(text2).stripped);
  assert.equal(parsed2.theme, "tokyo");
  assert.equal(parsed2.mcp.glint.environment.GLINT_HARNESS, "opencode");
  assert.equal(parsed2.plugin, undefined);
  assert.deepEqual(applyInstall(planInstall("opencode", opts(h2))).filter((f) => f.endsWith(".jsonc")), [], "idempotent");
});

test("opencode install adds glint inside an existing mcp block of a commented jsonc", () => {
  const h = home();
  const dir = path.join(h, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const original = [
    "{",
    '  "plugin": ["a", "b"],',
    '  "provider": { "x": { "mcp": "not this one" } },',
    "  // provider note",
    '  "mcp": {',
    '    "godot": { "type": "remote", "url": "http://127.0.0.1:9090/mcp" } // inline',
    "  },",
    '  "theme": "tokyo"',
    "}",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), original);
  applyInstall(planInstall("opencode", opts(h)));
  const text = fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8");
  assert.match(text, /\/\/ provider note/);
  assert.match(text, /\/\/ inline/);
  const parsed = JSON.parse(jsoncWithoutComments(text).stripped);
  assert.deepEqual(Object.keys(parsed.mcp).sort(), ["glint", "godot"]);
  assert.deepEqual(parsed.plugin, ["a", "b"], "plugin list untouched");
  assert.deepEqual(applyInstall(planInstall("opencode", opts(h))).filter((f) => f.endsWith(".jsonc")), [], "idempotent");
  assert.equal(parsed.provider.x.mcp, "not this one");
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("opencode.jsonc.glint-backup-")));
});

test("agy install writes a flat Stop handler into .agents/hooks.json under --target", () => {
  const target = home();
  applyInstall(planInstall("agy", { ...opts(home()), target }));
  const hooks = JSON.parse(fs.readFileSync(path.join(target, ".agents", "hooks.json"), "utf8"));
  assert.equal(hooks.glint.Stop[0].type, "command", "Stop takes handler objects directly, no matcher wrapper");
  assert.match(hooks.glint.Stop[0].command, /hook agy Stop/);
  assert.match(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8"), /glint:rule/);
});

test("agy global install uses ~/.gemini/config, keeps other MCP servers and the user's glint env, migrates old hook shape", () => {
  const h = home();
  const cfg = path.join(h, ".gemini", "config");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, "mcp_config.json"),
    JSON.stringify({ mcpServers: { godot: { url: "http://x" }, glint: { command: "/old/node", args: ["/old/cli.js", "mcp"], env: { GLINT_LAYOUT: "deneme3" } } } }),
  );
  fs.writeFileSync(
    path.join(cfg, "hooks.json"),
    JSON.stringify({ other: { Stop: [{ command: "x.sh" }] }, glint: { Stop: [{ hooks: [{ type: "command", command: "node cli.js hook agy Stop" }] }] } }),
  );
  applyInstall(planInstall("agy", opts(h)));
  const mcp = JSON.parse(fs.readFileSync(path.join(cfg, "mcp_config.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.godot, { url: "http://x" });
  assert.deepEqual(mcp.mcpServers.glint.args, ["/opt/glint/dist/cli.js", "mcp"]);
  assert.equal(mcp.mcpServers.glint.env.GLINT_LAYOUT, "deneme3");
  assert.equal(mcp.mcpServers.glint.env.GLINT_HARNESS, "agy");
  const hooks = JSON.parse(fs.readFileSync(path.join(cfg, "hooks.json"), "utf8"));
  assert.deepEqual(hooks.other, { Stop: [{ command: "x.sh" }] });
  assert.equal(hooks.glint.Stop.length, 1);
  assert.equal(hooks.glint.Stop[0].command, "/usr/bin/node /opt/glint/dist/cli.js hook agy Stop");
  assert.match(fs.readFileSync(path.join(cfg, "AGENTS.md"), "utf8"), /glint:rule/);
  assert.deepEqual(applyInstall(planInstall("agy", opts(h))), [], "second run changes nothing");
});

test("jsonc comment stripper leaves strings alone", () => {
  const { stripped, hadComments } = jsoncWithoutComments('{"url": "http://x//y", /* c */ "a": 1 // tail\n}');
  assert.equal(hadComments, true);
  assert.deepEqual(JSON.parse(stripped), { url: "http://x//y", a: 1 });
});

test("OpenCode plugin: idle opens a call via the hook and prompts the session with the answer", async () => {
  const dir = home();
  const fakeCli = path.join(dir, "fake-cli.mjs");
  const seenFile = path.join(dir, "seen.json");
  fs.writeFileSync(
    fakeCli,
    `import fs from "node:fs";
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ argv: process.argv.slice(2), input: JSON.parse(input) }));
      process.stdout.write(JSON.stringify({ action: "continue", prompt: "The user replied through Glint: \\"ship it\\"." }));
    });`,
  );
  process.env.GLINT_NODE = process.execPath;
  process.env.GLINT_CLI = fakeCli;
  const url = pathToFileURL(path.resolve(import.meta.dirname, "..", "plugins", "opencode", "glint.js")).href;
  const mod = (await import(url)) as { GlintPlugin: (input: unknown) => Promise<Record<string, (...args: unknown[]) => Promise<void>>> };
  const message = "  # Built\n" + "Full output.\n".repeat(200) + "Deploy?\n  ";
  const prompts: unknown[] = [];
  const client = {
    session: {
      get: async () => ({ data: { id: "ses_1" } }),
      messages: async () => ({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "build it" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: message }] },
        ],
      }),
      promptAsync: async (args: unknown) => {
        prompts.push(args);
        return { data: {} };
      },
    },
  };
  const hooks = await mod.GlintPlugin({ client, directory: "/w/shop" });
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
  const start = Date.now();
  while (prompts.length === 0 && Date.now() - start < 10_000) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(prompts.length, 1);
  const sent = prompts[0] as { path: { id: string }; body: { parts: Array<{ text: string }> } };
  assert.equal(sent.path.id, "ses_1");
  assert.match(sent.body.parts[0]!.text, /ship it/);
  const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
  assert.deepEqual(seen.argv, ["hook", "opencode", "session.idle"]);
  assert.equal(seen.input.last_assistant_message, message);
  assert.equal(seen.input.cwd, "/w/shop");
  assert.equal(seen.input.chain, 0);

  // Our own injected prompt does not count as the user typing in the terminal.
  await hooks["chat.message"]!({ sessionID: "ses_1" }, { parts: [{ type: "text", text: sent.body.parts[0]!.text }] });
  // A child (subagent) session never rings.
  client.session.get = async () => ({ data: { id: "ses_2", parentID: "ses_1" } });
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(prompts.length, 1);
  delete process.env.GLINT_NODE;
  delete process.env.GLINT_CLI;
});

test("opencode 2.x install replaces the 1.x plugin file with the V2 one in plugin/", async () => {
  const h = home();
  const dir = path.join(h, ".config", "opencode");
  fs.mkdirSync(path.join(dir, "plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin", "glint.js"), "// Glint plugin for OpenCode (layer 2)\nexport const GlintPlugin = async () => ({});\n");
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), '{\n  // mine\n  "plugin": ["/x/tempo.mjs"]\n}');
  applyInstall(planInstall("opencode", { ...opts(h), opencodeMajor: 2 }));
  const file = path.join(dir, "plugin", "glint.js");
  const mod = (await import(pathToFileURL(file).href)) as { default: { id: string; setup: unknown } };
  assert.equal(mod.default.id, "glint");
  assert.equal(typeof mod.default.setup, "function");
  const parsed = JSON.parse(jsoncWithoutComments(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).stripped);
  assert.deepEqual(parsed.plugin, ["/x/tempo.mjs"]);
});

test("opencode 2.x installed plugin: skips session background jobs, then rings and admits a synthetic reply", async (t) => {
  const dir = home();
  const fakeCli = path.join(dir, "fake-cli.mjs");
  const seenFile = path.join(dir, "seen.json");
  process.env.GLINT_NODE = process.execPath;
  process.env.GLINT_CLI = fakeCli;
  // Mock only the CLI process boundary: this exercises the installed plugin's
  // actual idle handler even in sandboxes that prohibit spawning children.
  const spawn = t.mock.method(childProcess, "spawn", (_node: string, argv: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
    let raw = "";
    child.stdin.on("data", (chunk) => { raw += chunk; });
    child.stdin.on("end", () => {
      fs.writeFileSync(seenFile, JSON.stringify({ argv: argv.slice(1), input: JSON.parse(raw) }));
      child.stdout.write(JSON.stringify({ action: "continue", prompt: 'The user replied through Glint: "go".' }));
      child.emit("close", 0);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    delete process.env.GLINT_NODE;
    delete process.env.GLINT_CLI;
  });
  applyInstall(planInstall("opencode", { ...opts(dir), node: process.execPath, cli: fakeCli, opencodeMajor: 2 }));
  const url = pathToFileURL(path.join(dir, ".config", "opencode", "plugin", "glint.js")).href;
  const mod = (await import(url)) as { default: { setup: (ctx: unknown) => Promise<() => void> } };
  let idleHook: ((e: unknown) => Promise<void>) | null = null;
  const message = "  # Done\r\n" + "Full output.\n".repeat(200) + "Ship it?\n  ";
  const synthetic: unknown[] = [];
  const events: unknown[] = [
    { type: "session.execution.started", data: { sessionID: "s1" } },
    { type: "session.text.ended", data: { sessionID: "s1", text: message } },
  ];
  const ctx = {
    location: { directory: "/w/shop" },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      }),
    },
    session: {
      hook: async (name: string, fn: (e: unknown) => Promise<void>) => {
        if (name === "experimental.idle") idleHook = fn;
      },
      get: async () => ({ id: "s1" }),
      synthetic: async (input: unknown) => {
        synthetic.push(input);
      },
      prompt: async () => {},
    },
  };
  const cleanup = await mod.default.setup(ctx);
  await new Promise((r) => setTimeout(r, 20));
  for (let n = 0; n < 3; n++) await idleHook!({ sessionID: "s1", background: [{ sessionID: "s1" }] });
  assert.equal(fs.existsSync(seenFile), false, "no Glint subprocess for a pending job");
  assert.equal(synthetic.length, 0);
  await idleHook!({ sessionID: "s1", background: [{ sessionID: "other-session" }] });
  const first = JSON.parse(fs.readFileSync(seenFile, "utf8"));
  assert.equal(first.input.glint_consulted, false);
  assert.equal(first.input.chain, 0, "skipped idles never advance the chain");
  assert.equal(first.input.last_assistant_message, message);
  await idleHook!({ sessionID: "s1", background: [{ sessionID: "s1" }] });
  assert.equal(synthetic.length, 1, "background idle after continuation does not call again");
  // A code-mode "execute" tool that calls glint.ask_user counts as asking.
  events.push(
    { type: "session.execution.started", data: { sessionID: "s2" } },
    { type: "session.tool.input.started", data: { sessionID: "s2", id: "t1", name: "execute" } },
    { type: "session.tool.called", data: { sessionID: "s2", id: "t1", input: { code: "await glint.ask_user({question:'x'})" } } },
    { type: "session.text.ended", data: { sessionID: "s2", text: "CHOSEN=Green" } },
  );
  await mod.default.setup(ctx);
  await new Promise((r) => setTimeout(r, 20));
  await idleHook!({ sessionID: "s2", background: [] });
  assert.equal(JSON.parse(fs.readFileSync(seenFile, "utf8")).input.glint_consulted, true);
  await idleHook!({ sessionID: "s1", background: [] });
  cleanup();
  const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
  assert.deepEqual(seen.argv.slice(-2), ["opencode", "session.idle"]);
  assert.equal(seen.input.last_assistant_message, message);
  assert.equal(seen.input.cwd, "/w/shop");
  assert.deepEqual(synthetic[0], { sessionID: "s1", text: 'The user replied through Glint: "go".', description: "Reply through Glint" });
});

test("claude-desktop: adds mcpServers.glint next to other servers, uninstall removes only it", async () => {
  const { planInstall, planUninstall, parseInstallTarget } = await import("../src/install.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-cd-"));
  const file = path.join(home, ".config", "Claude", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, preferences: { a: 1 } }, null, 2));
  assert.equal(parseInstallTarget("claude-desktop"), "claude-desktop");
  assert.equal(parseInstallTarget("codex-app"), "codex-desktop");
  const plan = planInstall("claude-desktop", { home, node: "/n", cli: "/c.js" });
  if (process.platform === "linux") {
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]!.file, file);
    const obj = JSON.parse(plan.steps[0]!.content!);
    assert.deepEqual(obj.mcpServers.glint, { command: "/n", args: ["/c.js", "mcp"], env: { GLINT_HARNESS: "claude-desktop" } });
    assert.deepEqual(obj.mcpServers.other, { command: "x" });
    assert.deepEqual(obj.preferences, { a: 1 });
    fs.writeFileSync(file, plan.steps[0]!.content!);
    const un = planUninstall("claude-desktop", { home });
    const after = JSON.parse(un.steps[0]!.content!);
    assert.equal(after.mcpServers.glint, undefined);
    assert.deepEqual(after.mcpServers.other, { command: "x" });
  }
});

test("codex-desktop: same files as codex, with a note", async () => {
  const { planInstall } = await import("../src/install.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-cx-"));
  const a = planInstall("codex-desktop", { home, node: "/n", cli: "/c.js" });
  const b = planInstall("codex", { home, node: "/n", cli: "/c.js" });
  assert.deepEqual(a.steps.map((s) => s.file), b.steps.map((s) => s.file));
  assert.equal(a.harness, "codex-desktop");
  assert.match(a.notes[0]!, /app-server/);
});

test("old Glint rules upgrade in place with or without an end marker", () => {
  const old = fs.readFileSync(path.join(import.meta.dirname, "fixtures/glint-rule-before-verbatim.md"), "utf8").trim();
  for (const ending of ["", "\n<!-- /glint:rule -->"]) {
    const block = "<!-- glint:rule -->\n" + old + ending;
    const text = "# My rules\n\n" + block + "\n\n## Keep this\nOther rules.\n";
    const found = findRuleBlock(text);
    assert.ok(found);
    assert.equal(text.slice(found.start, found.end), block);
    const h = home();
    fs.mkdirSync(path.join(h, ".codex"));
    const file = path.join(h, ".codex/AGENTS.md");
    fs.writeFileSync(file, text);
    // Review the install plan only; do not install into a real harness.
    const change = planInstall("codex", opts(h)).steps.find((c) => c.file === file);
    assert.ok(change);
    assert.ok(change.content!.includes(ruleText()));
    assert.ok(change.content!.endsWith("## Keep this\nOther rules.\n"));
    assert.equal(change.content!.split("<!-- glint:rule -->").length, 2);
  }
});
