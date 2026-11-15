import { test } from "node:test";
import assert from "node:assert/strict";
import { createDaemon } from "../src/daemon.js";

test("focus endpoint asks the overlay sink to focus the newest panel", async () => {
  let focused = 0;
  const daemon = await createDaemon({
    stateFile: null,
    sink: {
      question() {},
      notice() {},
      resolved() {},
      focus() {
        focused += 1;
      },
    },
  });
  try {
    const res = await fetch(`${daemon.baseUrl}/v1/focus`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(focused, 1);
  } finally {
    await daemon.close();
  }
});
