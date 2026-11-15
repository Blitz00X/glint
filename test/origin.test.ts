import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDaemon } from "../src/daemon.js";
import { askUser } from "../src/client.js";
import { lastUserPrompt, runHook, type HookDeps } from "../src/hooks.js";
import { jumpTo, type JumpDeps } from "../src/jump.js";
import { captureOrigin, cdCommand, classifyProcess, gitBranch, originLine, originSchema, type OriginDeps, type ProcInfo } from "../src/origin.js";
import type { AskInput, Question } from "../src/protocol.js";

function fakeOriginDeps(procs: ProcInfo[], extra: Partial<OriginDeps> = {}): OriginDeps {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return {
    env: {},
    pid: procs[0]!.pid,
    cwd: "/work/payments",
    proc: (pid) => byPid.get(pid) ?? null,
    tty: (pid) => (pid === 300 ? "pts/4" : null),
    environ: () => null,
    run: () => null,
    branch: (cwd) => (cwd === "/work/payments" ? "feat/refunds" : null),
    ...extra,
  };
}

const P = (pid: number, ppid: number, comm: string, cmdline = comm): ProcInfo => ({ pid, ppid, comm, cmdline });

test("origin: a CLI agent in a GNOME Terminal tab", () => {
  const deps = fakeOriginDeps(
    [P(400, 350, "node", "node glint mcp"), P(350, 300, "claude"), P(300, 75, "bash"), P(75, 1, "gnome-terminal-", "/usr/libexec/gnome-terminal-server")],
    { env: { GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/370082f7_c44b_4ea2_bdc1_148300d7cbe3" } },
  );
  const o = captureOrigin({ title: "  fix the\n refund   bug " }, deps);
  assert.equal(o.app, "GNOME Terminal");
  assert.equal(o.kind, "gnome-terminal");
  assert.equal(o.gnomeScreen, "370082f7-c44b-4ea2-bdc1-148300d7cbe3");
  assert.equal(o.pid, 75);
  assert.equal(o.tty, "pts/4");
  assert.equal(o.branch, "feat/refunds");
  assert.equal(o.title, "fix the refund bug");
  assert.equal(originLine(o), "payments ⎇ feat/refunds · GNOME Terminal · pts/4");
  assert.ok(originSchema.safeParse(o).success);
});

test("origin: Codex Desktop and Claude Desktop climb to the app's main process", () => {
  const codex = captureOrigin(
    {},
    fakeOriginDeps([P(10, 20, "node", "node glint mcp"), P(20, 30, "codex", "/usr/lib/chatgpt/resources/codex app-server"), P(30, 7, "ChatGPT", "/usr/lib/chatgpt/ChatGPT"), P(7, 1, "gnome-shell", "/usr/bin/gnome-shell")]),
  );
  assert.equal(codex.app, "Codex Desktop");
  assert.equal(codex.kind, "desktop");
  assert.equal(codex.pid, 30);
  const claude = captureOrigin(
    {},
    fakeOriginDeps([
      P(10, 20, "node", "node glint mcp"),
      P(20, 21, "claude", "/home/u/.config/Claude/claude-code/2.1/claude --output-format stream-json"),
      P(21, 22, "disclaimer", "/usr/lib/claude-desktop/resources/disclaimer --pgroup"),
      P(22, 7, "claude-desktop", "/usr/lib/claude-desktop/claude-desktop"),
      P(7, 1, "gnome-shell"),
    ]),
  );
  assert.equal(claude.app, "Claude Desktop");
  assert.equal(claude.pid, 22);
  assert.equal(originLine(claude), "payments ⎇ feat/refunds · Claude Desktop");
});

test("origin: tmux pane, and the terminal that shows its client", () => {
  const calls: string[][] = [];
  const deps = fakeOriginDeps([P(10, 9, "node"), P(9, 8, "zsh"), P(8, 1, "tmux: server")], {
    env: { TMUX: "/tmp/tmux-1000/default,1234,0", TMUX_PANE: "%7" },
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("display-message")) return "work:2.1";
      if (args.includes("list-clients")) return "500";
      return null;
    },
    environ: (pid) => (pid === 500 ? { GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/16c2dc96_0db3_439f_8f11_9602e9377f57" } : null),
    proc: (pid) => ({ 10: P(10, 9, "node"), 9: P(9, 8, "zsh"), 8: P(8, 1, "tmux: server"), 500: P(500, 300, "tmux: client"), 300: P(300, 75, "bash"), 75: P(75, 1, "gnome-terminal-", "/usr/libexec/gnome-terminal-server") } as Record<number, ProcInfo>)[pid] ?? null,
  });
  const o = captureOrigin({}, deps);
  assert.deepEqual(o.tmux, { socket: "/tmp/tmux-1000/default", pane: "%7", target: "work:2.1" });
  assert.equal(o.kind, "tmux");
  assert.equal(o.app, "tmux · GNOME Terminal");
  assert.equal(o.gnomeScreen, "16c2dc96-0db3-439f-8f11-9602e9377f57");
  assert.equal(originLine(o), "payments ⎇ feat/refunds · tmux · GNOME Terminal work:2.1");
  assert.ok(calls.every((c) => c[0] === "tmux" && c[1] === "-S"));
});

test("origin: VS Code / Cursor integrated terminals are recognized from the environment", () => {
  const procs = [P(10, 9, "node"), P(9, 1, "bash")];
  assert.equal(captureOrigin({}, fakeOriginDeps(procs, { env: { TERM_PROGRAM: "vscode" } })).app, "VS Code");
  assert.equal(captureOrigin({}, fakeOriginDeps(procs, { env: { TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_NODE: "/opt/cursor/cursor" } })).app, "Cursor");
  assert.equal(captureOrigin({}, fakeOriginDeps(procs)).kind, "unknown");
  assert.deepEqual(classifyProcess({ comm: "kitty", cmdline: "kitty" }), { app: "kitty", kind: "terminal" });
});

test("origin: git branch from .git/HEAD, worktrees and detached heads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-git-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  assert.equal(gitBranch(path.join(root, "src", "deep")), "main");
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "glint-wt-"));
  fs.mkdirSync(path.join(root, ".git", "worktrees", "x"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "x", "HEAD"), "0123456789abcdef\n");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "x")}\n`);
  assert.equal(gitBranch(wt), "01234567");
  assert.equal(gitBranch(os.tmpdir()), null);
});

test("cdCommand quotes safely", () => {
  assert.equal(cdCommand("/a b/it's"), `cd '/a b/it'\\''s'`);
});

