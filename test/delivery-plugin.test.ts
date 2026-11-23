import assert from "node:assert/strict";
import test from "node:test";
import { glintDeliveryMode, type ProcessSnapshot } from "../src/suppress.js";
// The installed plugin is standalone JS; keep its resolver in parity with the CLI.
const plugin = await import("../plugins/opencode/glint-v2.js" as string);

test("standalone OpenCode resolver matches CLI for modes, headless ancestors and prompt boundaries", () => {
  const cases = [
    ["codex", "exec", "work"], ["claude", "-p", "work"], ["claude", "--print", "work"],
    ["agy", "-p", "work"], ["agy", "--print", "work"],
    ["gemini", "-p", "work"], ["gemini", "--prompt", "work"], ["opencode", "run", "work"],
    ["node", "/opt/claude", "--print", "work"], ["codex", "-C", "/w", "exec", "work"],
    ["claude", "--model", "-p"], ["codex", "--config", "exec"],
    ["claude", "explain -p", "--print"], ["codex", "--", "exec"],
    ["echo", "claude", "-p"], ["bash", "-lc", "codex exec"], ["opencode"], ["takopi"],
  ];
  for (const argv of cases) {
    const proc = (pid: number): ProcessSnapshot | null => pid === 10 ? { comm: argv[0]!, argv, ppid: 1 } : null;
    for (const env of [{}, { GLINT_MODE: "ring" }, { GLINT_MODE: "notify" }, { GLINT_MODE: "off" }, { GLINT_MODE: "ring", GLINT_SUPPRESS: "1" }, { AGENTOS_TRANSPORT: " Takopi " }]) {
      const options = { env, ppid: 10, proc };
      assert.equal(plugin.deliveryMode(options), glintDeliveryMode(options).mode, JSON.stringify({ argv, env }));
    }
  }
});

test("OpenCode v2: off is silent; notify keeps background guard and native questions", async (t) => {
  const childProcess = await import("node:child_process");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { syncBuiltinESMExports } = await import("node:module");
  const { runHook } = await import("../src/hooks.js");
  const priorMode = process.env.GLINT_MODE;
  const priorSuppress = process.env.GLINT_SUPPRESS;
  const priorTransport = process.env.AGENTOS_TRANSPORT;
  delete process.env.GLINT_SUPPRESS;
  delete process.env.AGENTOS_TRANSPORT;
  const messages: string[] = [];
  const asks: string[] = [];
  const spawns: string[] = [];
  const spawn = t.mock.method(childProcess.default, "spawn", (_node: string, argv: string[]) => {
    spawns.push(argv.at(-1)!);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() {} });
    let raw = "";
    child.stdin.on("data", (chunk) => { raw += chunk; });
    child.stdin.on("end", () => {
      void runHook("opencode", "stop", raw, {
        env: { GLINT_MODE: process.env.GLINT_MODE, GLINT_ORIGIN: "0" },
        ask: async (input) => { asks.push(input.question); throw new Error("must not ask"); },
        notify: async (input) => { messages.push(input.message); },
      }).then((out) => { child.stdout.write(out.stdout); child.emit("close", 0); });
    });
    return child;
  });
  syncBuiltinESMExports();
  let cleanup = () => {};
  t.after(() => {
    cleanup();
    spawn.mock.restore();
    syncBuiltinESMExports();
    if (priorSuppress === undefined) delete process.env.GLINT_SUPPRESS;
    else process.env.GLINT_SUPPRESS = priorSuppress;
    if (priorTransport === undefined) delete process.env.AGENTOS_TRANSPORT;
    else process.env.AGENTOS_TRANSPORT = priorTransport;
    if (priorMode === undefined) delete process.env.GLINT_MODE;
    else process.env.GLINT_MODE = priorMode;
  });
  process.env.GLINT_MODE = "off";
  let idle: (input: unknown) => Promise<void> = async () => { throw new Error("hook missing"); };
  let nativeQuestions = 0;
  let synthetic = 0;
  const question = { execute: async () => { nativeQuestions++; return "native answer"; } };
  const message = "  # Done\r\n" + "result\n".repeat(600) + "  ";
  cleanup = await plugin.default.setup({
    location: { directory: "/w/p" },
    tool: { transform: async (fn: Function) => fn({ get: () => question, update: (_name: string, update: Function) => update(question) }) },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
      yield { type: "session.text.ended", data: { sessionID: "mode-session", text: message } };
    } }) },
    session: {
      hook: async (_name: string, fn: typeof idle) => { idle = fn; },
      get: async () => ({ id: "mode-session" }),
      synthetic: async () => { synthetic++; }, prompt: async () => { synthetic++; },
    },
  });
  await idle({ sessionID: "mode-session", background: [] });
  assert.equal(spawns.length, 0);
  for (const mode of ["off", "notify"]) {
    process.env.GLINT_MODE = mode;
    await (question.execute as Function)({ questions: [{ question: "Ship?" }] }, { sessionID: "mode-session" });
    assert.equal(spawns.length, 0, "native question tool is untouched");
  }
  await idle({ sessionID: "mode-session", background: [{ sessionID: "mode-session" }] });
  assert.equal(spawns.length, 0);
  await idle({ sessionID: "mode-session", background: [] });
  assert.deepEqual(messages, [message]);
  assert.deepEqual(asks, []);
  assert.equal(nativeQuestions, 2);
  assert.equal(synthetic, 0);
});
