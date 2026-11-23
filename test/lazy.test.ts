import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  askToolQuestions,
  detectPlainQuestion,
  isBuiltinAskTool,
  markdownLite,
  questionBody,
  runHook,
  type HookDeps,
} from "../src/hooks.js";
import { findRuleBlock, planInstall, planUninstall, ruleText } from "../src/install.js";
import type { AskInput, AskResult } from "../src/protocol.js";

function answered(answer: string, choiceIndex: number | null = null): AskResult {
  return { id: "q", status: "answered", answer, choiceIndex, via: choiceIndex == null ? "text" : "choice" };
}

function fakeDeps(replies: AskResult[] | AskResult, env: NodeJS.ProcessEnv = {}) {
  const asked: AskInput[] = [];
  const list = Array.isArray(replies) ? [...replies] : null;
  const deps: HookDeps = {
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "glint-lazy-")),
    env,
    ask: async (input) => {
      asked.push(input);
      return list ? list.shift()! : (replies as AskResult);
    },
    notify: async () => ({ id: "n", delivered: true }),
  };
  return { deps, asked };
}

const stop = (message: string, harness = "claude") =>
  JSON.stringify(
    harness === "opencode"
      ? { sessionID: "s", cwd: "/tmp/demo", last_assistant_message: message, chain: 0 }
      : { session_id: "s", cwd: "/tmp/demo", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: message },
  );

/* ---------- detection ---------- */

test("detect: question marks, asking phrases (EN/TR), option lists and blockers", () => {
  const yes = [
    "I refactored the parser. Should I also update the docs?",
    "Done with the API.\n\nDo you want me to deploy it now",
    "Testler geçti. Deploy etmemi ister misin",
    "İki yol var, hangisi daha iyi sence",
    "Migration hazır. Onaylar mısın",
    "Bu noktada nasıl devam edelim",
    "Kodu yazdım, şimdi push edeyim mi",
    "I'm blocked: the API key is missing, so I can't continue.",
    "GitHub token'ı olmadan devam edemiyorum.",
    "Pick one:\n1. Rewrite in Rust\n2. Keep TypeScript",
    "Which approach do you prefer:\n- Postgres\n- SQLite",
  ];
  for (const text of yes) assert.ok(detectPlainQuestion(text), `should detect: ${text}`);
  const no = [
    "Done. All 73 tests pass and the branch is pushed.",
    "Fixed the bug which caused the crash; tests pass.",
    "Tamamlandı, testler geçti.",
    "Here is the code:\n```ts\nconst a = ok ? 1 : 2; // should i?\n```\nAll done.",
    "",
  ];
  for (const text of no) assert.equal(detectPlainQuestion(text), null, `should not detect: ${text}`);
});

test("detect: only the tail matters, so an early question in a long summary stays a stop", () => {
  const text = `Should I keep the old API? I decided yes.\n\n${"Implemented things. ".repeat(60)}\n\nEverything is done and pushed.`;
  assert.equal(detectPlainQuestion(text), null);
});

test("detect: listed options become the choices and the body is the markdown-lite tail", () => {
  const text = "## Status\n\nI finished **the import**.\n\nWhich one should I do next?\n1. **Run tests**\n2. Write `docs`\n3. Deploy";
  const q = detectPlainQuestion(text)!;
  assert.equal(q.why, "options");
  assert.deepEqual(q.choices, ["Run tests", "Write docs", "Deploy"]);
  assert.ok(!q.body.includes("**") && !q.body.includes("##") && !q.body.includes("`"));
  assert.match(q.body, /Which one should I do next\?/);
});

test("detect: inline alternatives at the end of the question become two buttons", () => {
  assert.deepEqual(detectPlainQuestion("Hangi veritabanını kullanayım, Postgres mi SQLite mı?")!.choices, ["Postgres", "SQLite"]);
  assert.deepEqual(detectPlainQuestion("Should I use **Postgres** or SQLite?")!.choices, ["Postgres", "SQLite"]);
  assert.deepEqual(detectPlainQuestion("Do you want me to deploy it or not?")!.choices, []);
  assert.deepEqual(detectPlainQuestion("Should I deploy now?")!.choices, []);
});

test("markdownLite and questionBody trim to the end of the message", () => {
  assert.equal(markdownLite("# T\n- a [link](http://x)\n* b **c**"), "T\n• a link\n• b c");
  const long = `${"intro paragraph. ".repeat(100)}\n\nShould I continue?`;
  const body = questionBody(long, 200);
  assert.ok(body.startsWith("…"));
  assert.ok(body.endsWith("Should I continue?"));
  assert.ok(body.length <= 201);
});

