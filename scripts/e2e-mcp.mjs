// Real MCP client round trip: stdio server, overlay on screen, answer comes back.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.GLINT_HOME ?? path.join(os.homedir(), ".glint");
const display = process.env.DISPLAY || ":1";

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") env[key] = value;
}
env.GLINT_HOME = home;
env.DISPLAY = display;
env.GLINT_NO_SANDBOX = process.env.GLINT_NO_SANDBOX ?? "1";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/cli.js"), "mcp"],
  cwd: root,
  env,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});

const client = new Client({ name: "glint-e2e", version: "0.1.0" });
await client.connect(transport);
console.error("MCP client connected");

const call = client.callTool({
  name: "ask_user",
  arguments: {
    question: "Ship the migration to production?",
    choices: ["Apply it now", "Expand, then contract", "Stop. I'll take it"],
    agent: "Codex",
    project: "payments-api",
  },
});

const question = await waitForQuestion(home);
console.error(`overlay has ${question.id}`);
await sleep(Number(process.env.GLINT_E2E_PAUSE ?? 900));

if (process.env.GLINT_E2E_SHOT) {
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "x11grab",
    "-video_size",
    "1920x1200",
    "-i",
    display,
    "-frames:v",
    "1",
    process.env.GLINT_E2E_SHOT,
  ]);
  console.error(`wrote ${process.env.GLINT_E2E_SHOT}`);
}

if (process.env.GLINT_E2E_NO_ANSWER !== "1") {
  answerTopPanel();
}

const result = await call;
console.log(JSON.stringify(result, null, 2));
await client.close();

if (!textOf(result).includes("Apply it now")) {
  console.error(stderr);
  process.exit(1);
}

function answerTopPanel() {
  const ids = xdotool(["search", "--name", "Glint"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("Glint window was not found");
  const id = ids[ids.length - 1];
  xdotool(["windowactivate", "--sync", id]);
  xdotool(["key", "--window", id, "--delay", "60", "ctrl+shift+g"]);
  xdotool(["key", "--window", id, "--delay", "80", "1"]);
}

function xdotool(args) {
  return execFileSync("xdotool", args, {
    env: { ...process.env, DISPLAY: display },
    encoding: "utf8",
  });
}

async function waitForQuestion(dir) {
  const file = path.join(dir, "daemon.json");
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if (fs.existsSync(file)) {
      const info = JSON.parse(fs.readFileSync(file, "utf8"));
      try {
        const response = await fetch(`http://127.0.0.1:${info.port}/v1/pending`, {
          headers: { authorization: `Bearer ${info.token}` },
        });
        if (response.ok) {
          const body = await response.json();
          if (body.questions?.length) return body.questions[body.questions.length - 1];
        }
      } catch {
        // Daemon is still binding.
      }
    }
    await sleep(80);
  }
  throw new Error(`overlay never showed a question\n${stderr}`);
}

function textOf(result) {
  return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
