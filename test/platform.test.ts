import assert from "node:assert/strict";
import test from "node:test";
import { demoGuide, isWsl } from "../src/platform.js";

test("WSL is detected from the environment and the kernel release", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, ""), true);
  assert.equal(isWsl({ WSL_INTEROP: "/run/WSL/1_interop" }, ""), true);
  assert.equal(isWsl({}, "6.6.87.2-microsoft-standard-WSL2"), true);
  assert.equal(isWsl({}, "6.8.0-45-generic"), false);
});

test("the demo guide explains the controls and the WSLg limits", () => {
  const plain = demoGuide(false).join("\n");
  assert.match(plain, /1–9 choose/);
  assert.match(plain, /Esc dismiss/);
  assert.doesNotMatch(plain, /WSL:/);

  const wsl = demoGuide(true).join("\n");
  assert.match(wsl, /WSL: Ctrl\+Shift\+G\/F\/L/);
  assert.match(wsl, /glint focus/);
});
