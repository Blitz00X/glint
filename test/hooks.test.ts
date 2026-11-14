import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { askUser } from "../src/client.js";
import { createDaemon } from "../src/daemon.js";
import {
  lastToolWasGlintAsk,
  APPROVAL_CHOICES,
  normalizeHookInput,
  parseHarness,
  parseHookEvent,
  runHook,
  choicesFromMessage,
  type HookDeps,
} from "../src/hooks.js";
import type { AskInput, AskResult, NotifyInput } from "../src/protocol.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glint-hook-"));
}

function answered(answer: string, choiceIndex: number | null = null): AskResult {
  return { id: "q", status: "answered", answer, choiceIndex, via: choiceIndex == null ? "text" : "choice" };
}

function fakeDeps(reply: AskResult | ((input: AskInput, signal: AbortSignal) => Promise<AskResult>), env: NodeJS.ProcessEnv = {}) {
  const asked: AskInput[] = [];
  const notified: NotifyInput[] = [];
  const stateDir = tmp();
  const deps: HookDeps = {
    stateDir,
    env,
    ask: async (input, signal) => {
      asked.push(input);
      return typeof reply === "function" ? reply(input, signal) : reply;
    },
    notify: async (input) => {
      notified.push(input);
      return { id: "n", delivered: true };
    },
  };
  return { deps, asked, notified, stateDir };
}

const claudeStop = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/nonexistent",
    cwd: "/home/dev/payments-api",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "Migration written. Should I apply it?",
    ...extra,
  });

test("harness and event names parse loosely", () => {
  assert.equal(parseHarness("Claude"), "claude");
  assert.equal(parseHarness("antigravity"), "agy");
  assert.equal(parseHarness("nope"), null);
  assert.equal(parseHookEvent("Stop"), "stop");
  assert.equal(parseHookEvent("session.idle"), "stop");
  assert.equal(parseHookEvent("PreToolUse"), "pretooluse");
  assert.equal(parseHookEvent("permission.ask"), "pretooluse");
  assert.equal(parseHookEvent("notify"), "notify");
});

test("claude Stop: a typed answer blocks the stop and becomes the reason", async () => {
  const { deps, asked } = fakeDeps(answered("Apply it, then run the tests"));
  const out = await runHook("claude", "stop", claudeStop(), deps);
  assert.equal(out.action, "continue");
  const json = JSON.parse(out.stdout) as { decision: string; reason: string };
  assert.equal(json.decision, "block");
  assert.match(json.reason, /Apply it, then run the tests/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.question, "Migration written. Should I apply it?");
  assert.equal(asked[0]!.agent, "Claude Code");
  assert.equal(asked[0]!.project, "payments-api");
  assert.equal(asked[0]!.session, "sess-1");
  assert.equal(asked[0]!.kind, "stop");
  assert.deepEqual(asked[0]!.choices, [], "no made-up buttons on a stop call");
});

test("claude Stop: 'That's all', dismiss, and timeout all let the agent stop", async () => {
  for (const reply of [
    answered("That's all"),
    answered("dur"),
    { id: "q", status: "dismissed", answer: null, choiceIndex: null, via: "dismiss" } as AskResult,
    { id: "q", status: "timeout", answer: null, choiceIndex: null, via: "timeout" } as AskResult,
  ]) {
    const { deps } = fakeDeps(reply);
    const out = await runHook("claude", "stop", claudeStop(), deps);
    assert.equal(out.action, "stop");
    assert.equal(out.stdout, "");
  }
});

test("Stop: choices come only from the agent's own option list", async () => {
  const msg = "Migration is written.\n\nHow should I apply it?\n1. **Apply now**\n2. Expand, then contract\n3. Leave it for review";
  const { deps, asked } = fakeDeps(answered("Expand, then contract", 1));
  const out = await runHook("claude", "stop", JSON.stringify({ session_id: "s-opt", cwd: "/w/p", last_assistant_message: msg }), deps);
  assert.deepEqual(asked[0]!.choices, ["Apply now", "Expand, then contract", "Leave it for review"]);
  assert.equal(out.action, "continue");
  assert.match(JSON.parse(out.stdout).reason, /option 2.*Expand, then contract/);
});

test("choicesFromMessage: lists next to a question only", () => {
  assert.deepEqual(choicesFromMessage("Hangisini yapayım?\n- Testleri çalıştır\n- PR aç"), ["Testleri çalıştır", "PR aç"]);
  assert.deepEqual(choicesFromMessage("Options:\na) staging\nb) prod\nWhich one?"), ["staging", "prod"]);
  assert.deepEqual(choicesFromMessage("Done. Changes:\n- fixed the parser\n- added tests\n- updated README"), [], "a summary list is not a question");
  assert.deepEqual(choicesFromMessage("READY"), []);
  assert.deepEqual(choicesFromMessage("Should I deploy?\n1. yes"), [], "one item is not a choice");
});

