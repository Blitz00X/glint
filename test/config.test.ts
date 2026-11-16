import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONCEPTS } from "../src/concepts.js";
import { configPath, readConfig, resolveStartLayout, writeConfig } from "../src/config.js";
import { createDaemon } from "../src/daemon.js";
import { runDoctor } from "../src/doctor.js";
import { redactHookPayload } from "../src/hooks.js";
import { packageRoot } from "../src/paths.js";
import { LAYOUT_MODES, parseLayout } from "../src/protocol.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "glint-cfg-"));
}

test("config.json is written 0600 and keeps unknown keys", () => {
  const home = tmp();
  fs.writeFileSync(configPath(home), JSON.stringify({ future: true }));
  writeConfig({ layout: "ticker" }, home);
  assert.equal(fs.statSync(configPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath(home), "utf8")), { future: true, layout: "ticker" });
  assert.deepEqual(readConfig(home), { layout: "ticker" });
});

test("start layout: explicit GLINT_LAYOUT > config.json > deneme1", () => {
  const home = tmp();
  assert.deepEqual(resolveStartLayout({}, home), { layout: "deneme1", source: "default" });
  writeConfig({ layout: "island" }, home);
  assert.deepEqual(resolveStartLayout({}, home), { layout: "island", source: "config" });
  assert.deepEqual(resolveStartLayout({ GLINT_LAYOUT: "badge" }, home), { layout: "deneme3", source: "env" });
  assert.deepEqual(resolveStartLayout({ GLINT_LAYOUT: "" }, home), { layout: "island", source: "config" }, "empty env is not explicit");
  assert.deepEqual(resolveStartLayout({ GLINT_LAYOUT: "nonsense" }, home), { layout: "island", source: "config" });
  fs.writeFileSync(configPath(home), "{ broken");
  assert.deepEqual(resolveStartLayout({}, home), { layout: "deneme1", source: "default" });
});

test("layout names and concept aliases parse", () => {
  assert.equal(parseLayout("bottom-ticker"), "ticker");
  assert.equal(parseLayout("05"), "bubble");
  assert.equal(parseLayout(" Edge-Strip "), "edge");
  assert.equal(parseLayout("island"), "island");
  assert.equal(parseLayout("corner"), "deneme1");
  assert.equal(parseLayout("radial-picker"), undefined, "not built yet");
  assert.equal(parseLayout("mission-control"), undefined, "not built yet");
});

test("every layout has a concept card, every card has a thumbnail, unbuilt ones have no layout", () => {
  assert.equal(CONCEPTS.length, 9);
  for (const layout of LAYOUT_MODES) {
    assert.equal(CONCEPTS.filter((concept) => concept.layout === layout).length, 1, `one card for ${layout}`);
  }
  for (const concept of CONCEPTS) {
    assert.ok(fs.existsSync(path.join(packageRoot(), "overlay", concept.thumb)), `thumb for ${concept.id}`);
  }
  assert.deepEqual(
    CONCEPTS.filter((concept) => concept.layout == null).map((concept) => concept.id),
    ["07-radial-picker", "09-mission-control"],
  );
});

test("daemon: /v1/picker opens the picker when there is a UI, 501 otherwise; per-call concept layouts are accepted", async () => {
  let opened = 0;
  const withUi = await createDaemon({ sink: { question: () => {}, notice: () => {}, resolved: () => {}, openPicker: () => void opened++ } });
  const headless = await createDaemon({ sink: { question: () => {}, notice: () => {}, resolved: () => {} } });
  try {
    const post = (d: typeof withUi, p: string, body: unknown = {}) =>
      fetch(`${d.baseUrl}${p}`, { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(withUi, "/v1/picker")).status, 200);
    assert.equal(opened, 1);
    assert.equal((await post(headless, "/v1/picker")).status, 501);
    const res = await post(withUi, "/v1/layout", { layout: "edge" });
    assert.deepEqual(await res.json(), { layout: "edge" });
    assert.equal((await post(withUi, "/v1/layout", { layout: "radial" })).status, 400);
    const asked = post(withUi, "/v1/ask", { question: "q", layout: "bubble", timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(withUi.pending()[0]?.layout, "bubble");
    assert.equal(((await (await asked).json()) as { status: string }).status, "timeout");
  } finally {
    await withUi.close();
    await headless.close();
  }
});

test("GLINT_HOOK_LOG redaction keeps the shape, drops prompts, paths and messages", () => {
  const out = redactHookPayload({
    hook_event_name: "Stop",
    stop_hook_active: false,
    executionNum: 2,
    cwd: "/home/someone/secret-project",
    transcript_path: "/home/someone/.claude/x.jsonl",
    lastUserInput: "my password is hunter2",
    last_assistant_message: "Here is the diff",
    tool_input: { command: "rm -rf /tmp/x" },
  }) as Record<string, unknown>;
  assert.equal(out.hook_event_name, "Stop");
  assert.equal(out.stop_hook_active, false);
  assert.equal(out.executionNum, 2);
  const text = JSON.stringify(out);
  for (const secret of ["someone", "hunter2", "Here is the diff", "rm -rf"]) assert.ok(!text.includes(secret), secret);
  assert.equal(out.lastUserInput, "<redacted:22 chars>");
});

test("doctor reports layout source, harness install state and daemon status", async () => {
  const home = tmp();
  const gHome = tmp();
  writeConfig({ layout: "ticker" }, gHome);
  const checks = await runDoctor({
    home,
    glintHome: gHome,
    env: { GLINT_LAYOUT: "deneme2", DISPLAY: ":0" },
    daemon: async () => null,
    run: () => "true",
    electron: () => "/x/electron",
  });
  const by = (label: string) => checks.find((check) => check.label === label);
  assert.match(by("layout")!.detail, /starts with deneme2 \(from GLINT_LAYOUT\); config\.json says ticker/);
  assert.equal(by("daemon")!.level, "warn");
  assert.equal(by("config.json")!.level, "ok");
  assert.equal(by("claude")!.level, "info");
  assert.match(by("claude")!.detail, /glint install claude --write/);
  assert.equal(by("audio")!.level, "ok");
  assert.equal(by("wsl"), undefined);
});

test("doctor explains the WSLg hotkey and audio limits", async () => {
  const home = tmp();
  const gHome = tmp();
  const checks = await runDoctor({
    home,
    glintHome: gHome,
    env: { DISPLAY: ":0", WSL_DISTRO_NAME: "Ubuntu" },
    daemon: async () => null,
    run: (_cmd, args) => (args[0] === "info" ? null : "true"),
    electron: () => "/x/electron",
  });
  const by = (label: string) => checks.find((check) => check.label === label);
  assert.equal(by("wsl")!.level, "info");
  assert.match(by("wsl")!.detail, /glint focus/);
  assert.equal(by("audio")!.level, "info");
  assert.match(by("audio")!.detail, /PULSE_SERVER/);
});
