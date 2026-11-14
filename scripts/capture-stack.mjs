// Raises a stack of panels through a real MCP client and leaves them up
// until GLINT_CAPTURE_ANSWER=1, so a screenshot can be taken mid-flight.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.GLINT_HOME ?? path.join(os.homedir(), ".glint");
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") env[key] = value;
}
env.GLINT_HOME = home;
env.DISPLAY = process.env.DISPLAY || ":1";
env.GLINT_NO_SANDBOX = process.env.GLINT_NO_SANDBOX ?? "1";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/cli.js"), "mcp"],
  cwd: root,
  env,
  stderr: "inherit",
});
const client = new Client({ name: "glint-capture", version: "0.1.0" });
await client.connect(transport);

const calls = [];
calls.push(
  client.callTool({
    name: "notify",
    arguments: {
      message: "Index finished. 1,284 files, no errors.",
      agent: "glint",
      project: "payments-api",
      duration_ms: 20000,
    },
  }),
);
await sleep(350);
const claude = client.callTool({
  name: "ask_user",
  arguments: {
    question: "Keep the overlay click-through until Ctrl+Shift+G?",
    choices: ["Yes, stay out of the way", "Focus me whenever you ask"],
    agent: "Claude Code",
    project: "glint",
  },
});
await sleep(400);
const codex = client.callTool({
  name: "ask_user",
  arguments: {
    question: "The migration adds a NOT NULL column. Apply it in one step?",
    choices: ["Apply it now", "Expand, then contract", "Stop. I'll take it"],
    agent: "Codex",
    project: "payments-api",
  },
});

fs.writeFileSync(process.env.GLINT_CAPTURE_READY ?? "/tmp/glint-stack-ready", "ready\n");
const results = await Promise.all([claude, codex, ...calls]);
for (const result of results) {
  console.log("---");
  console.log((result.content ?? []).map((block) => block.text ?? "").join("\n"));
}
await client.close();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