test("claude Stop: falls back to the transcript for the last assistant text", async () => {
  const dir = tmp();
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done. Ship it?" }] } }),
      JSON.stringify({ type: "system", subtype: "stop" }),
    ].join("\n"),
  );
  const { deps, asked } = fakeDeps(answered("yes"));
  await runHook("claude", "stop", claudeStop({ last_assistant_message: undefined, transcript_path: transcript }), deps);
  assert.equal(asked[0]!.question, "All done. Ship it?");
});

test("loop guard: stop_hook_active chains stop at GLINT_HOOK_MAX_CHAIN, a fresh stop resets", async () => {
  const { deps, asked, notified } = fakeDeps(answered("again"), { GLINT_HOOK_MAX_CHAIN: "2" });
  const first = await runHook("claude", "stop", claudeStop(), deps);
  assert.equal(first.action, "continue");
  const second = await runHook("claude", "stop", claudeStop({ stop_hook_active: true }), deps);
  assert.equal(second.action, "continue");
  const third = await runHook("claude", "stop", claudeStop({ stop_hook_active: true }), deps);
  assert.equal(third.action, "stop");
  assert.equal(third.reason, "loop guard: chain limit reached");
  assert.equal(asked.length, 2, "no call is opened once the chain limit is hit");
  assert.equal(notified.length, 1);
  const fresh = await runHook("claude", "stop", claudeStop({ stop_hook_active: false }), deps);
  assert.equal(fresh.action, "continue");
});

test("a hook never hangs: the deadline aborts the ask and lets the agent stop", async () => {
  let aborted = false;
  const { deps } = fakeDeps(
    (_input, signal) =>
      new Promise<AskResult>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
    { GLINT_HOOK_TIMEOUT_MS: "20" },
  );
  const started = Date.now();
  const out = await runHook("claude", "stop", claudeStop(), deps);
  assert.equal(out.action, "stop");
  assert.equal(out.stdout, "");
  assert.ok(aborted, "the pending request is aborted so the panel closes");
  assert.ok(Date.now() - started < 4_000);
});

test("an unreachable daemon or GLINT_HOOK=0 is a quiet no-op", async () => {
  const down = fakeDeps(async () => {
    throw new Error("ECONNREFUSED");
  });
  const out = await runHook("claude", "stop", claudeStop(), down.deps);
  assert.equal(out.action, "stop");
  assert.equal(out.stdout, "");

  const off = fakeDeps(answered("x"), { GLINT_HOOK: "0" });
  const none = await runHook("agy", "stop", "{}", off.deps);
  assert.equal(none.action, "noop");
  assert.equal(off.asked.length, 0);
});

test("agy Stop: continue decision with the answer as reason; stop prints {}", async () => {
  const yes = fakeDeps(answered("Use the expand/contract plan"));
  const payload = JSON.stringify({ conversationId: "c-9", workspace: "/home/dev/glint", stopReason: "NO_TOOL_CALL", response: "I can apply the migration now or split it." });
  const out = await runHook("agy", "stop", payload, yes.deps);
  assert.deepEqual(Object.keys(JSON.parse(out.stdout)), ["decision", "reason"]);
  assert.equal(JSON.parse(out.stdout).decision, "continue");
  assert.match(JSON.parse(out.stdout).reason, /expand\/contract/);
  assert.equal(yes.asked[0]!.agent, "Antigravity");
  assert.equal(yes.asked[0]!.project, "glint");
  assert.equal(yes.asked[0]!.session, "c-9");

  const no = fakeDeps({ id: "q", status: "dismissed", answer: null, choiceIndex: null, via: "dismiss" });
  const stop = await runHook("agy", "stop", payload, no.deps);
  assert.equal(stop.stdout, "{}");
});

test("agy Stop: only a normal end of turn opens a call; executionNum drives the loop guard", async () => {
  const cancel = fakeDeps(answered("x"));
  const out = await runHook("agy", "stop", JSON.stringify({ conversationId: "c-1", cwd: "/w/p", terminationReason: "USER_CANCELED" }), cancel.deps);
  assert.equal(out.action, "stop");
  assert.equal(out.stdout, "{}");
  assert.equal(cancel.asked.length, 0);

  // agy 1.5.x keeps continuationActive=false; executionNum counts Stop runs in the turn.
  const keep = fakeDeps(answered("Keep going", 0));
  const base = { conversationId: "c-2", cwd: "/w/p", terminationReason: "NO_TOOL_CALL", continuationActive: false, response: "READY" };
  for (let n = 0; n < 8; n++) {
    const r = await runHook("agy", "stop", JSON.stringify({ ...base, executionNum: n }), keep.deps);
    assert.equal(JSON.parse(r.stdout).decision, "continue", `run ${n}`);
  }
  const capped = await runHook("agy", "stop", JSON.stringify({ ...base, executionNum: 8 }), keep.deps);
  assert.equal(capped.stdout, "{}", "the loop guard stops a 'keep going' loop");
  const nextTurn = await runHook("agy", "stop", JSON.stringify({ ...base, executionNum: 0 }), keep.deps);
  assert.equal(JSON.parse(nextTurn.stdout).decision, "continue", "a new turn starts over");
});

