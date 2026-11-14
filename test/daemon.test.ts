import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { askUser, notifyUser } from "../src/client.js";
import { createDaemon, type DaemonHandle } from "../src/daemon.js";
import type { Question } from "../src/protocol.js";

async function withDaemon(fn: (ctx: { home: string; daemon: DaemonHandle; seen: Question[] }) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-"));
  const seen: Question[] = [];
  const daemon = await createDaemon({
    stateFile: path.join(home, "daemon.json"),
    sink: { question: (question) => seen.push(question), notice: () => {}, resolved: () => {} },
  });
  try {
    await fn({ home, daemon, seen });
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(message);
}

test("health requires the bearer token and reports pending questions", async () => {
  await withDaemon(async ({ daemon }) => {
    const bare = await fetch(`${daemon.baseUrl}/v1/health`);
    assert.equal(bare.status, 401);
    const authed = await fetch(`${daemon.baseUrl}/v1/health`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(authed.status, 200);
    const body = (await authed.json()) as { ok: boolean; pending: number };
    assert.equal(body.ok, true);
    assert.equal(body.pending, 0);
  });
});

test("ask_user blocks until the overlay settles, including two at once", async () => {
  await withDaemon(async ({ home, daemon, seen }) => {
    const first = askUser(
      { question: "Ship the migration?", choices: ["Apply it now", "Not yet"], agent: "Codex", project: "payments-api" },
      { home },
    );
    const second = askUser({ question: "Which runner?", choices: ["vitest", "node:test"], agent: "Cursor" }, { home });
    await waitFor(() => daemon.pending().length === 2, "both questions should be pending");
    assert.equal(seen.length, 2);
    assert.deepEqual(
      daemon.pending().map((question) => question.agent).sort(),
      ["Codex", "Cursor"],
    );

    const pending = daemon.pending();
    const ship = pending.find((question) => question.question.startsWith("Ship"));
    const runner = pending.find((question) => question.question.startsWith("Which"));
    assert.ok(ship && runner);
    assert.deepEqual(daemon.settle({ id: runner.id, status: "answered", choiceIndex: 1, via: "choice" }), {
      ok: true,
      result: {
        id: runner.id,
        status: "answered",
        answer: "node:test",
        choiceIndex: 1,
        via: "choice",
      },
    });
    assert.equal(daemon.settle({ id: ship.id, status: "dismissed", via: "dismiss" }).ok, true);
    assert.equal(daemon.settle({ id: ship.id, status: "dismissed", via: "dismiss" }).ok, false);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "dismissed");
    assert.equal(firstResult.via, "dismiss");
    assert.equal(secondResult.answer, "node:test");
    assert.equal(secondResult.choiceIndex, 1);
    assert.equal(daemon.pending().length, 0);
  });
});

test("free text is returned and a matching choice keeps its index", async () => {
  await withDaemon(async ({ home, daemon }) => {
    const pending = askUser({ question: "Name the hotkey", choices: ["ctrl+shift+g"] }, { home });
    await waitFor(() => daemon.pending().length === 1, "question pending");
    const id = daemon.pending()[0]?.id ?? "";
    daemon.settle({ id, status: "answered", answer: "ctrl+shift+g", via: "text" });
    const result = await pending;
    assert.equal(result.via, "text");
    assert.equal(result.answer, "ctrl+shift+g");
    assert.equal(result.choiceIndex, 0);
  });
});

test("timeout resolves the ask and clears the panel", async () => {
  await withDaemon(async ({ home, daemon }) => {
    const result = await askUser({ question: "You there?", timeoutMs: 80 }, { home });
    assert.equal(result.status, "timeout");
    assert.equal(result.via, "timeout");
    assert.equal(daemon.pending().length, 0);
  });
});

test("a cancelled request dismisses the question", async () => {
  await withDaemon(async ({ home, daemon }) => {
    const controller = new AbortController();
    const pending = askUser({ question: "Still there?" }, { home, signal: controller.signal });
    await waitFor(() => daemon.pending().length === 1, "question pending");
    controller.abort();
    await assert.rejects(pending);
    await waitFor(() => daemon.pending().length === 0, "cancelled question should leave the stack");
  });
});

test("notify returns immediately and does not join the ask queue", async () => {
  await withDaemon(async ({ home, daemon }) => {
    const result = await notifyUser({ message: "Index finished", agent: "glint", project: "demo" }, { home });
    assert.equal(result.delivered, true);
    assert.equal(typeof result.id, "string");
    assert.equal(daemon.pending().length, 0);
  });
});

test("bad ask payloads are rejected and do not queue a panel", async () => {
  await withDaemon(async ({ daemon }) => {
    const response = await fetch(`${daemon.baseUrl}/v1/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "" }),
    });
    assert.equal(response.status, 400);
    assert.equal(daemon.pending().length, 0);
  });
});

test("daemon layout defaults to deneme1 and switches to deneme2 and deneme3 via /v1/layout", async () => {
  await withDaemon(async ({ daemon }) => {
    assert.equal(daemon.layout(), "deneme1");
    for (const next of ["deneme2", "deneme3", "deneme1"] as const) {
      const res = await fetch(`${daemon.baseUrl}/v1/layout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ layout: next }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { layout: string };
      assert.equal(body.layout, next);
      assert.equal(daemon.layout(), next);
    }
  });
});
