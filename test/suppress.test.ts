import assert from "node:assert/strict";
import test from "node:test";
import { glintDeliveryMode, glintSuppressed, isTakopiProcess, sessionSuppressed, type ProcessSnapshot } from "../src/suppress.js";

function tree(entries: Record<number, ProcessSnapshot>) {
  return (pid: number) => entries[pid] ?? null;
}

const agent: ProcessSnapshot = { comm: "node", ppid: 9, argv: ["node", "/home/k/glint/dist/cli.js", "mcp"] };
const opencode: ProcessSnapshot = { comm: "opencode", ppid: 8, argv: ["opencode", "run", "--", "Takopiden gelen mesaj"] };
const takopi: ProcessSnapshot = { comm: "takopi", ppid: 1, argv: ["/v/bin/python", "/v/bin/takopi", "--no-onboard"] };
const systemd: ProcessSnapshot = { comm: "systemd", ppid: 0, argv: ["systemd"] };

test("suppression: explicit flag and transport marker win without /proc", () => {
  const proc = () => null;
  assert.equal(glintSuppressed({ env: { GLINT_SUPPRESS: "1" }, proc }).suppressed, true);
  assert.equal(glintSuppressed({ env: { AGENTOS_TRANSPORT: "takopi" }, proc }).suppressed, true);
  assert.equal(glintSuppressed({ env: { AGENTOS_TRANSPORT: " Takopi " }, proc }).suppressed, true);
  assert.equal(glintSuppressed({ env: {}, proc }).suppressed, false);
});

test("suppression: a takopi ancestor is enough, even without an env marker", () => {
  const decision = glintSuppressed({
    env: {},
    ppid: 10,
    proc: tree({ 10: agent, 9: opencode, 8: takopi, 1: systemd }),
  });
  assert.equal(decision.suppressed, true);
  assert.match(decision.reason ?? "", /takopi/);
});

test("suppression: an agent prompt that mentions takopi is not an ancestor match", () => {
  const decision = glintSuppressed({
    env: {},
    ppid: 10,
    proc: tree({
      10: agent,
      9: { ...opencode, argv: ["opencode", "takopi hakkında bir soru"] },
      8: { comm: "bash", ppid: 1, argv: ["bash", "-l"] },
      1: systemd,
    }),
  });
  assert.equal(decision.suppressed, false);
});

test("suppression: python/uv launches are recognized by executable position only", () => {
  assert.equal(isTakopiProcess({ comm: "python3", ppid: 1, argv: ["python3", "/v/bin/takopi"] }), true);
  assert.equal(isTakopiProcess({ comm: "python3", ppid: 1, argv: ["python3", "-m", "takopi"] }), true);
  assert.equal(isTakopiProcess({ comm: "uv", ppid: 1, argv: ["uv", "run", "takopi"] }), true);
  assert.equal(isTakopiProcess({ comm: "bash", ppid: 1, argv: ["bash", "-lc", "echo takopi"] }), false);
});

test("suppression: the walk stops cleanly at a dead pid", () => {
  assert.equal(glintSuppressed({ env: {}, ppid: 999, proc: tree({}) }).suppressed, false);
});

test("suppression: a muted session id is exact and ignores comments", () => {
  const read = () => "# Telegram turları\n\nses_a\n  ses_b  \n";
  assert.equal(sessionSuppressed("ses_a", { home: "/tmp/glint-test", read }), true);
  assert.equal(sessionSuppressed("ses_b", { home: "/tmp/glint-test", read }), true);
  assert.equal(sessionSuppressed("ses_", { home: "/tmp/glint-test", read }), false);
  assert.equal(sessionSuppressed("ses_a2", { home: "/tmp/glint-test", read }), false);
  assert.equal(sessionSuppressed("", { home: "/tmp/glint-test", read }), false);
});

const headlessCases = [
  ["codex", "exec", "do work"], ["/opt/codex", "-C", "/w", "exec", "work"],
  ["claude", "-p", "work"], ["claude", "--print", "work"],
  ["agy", "-p", "work"], ["agy", "--print", "work"],
  ["gemini", "-p", "work"], ["gemini", "--prompt", "work"],
  ["opencode", "run", "work"], ["node", "/opt/claude", "--print", "work"],
];

test("delivery mode: every headless executable/flag pattern is off", () => {
  for (const argv of headlessCases) {
    const proc = tree({ 10: { comm: "node", argv, ppid: 1 } });
    assert.equal(glintDeliveryMode({ env: {}, ppid: 10, proc }).mode, "off", JSON.stringify(argv));
  }
});

test("delivery mode: env wins over headless detection; suppression remains off", () => {
  const proc = tree({ 10: { comm: "codex", argv: ["codex", "exec", "work"], ppid: 1 } });
  for (const mode of ["ring", "notify", "off"] as const) {
    assert.equal(glintDeliveryMode({ env: { GLINT_MODE: mode }, ppid: 10, proc }).mode, mode);
  }
  for (const env of [{ GLINT_MODE: "ring", GLINT_SUPPRESS: "1" }, { GLINT_MODE: "notify", AGENTOS_TRANSPORT: "takopi" }]) {
    assert.equal(glintDeliveryMode({ env, ppid: 10, proc }).mode, "off");
  }
  assert.equal(glintDeliveryMode({ env: { GLINT_MODE: "ring" }, ppid: 10, proc: tree({10: takopi}) }).mode, "off");
});

test("delivery mode: interactive sessions and prompt contents do not match", () => {
  for (const argv of [
    ["codex"], ["claude"], ["agy"], ["gemini"], ["opencode"],
    ["codex", "explain exec and -p"], ["codex", "--", "exec"],
    ["claude", "explain -p", "--print"], ["agy", "--", "-p"],
    ["claude", "--model", "-p"], ["codex", "--config", "exec"],
    ["bash", "-lc", "codex exec work"], ["echo", "claude", "-p"],
  ]) {
    assert.equal(glintDeliveryMode({ env: {}, ppid: 10, proc: tree({10: {comm: "node", argv, ppid: 1}}) }).mode, "ring", JSON.stringify(argv));
  }
});
