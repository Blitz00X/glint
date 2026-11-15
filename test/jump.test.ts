import { test } from "node:test";
import assert from "node:assert/strict";
import { jumpTo } from "../src/jump.js";

test("an app-managed session opens a terminal at its folder", async () => {
  const calls: string[] = [];
  const result = await jumpTo(
    { cwd: "/tmp/glint-project", project: "Asistan", kind: "unknown" },
    {
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { ok: cmd === "gnome-terminal", stdout: "" };
      },
      copy: () => {
        throw new Error("the copy fallback must not run when a terminal opens");
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.method, "terminal");
  assert.match(result.message, /opened a terminal/);
  assert.ok(calls.some((call) => call.startsWith("gnome-terminal --working-directory=/tmp/glint-project")));
});

test("a desktop app with no focusable window still copies the cd command", async () => {
  let copied = "";
  const result = await jumpTo(
    { cwd: "/tmp/glint-project", project: "Asistan", kind: "desktop", app: "Codex Desktop" },
    {
      run: async () => ({ ok: false, stdout: "" }),
      copy: (text) => {
        copied = text;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.method, "copy");
  assert.match(copied, /^cd '/);
});