test("Stop: typed stop phrases end the turn instead of becoming the next message", async () => {
  for (const phrase of ["That's all", "that’s all.", "Stop", "bu kadar", "Tamam, bu kadar!", "BİTTİ"]) {
    const d = fakeDeps(answered(phrase));
    const out = await runHook("claude", "stop", JSON.stringify({ session_id: "s-stop", cwd: "/w/p", last_assistant_message: "Done." }), d.deps);
    assert.equal(out.action, "stop", phrase);
    assert.equal(out.stdout, "");
  }
  const go = fakeDeps(answered("Stop the server and restart it"));
  const out = await runHook("claude", "stop", JSON.stringify({ session_id: "s-go", cwd: "/w/p", last_assistant_message: "Done." }), go.deps);
  assert.equal(out.action, "continue", "longer instructions still continue");
});

test("codex rollout: a glint ask_user MCP call right before the stop is detected", () => {
  const dir = tmp();
  const file = path.join(dir, "rollout.jsonl");
  const line = (o: unknown) => JSON.stringify(o);
  const user = line({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [] } } });
  const exec = line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.mcp__glint__ask_user({question:'x'})" } });
  const mcp = line({ type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "glint", tool: "ask_user" } } });
  const out = line({ type: "response_item", payload: { type: "custom_tool_call_output", output: [] } });
  const msg = line({ type: "event_msg", payload: { type: "agent_message", message: "CHOSEN=Green" } });
  fs.writeFileSync(file, [user, exec, mcp, out, msg].join("\n"));
  assert.equal(lastToolWasGlintAsk(file), true);
  const shell = line({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' } });
  fs.writeFileSync(file, [user, exec, mcp, out, shell, msg].join("\n"));
  assert.equal(lastToolWasGlintAsk(file), false);
  fs.writeFileSync(file, [user, msg].join("\n"));
  assert.equal(lastToolWasGlintAsk(file), false);
});

test("codex: Stop uses the block format, notify posts to the feed only", async () => {
  const stop = fakeDeps(answered("run the linter too"));
  const out = await runHook(
    "codex",
    "stop",
    JSON.stringify({ session_id: "th-1", cwd: "/w/api", stop_hook_active: false, last_assistant_message: "Done." }),
    stop.deps,
  );
  assert.equal(JSON.parse(out.stdout).decision, "block");

  const notify = fakeDeps(answered("unused"));
  const note = await runHook(
    "codex",
    "notify",
    JSON.stringify({ type: "agent-turn-complete", "thread-id": "th-1", cwd: "/w/api", "last-assistant-message": "Tests pass." }),
    notify.deps,
  );
  assert.equal(note.stdout, "");
  assert.equal(notify.asked.length, 0);
  assert.equal(notify.notified[0]!.message, "Tests pass.");
  assert.equal(notify.notified[0]!.session, "th-1");
  assert.equal(notify.notified[0]!.agent, "Codex");
});

test("opencode idle: plugin-supplied chain and continue/stop actions", async () => {
  const go = fakeDeps(answered("now write the docs"));
  const payload = (chain: number) =>
    JSON.stringify({ sessionID: "ses_1", cwd: "/w/glint", last_assistant_message: "Feature done.", chain });
  const out = await runHook("opencode", "stop", payload(0), go.deps);
  assert.deepEqual(JSON.parse(out.stdout).action, "continue");
  assert.match(JSON.parse(out.stdout).prompt, /now write the docs/);

  const capped = fakeDeps(answered("x"), { GLINT_HOOK_MAX_CHAIN: "3" });
  const stop = await runHook("opencode", "stop", payload(3), capped.deps);
  assert.deepEqual(JSON.parse(stop.stdout), { action: "stop" });
  assert.equal(capped.asked.length, 0);
});