/* ---------- Stop hook rings a QUESTION call ---------- */

test("Stop with a plain-text question rings a QUESTION call with the agent's options; the answer continues", async () => {
  for (const harness of ["claude", "codex", "agy", "opencode"] as const) {
    const { deps, asked } = fakeDeps(answered("Postgres", 0));
    const out = await runHook(harness, "stop", stop("Schema is ready.\n\nWhich database should I use?\n1. Postgres\n2. SQLite", harness), deps);
    assert.equal(out.action, "continue", harness);
    assert.equal(asked[0]!.kind, "question");
    assert.deepEqual(asked[0]!.choices, ["Postgres", "SQLite"]);
    assert.match(asked[0]!.question, /Which database should I use\?/);
    assert.match(out.message!, /answered your question through Glint \(option 1\): "Postgres"/);
    assert.match(out.stdout, /Postgres/);
  }
});

test("Stop with a plain question and no options: free text only; stop phrases still stop", async () => {
  const { deps, asked } = fakeDeps(answered("bu kadar"));
  const out = await runHook("claude", "stop", stop("Deploy etmemi ister misin?"), deps);
  assert.equal(asked[0]!.kind, "question");
  assert.deepEqual(asked[0]!.choices, []);
  assert.equal(out.action, "stop");
  assert.equal(out.stdout, "");
});

test("Stop without a question stays a generic stop call; GLINT_DETECT_QUESTIONS=0 turns detection off", async () => {
  const a = fakeDeps(answered("ok"));
  await runHook("claude", "stop", stop("All done, tests pass."), a.deps);
  assert.equal(a.asked[0]!.kind, "stop");
  const b = fakeDeps(answered("ok"), { GLINT_DETECT_QUESTIONS: "0" });
  await runHook("claude", "stop", stop("Should I deploy?"), b.deps);
  assert.equal(b.asked[0]!.kind, "stop");
});

/* ---------- built-in ask tools ---------- */

const claudeAsk = {
  questions: [
    {
      question: "Which color should the button be?",
      header: "Color",
      options: [
        { label: "Red", description: "warm" },
        { label: "Green", description: "calm" },
      ],
      multiSelect: false,
    },
  ],
};

test("ask tools are recognised and their questions parsed", () => {
  for (const name of ["AskUserQuestion", "request_user_input", "question"]) assert.ok(isBuiltinAskTool(name), name);
  for (const name of ["mcp__glint__ask_user", "glint_ask_user", "Bash", ""]) assert.ok(!isBuiltinAskTool(name), name);
  assert.deepEqual(askToolQuestions(claudeAsk), [
    { question: "Which color should the button be?", header: "Color", choices: ["Red", "Green"], multiple: false },
  ]);
  assert.deepEqual(askToolQuestions({ question: "Name?", choices: ["a", "b"] })[0]!.choices, ["a", "b"]);
});

test("Claude AskUserQuestion: Glint rings it and allows the tool with answers filled in", async () => {
  const { deps, asked } = fakeDeps(answered("Green", 1));
  const out = await runHook("claude", "pretooluse", JSON.stringify({ session_id: "s", cwd: "/tmp/demo", tool_name: "AskUserQuestion", tool_input: claudeAsk }), deps);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.kind, "question");
  assert.deepEqual(asked[0]!.choices, ["Red", "Green"]);
  assert.equal(out.action, "allow");
  const json = JSON.parse(out.stdout);
  assert.equal(json.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(json.hookSpecificOutput.updatedInput.answers, { "Which color should the button be?": "Green" });
  assert.deepEqual(json.hookSpecificOutput.updatedInput.questions, claudeAsk.questions);
});

test("ask tool: several questions ring one after another; deny mode carries the answers in the reason", async () => {
  const input = { questions: [{ question: "Q1?", options: [{ label: "A" }] }, { question: "Q2?" }] };
  const { deps, asked } = fakeDeps([answered("A", 0), answered("free text")], { GLINT_ASK_TOOL_MODE: "deny" });
  const out = await runHook("claude", "pretooluse", JSON.stringify({ tool_name: "AskUserQuestion", tool_input: input }), deps);
  assert.equal(asked.length, 2);
  assert.match(asked[0]!.question, /^\(1\/2\) Q1\?/);
  assert.equal(out.action, "deny");
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason, /"Q1\?" → "A"; "Q2\?" → "free text"/);
});

