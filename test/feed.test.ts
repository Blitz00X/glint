import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { askUser, getEvents, notifyUser } from "../src/client.js";
import { createDaemon } from "../src/daemon.js";
import { callerFor, SESSION_PALETTE, sessionColor, sessionTag } from "../src/identity.js";
import type { FeedEvent } from "../src/protocol.js";

test("session identity: stable tag and color, different per session", () => {
  const a1 = sessionTag("claude", "/home/k/api", "s-1");
  const a2 = sessionTag("claude", "/home/k/api", "s-1");
  const b = sessionTag("claude", "/home/k/api", "s-2");
  const c = sessionTag("codex", "/home/k/api", "s-1");
  assert.equal(a1, a2);
  assert.match(a1, /^[0-9a-z]{4}$/);
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
  assert.ok((SESSION_PALETTE as readonly string[]).includes(sessionColor("claude", "/home/k/api", "s-1")));
  const tags = new Set(Array.from({ length: 200 }, (_, i) => sessionTag("opencode", "/w", `ses_${i}`)));
  assert.ok(tags.size > 195, "4-char tags rarely collide");
  const colors = new Set(Array.from({ length: 200 }, (_, i) => sessionColor("opencode", "/w", `ses_${i}`)));
  assert.equal(colors.size, SESSION_PALETTE.length, "sessions spread over the whole palette");
});

test("callerFor names the harness and falls back to agent+project", () => {
  const hooked = callerFor({ harness: "agy", project: "glint", session: "c-1", cwd: "/home/k/glint" });
  assert.equal(hooked.name, "Antigravity");
  assert.equal(hooked.harness, "agy");
  const viaMcp = callerFor({ agent: "Claude Code", project: "glint" });
  assert.equal(viaMcp.harness, "claude");
  assert.deepEqual(callerFor({ agent: "Claude Code", project: "glint" }), viaMcp);
  assert.notEqual(callerFor({ agent: "Claude Code", project: "other" }).tag, viaMcp.tag);
});

test("feed keeps calls, answers, and notices in order with caller identity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-feed-"));
  const live: FeedEvent[] = [];
  const daemon = await createDaemon({
    stateFile: path.join(home, "daemon.json"),
    sink: { question: () => {}, notice: () => {}, resolved: () => {}, event: (event) => live.push(event) },
  });
  try {
    await notifyUser({ message: "Tests green.", agent: "Codex", project: "api", session: "t-1", harness: "codex" }, { home });
    const ask = askUser({ question: "Ship?", choices: ["Yes", "No"], agent: "OpenCode", project: "web", session: "ses_9", harness: "opencode", kind: "stop" }, { home });
    while (daemon.pending().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const q = daemon.pending()[0]!;
    assert.equal(q.caller.name, "OpenCode");
    assert.equal(q.caller.tag, sessionTag("opencode", "web", "ses_9"));
    assert.equal(q.kind, "stop");
    daemon.settle({ id: q.id, status: "answered", choiceIndex: 0, via: "choice" });
    await ask;

    const events = await getEvents(0, { home, spawn: false });
    assert.deepEqual(events.map((e) => e.type), ["notice", "call", "answer"]);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(events[0]!.text, "Tests green.");
    assert.equal(events[0]!.caller.name, "Codex");
    assert.deepEqual(events[1]!.choices, ["Yes", "No"]);
    assert.equal(events[2]!.text, "Yes");
    assert.equal(events[2]!.status, "answered");
    assert.equal(events[2]!.ref, events[1]!.ref);
    assert.equal(events[1]!.caller.tag, events[2]!.caller.tag);
    assert.deepEqual(live.map((e) => e.seq), [1, 2, 3], "the overlay gets every event live");

    const newer = await getEvents(2, { home, spawn: false });
    assert.deepEqual(newer.map((e) => e.seq), [3]);

    const bare = await fetch(`${daemon.baseUrl}/v1/events`);
    assert.equal(bare.status, 401);
  } finally {
    await daemon.close();
  }
});

test("feed is a ring buffer and records timeouts and dropped calls", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-feed-"));
  const daemon = await createDaemon({ stateFile: path.join(home, "daemon.json"), maxEvents: 5 });
  try {
    for (let i = 0; i < 6; i++) await notifyUser({ message: `n${i}`, agent: "Codex" }, { home });
    const timedOut = await askUser({ question: "Quick?", timeoutMs: 20, agent: "Codex" }, { home });
    assert.equal(timedOut.status, "timeout");
    const events = daemon.events();
    assert.equal(events.length, 5);
    assert.equal(events.at(-1)!.type, "answer");
    assert.equal(events.at(-1)!.status, "timeout");
    assert.equal(events.at(-1)!.text, "no answer (timed out)");
    assert.equal(events[0]!.text, "n3");
  } finally {
    await daemon.close();
  }
});