test("PreToolUse approvals map to each harness's permission JSON", async () => {
  const pre = JSON.stringify({ session_id: "s", cwd: "/w/x", tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  const allow = fakeDeps(answered(APPROVAL_CHOICES[0], 0));
  const a = await runHook("claude", "pretooluse", pre, allow.deps);
  assert.equal(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.match(allow.asked[0]!.question, /Bash: rm -rf build/);
  assert.equal(allow.asked[0]!.kind, "approval");

  const deny = fakeDeps(answered(APPROVAL_CHOICES[1], 1));
  const d = await runHook("claude", "pretooluse", pre, deny.deps);
  assert.equal(JSON.parse(d.stdout).hookSpecificOutput.permissionDecision, "deny");

  const feedback = fakeDeps(answered("use make clean instead"));
  const f = await runHook("agy", "pretooluse", pre, feedback.deps);
  assert.deepEqual(JSON.parse(f.stdout).decision, "deny");
  assert.match(JSON.parse(f.stdout).reason, /make clean/);

  const later = fakeDeps({ id: "q", status: "timeout", answer: null, choiceIndex: null, via: "timeout" });
  const t = await runHook("claude", "pretooluse", pre, later.deps);
  assert.equal(t.action, "noop");
  assert.equal(t.stdout, "", "a timed-out approval falls back to the harness's own prompt");
});

test("normalizeHookInput reads session/cwd/last message from many shapes", () => {
  const n = normalizeHookInput({ "thread-id": "t", cwd: "/a/b", "last-assistant-message": "m" });
  assert.equal(n.session, "t");
  assert.equal(n.cwd, "/a/b");
  assert.equal(n.lastMessage, "m");
  const m = normalizeHookInput({ trajectoryId: "x", workspace_roots: ["/r/one"], lastMessage: "hey" }, "/fallback");
  assert.equal(m.session, "x");
  assert.equal(m.cwd, "/r/one");
  const empty = normalizeHookInput({}, "/fallback");
  assert.equal(empty.cwd, "/fallback");
});

test("glint hook CLI end to end: stdin JSON in, Claude JSON out, answer from the daemon", { timeout: 30_000 }, async () => {
  const home = tmp();
  const daemon = await createDaemon({ stateFile: path.join(home, "daemon.json") });
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "hook", "claude", "Stop"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, GLINT_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stdin.end(claudeStop({ session_id: "cli-1" }));
    const start = Date.now();
    while (daemon.pending().length === 0) {
      if (Date.now() - start > 20_000) throw new Error("hook never opened a call");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const call = daemon.pending()[0]!;
    assert.equal(call.kind, "stop");
    assert.equal(call.caller.name, "Claude Code");
    assert.match(call.caller.tag, /^[0-9a-z]{4}$/);
    daemon.settle({ id: call.id, status: "answered", answer: "yes, apply it", via: "text" });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
    const json = JSON.parse(stdout) as { decision: string; reason: string };
    assert.equal(json.decision, "block");
    assert.match(json.reason, /yes, apply it/);
  } finally {
    await daemon.close();
  }
});

test("hook against a real daemon via askUser: dismissed call stops cleanly", async () => {
  const home = tmp();
  const daemon = await createDaemon({ stateFile: path.join(home, "daemon.json") });
  try {
    const deps: HookDeps = {
      stateDir: home,
      env: {},
      ask: (input, signal) => askUser(input, { home, signal, spawn: false }),
      notify: async () => ({}),
    };
    const pending = runHook("agy", "stop", JSON.stringify({ conversationId: "c", workspace: "/w/p", response: "hi" }), deps);
    while (daemon.pending().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    daemon.settle({ id: daemon.pending()[0]!.id, status: "dismissed" });
    const out = await pending;
    assert.equal(out.action, "stop");
    assert.equal(out.stdout, "{}");
  } finally {
    await daemon.close();
  }
});

test("no double ring: if the agent's last tool this turn was glint ask_user, the Stop hook stays quiet", async () => {
  const dir = tmp();
  const transcript = path.join(dir, "t.jsonl");
  const lines = (lastTool: string) =>
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "do the thing" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "1", input: {} }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "1" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: lastTool, id: "2", input: {} }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "2" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK, stopping here." }] } }),
    ].join("\n");
  fs.writeFileSync(transcript, lines("mcp__glint__ask_user"));
  const quiet = fakeDeps(answered("x"));
  const out = await runHook("claude", "stop", claudeStop({ last_assistant_message: undefined, transcript_path: transcript }), quiet.deps);
  assert.equal(out.action, "stop");
  assert.equal(quiet.asked.length, 0);

  fs.writeFileSync(transcript, lines("Edit"));
  const rings = fakeDeps(answered("x"));
  await runHook("claude", "stop", claudeStop({ last_assistant_message: undefined, transcript_path: transcript }), rings.deps);
  assert.equal(rings.asked.length, 1, "work after the last glint call still rings when the agent stops");
  assert.equal(rings.asked[0]!.question, "OK, stopping here.");

  const oc = fakeDeps(answered("x"));
  await runHook("opencode", "stop", JSON.stringify({ sessionID: "s", cwd: "/w", glint_consulted: true, chain: 0 }), oc.deps);
  assert.equal(oc.asked.length, 0);
});