test("ask tool on other harnesses is denied with the answer; no answer in Glint leaves the terminal prompt alone", async () => {
  const a = fakeDeps(answered("Green"));
  const out = await runHook("codex", "pretooluse", JSON.stringify({ tool_name: "request_user_input", tool_input: claudeAsk }), a.deps);
  assert.equal(out.action, "deny");
  assert.match(out.stdout, /Green/);
  const b = fakeDeps({ id: "q", status: "dismissed", answer: null, choiceIndex: null, via: "dismiss" });
  const none = await runHook("claude", "pretooluse", JSON.stringify({ tool_name: "AskUserQuestion", tool_input: claudeAsk }), b.deps);
  assert.equal(none.action, "noop");
  assert.equal(none.stdout, "");
  const c = fakeDeps(answered("x"), { GLINT_ASK_TOOLS: "0" });
  assert.equal((await runHook("claude", "pretooluse", JSON.stringify({ tool_name: "AskUserQuestion", tool_input: claudeAsk }), c.deps)).action, "noop");
  assert.equal(c.asked.length, 0);
});

/* ---------- install: ask-tool hooks and the stronger rule ---------- */

test("install wires the ask-tool PreToolUse hooks by default and they uninstall cleanly", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lazy-home-"));
  const claude = planInstall("claude", { home, node: "/n", cli: "/opt/glint/dist/cli.js" });
  const settings = JSON.parse(claude.steps[0]!.content!);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].matcher, "AskUserQuestion");
  const both = JSON.parse(planInstall("claude", { home, node: "/n", cli: "/c.js", approvals: true }).steps[0]!.content!);
  assert.deepEqual(both.hooks.PreToolUse.map((e: { matcher: string }) => e.matcher), ["AskUserQuestion", "Bash|Write|Edit|MultiEdit"]);
  const codexHooks = planInstall("codex", { home, node: "/n", cli: "/c.js" }).steps.find((s) => s.file.endsWith("hooks.json"))!;
  assert.equal(JSON.parse(codexHooks.content!).hooks.PreToolUse[0].matcher, "request_user_input");
  // apply, then uninstall removes them
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), claude.steps[0]!.content!);
  const un = planUninstall("claude", { home });
  const after = un.steps.find((s) => s.file.endsWith("settings.json"))!;
  assert.ok(!after.content!.includes("PreToolUse"));
  assert.ok(!after.content!.includes("hook claude"));
});

test("rule: says write reply then stop, has an end marker, and upgrades the old rule in place", () => {
  assert.match(ruleText(), /write your full reply.*stop without calling `ask_user`/);
  assert.match(ruleText(), /blocked/);
  assert.ok(ruleText().length < 1_500, "rule stays short");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lazy-rule-"));
  const file = path.join(home, ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const oldRule =
    "## Glint\n\nWhen you finish, get blocked, or need approval, call the glint MCP tool `ask_user` instead of waiting in the terminal.";
  fs.writeFileSync(file, `# Mine\n\nkeep this\n\n<!-- glint:rule -->\n${oldRule}\n\n## After\n\nalso keep\n`);
  const step = planInstall("claude", { home, node: "/n", cli: "/c.js" }).steps.find((s) => s.file === file)!;
  assert.ok(step.changed);
  assert.match(step.content!, /keep this/);
  assert.match(step.content!, /also keep/);
  assert.match(step.content!, /write your full reply.*stop without calling `ask_user`/);
  assert.ok(!step.content!.includes("instead of waiting in the terminal"));
  assert.ok(findRuleBlock(step.content!));
  fs.writeFileSync(file, step.content!);
  assert.equal(planInstall("claude", { home, node: "/n", cli: "/c.js" }).steps.find((s) => s.file === file)!.changed, false, "idempotent");
  const removal = planUninstall("claude", { home }).steps.find((s) => s.file === file)!;
  assert.ok(!removal.content!.includes("glint:rule"));
  assert.match(removal.content!, /also keep/);
});

test("install: a JSON file that only lacks a trailing newline counts as up to date", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-lazy-nl-"));
  const first = planInstall("codex", { home, node: "/n", cli: "/c.js" }).steps.find((s) => s.file.endsWith("hooks.json"))!;
  fs.mkdirSync(path.dirname(first.file), { recursive: true });
  fs.writeFileSync(first.file, first.content!.trimEnd());
  const again = planInstall("codex", { home, node: "/n", cli: "/c.js" }).steps.find((s) => s.file.endsWith("hooks.json"))!;
  assert.equal(again.changed, false);
});