test("origin schema rejects injection-shaped values", () => {
  assert.equal(originSchema.safeParse({ tmux: { socket: "/s", pane: "%1; rm -rf ~" } }).success, false);
  assert.equal(originSchema.safeParse({ windowId: "$(id)" }).success, false);
  assert.equal(originSchema.safeParse({ gnomeScreen: "../../x" }).success, false);
});

function fakeJump(ok: (cmd: string, args: string[]) => { ok: boolean; stdout?: string }) {
  const ran: string[][] = [];
  const copied: string[] = [];
  const deps: JumpDeps = {
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      const r = ok(cmd, args);
      return { ok: r.ok, stdout: r.stdout ?? "" };
    },
    copy: (t) => copied.push(t),
    now: () => 1_000_000,
  };
  return { deps, ran, copied };
}

test("jump: GNOME Terminal tab via its search provider", async () => {
  const { deps, ran } = fakeJump(() => ({ ok: true }));
  const r = await jumpTo({ gnomeScreen: "370082f7-c44b-4ea2-bdc1-148300d7cbe3", pid: 75, app: "GNOME Terminal" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.method, "gnome-terminal");
  assert.deepEqual(ran[0]!.slice(0, 2), ["gdbus", "call"]);
  assert.ok(ran[0]!.includes("org.gnome.Shell.SearchProvider2.ActivateResult"));
  assert.ok(ran[0]!.includes("370082f7-c44b-4ea2-bdc1-148300d7cbe3"));
  assert.ok(ran[0]!.includes("1000"));
});

test("jump: tmux selects the pane, then raises the terminal; X11 apps by pid", async () => {
  const { deps, ran } = fakeJump((cmd) => ({ ok: cmd === "tmux" || cmd === "wmctrl", stdout: cmd === "wmctrl" ? "0x01200012  0 2279916 device ChatGPT\n0x0444  0 99 device Other" : "" }));
  const r = await jumpTo({ tmux: { socket: "/tmp/s", pane: "%3" }, pid: 2279916, app: "Codex Desktop" }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.method, "x11-pid");
  assert.deepEqual(ran[0], ["tmux", "-S", "/tmp/s", "select-window", "-t", "%3"]);
  assert.ok(ran.some((c) => c.join(" ") === "wmctrl -i -a 0x01200012"));
  assert.ok(!ran.some((c) => c.includes("0x0444")));
});

test("jump: nothing focusable copies a cd command; bad input does nothing", async () => {
  const { deps, copied } = fakeJump(() => ({ ok: false }));
  const r = await jumpTo({ cwd: "/work/pay ments", tty: "pts/9", pid: 5 }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.method, "copy");
  assert.deepEqual(copied, ["cd '/work/pay ments'"]);
  assert.match(r.message, /pts\/9/);
  const bad = fakeJump(() => ({ ok: true }));
  const r2 = await jumpTo({ tmux: { socket: "/s", pane: "%1;reboot" } }, bad.deps);
  assert.equal(r2.ok, false);
  assert.equal(bad.ran.length, 0);
});

test("lastUserPrompt: payload title first, else the last typed message in a Claude transcript", () => {
  assert.equal(lastUserPrompt({ session_title: "Refactor auth" }), "Refactor auth");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-tr-"));
  const file = path.join(dir, "t.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: "add refunds to the API" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
    { type: "user", message: { role: "user", content: "<system-reminder>ignore</system-reminder>" } },
    { type: "user", message: { role: "user", content: 'Stop hook feedback:\nThe user replied through Glint: "go"' } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(lastUserPrompt({ transcript_path: file }), "add refunds to the API");
});

test("hook: the call carries the origin, and the daemon keeps it on the caller", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-o-"));
  const seen: Question[] = [];
  const daemon = await createDaemon({ stateFile: path.join(home, "daemon.json"), sink: { question: (q) => seen.push(q), notice: () => {}, resolved: () => {} } });
  try {
    const asked: AskInput[] = [];
    const deps: HookDeps = {
      stateDir: home,
      env: { GNOME_TERMINAL_SCREEN: "/org/gnome/Terminal/screen/370082f7_c44b_4ea2_bdc1_148300d7cbe3" },
      ask: (input, signal) => {
        asked.push(input);
        return askUser(input, { home, signal, spawn: false });
      },
      notify: async () => ({}),
    };
    const run = runHook(
      "claude",
      "stop",
      JSON.stringify({ session_id: "s", cwd: process.cwd(), stop_hook_active: false, last_assistant_message: "Done. Should I push?", title: "ship it" }),
      deps,
    );
    while (seen.length === 0) await new Promise((r) => setTimeout(r, 10));
    const origin = seen[0]!.caller.origin!;
    assert.equal(origin.gnomeScreen, "370082f7-c44b-4ea2-bdc1-148300d7cbe3");
    assert.equal(origin.title, "ship it");
    assert.equal(origin.cwd, process.cwd());
    daemon.settle({ id: seen[0]!.id, status: "dismissed" });
    await run;
    assert.equal(asked[0]!.origin?.title, "ship it");
  } finally {
    await daemon.close();
  }
});
