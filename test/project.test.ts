import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectLabel } from "../src/project.js";

const BOT_ID = "57d69715-d150-436a-84be-35712bf45238";
const THREAD_ID = "472a48cc-4808-4e6a-9fba-f73cde4c4e31";

test("an OpenMausBot task workspace uses the bot name, not the UUID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-project-"));
  fs.writeFileSync(path.join(root, "bots.json"), JSON.stringify([{ id: BOT_ID, name: "Asistan" }]));
  const cwd = path.join(root, "task-workspaces", BOT_ID, THREAD_ID);
  assert.equal(projectLabel(cwd, undefined, { OMB_DATA_DIR: root }), "Asistan");
});

test("a UUID workspace still gets a readable fallback", () => {
  const cwd = path.join("/home", "kutay", ".openmausbot", "task-workspaces", BOT_ID, THREAD_ID);
  assert.equal(projectLabel(cwd, undefined, {}), "OpenMausBot");
});

test("a normal repository keeps its directory name", () => {
  assert.equal(projectLabel("/home/kutay/glint-publish", undefined, {}), "glint-publish");
});

test("an explicit human label wins; an explicit UUID does not", () => {
  assert.equal(projectLabel("/home/kutay/glint-publish", "Launchbench", {}), "Launchbench");
  assert.equal(projectLabel("/home/kutay/glint-publish", THREAD_ID, {}), "glint-publish");
});

test("a bare UUID with no usable path becomes a neutral label", () => {
  assert.equal(projectLabel(undefined, THREAD_ID, {}), "workspace");
});
