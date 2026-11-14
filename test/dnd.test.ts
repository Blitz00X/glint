import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDaemon } from "../src/daemon.js";
import { createDnd, savedFile } from "../src/dnd.js";

function fakeGsettings(initial = "true", writable = "true") {
  const state = { value: initial, calls: [] as string[][] };
  const run = (args: string[]) => {
    state.calls.push(args);
    if (args[0] === "writable") {
      if (writable === "missing") throw new Error("No such schema");
      return writable;
    }
    if (args[0] === "get") return state.value;
    if (args[0] === "set") {
      state.value = args[3]!;
      return "";
    }
    throw new Error("unexpected");
  };
  return { state, run };
}

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "glint-dnd-"));

test("dnd: banners off while calls are open, previous value restored after the last one", () => {
  const h = home();
  const g = fakeGsettings("true");
  const dnd = createDnd({ home: h, env: {}, run: g.run });
  assert.equal(dnd.supported, true);
  dnd.sync(1);
  assert.equal(g.state.value, "false");
  assert.ok(fs.existsSync(savedFile(h)), "previous value persisted for crash recovery");
  dnd.sync(2);
  dnd.sync(1);
  assert.equal(g.state.value, "false");
  dnd.sync(0);
  assert.equal(g.state.value, "true");
  assert.ok(!fs.existsSync(savedFile(h)));
});

test("dnd: leaves a user's own Do Not Disturb alone", () => {
  const g = fakeGsettings("false");
  const dnd = createDnd({ home: home(), env: {}, run: g.run });
  dnd.sync(1);
  dnd.sync(0);
  assert.equal(g.state.value, "false");
  assert.ok(!g.state.calls.some((c) => c[0] === "set"));
});

test("dnd: a value saved before a crash is restored on next start", () => {
  const h = home();
  fs.writeFileSync(savedFile(h), JSON.stringify({ value: "true" }));
  const g = fakeGsettings("false");
  createDnd({ home: h, env: {}, run: g.run });
  assert.equal(g.state.value, "true");
  assert.ok(!fs.existsSync(savedFile(h)));
});

test("dnd: GLINT_DND=0 or a missing gsettings key does nothing", () => {
  const off = fakeGsettings("true");
  const a = createDnd({ home: home(), env: { GLINT_DND: "0" }, run: off.run });
  a.sync(1);
  assert.equal(a.supported, false);
  assert.equal(off.state.value, "true");
  assert.equal(off.state.calls.length, 0);
  const missing = fakeGsettings("true", "missing");
  const b = createDnd({ home: home(), env: {}, run: missing.run });
  b.sync(1);
  assert.equal(b.supported, false);
  assert.equal(missing.state.value, "true");
});

test("daemon reports open-call count changes", async () => {
  const counts: number[] = [];
  const daemon = await createDaemon({ port: 0, onPendingChange: (n) => counts.push(n) });
  const ask = fetch(`${daemon.baseUrl}/v1/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify({ question: "ok?", choices: ["yes", "no"] }),
  });
  while (daemon.pending().length === 0) await new Promise((r) => setTimeout(r, 10));
  const id = daemon.pending()[0]!.id;
  daemon.settle({ id, status: "answered", choiceIndex: 0, via: "choice" });
  await (await ask).json();
  await daemon.close();
  assert.deepEqual(counts, [1, 0]);
});
