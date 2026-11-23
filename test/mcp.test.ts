import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createDaemon, type DaemonHandle } from "../src/daemon.js";
import { createGlintServer, serveMcpHttp, SERVER_INSTRUCTIONS } from "../src/mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withDaemon(fn: (ctx: { home: string; daemon: DaemonHandle }) => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-mcp-"));
  const daemon = await createDaemon({ stateFile: path.join(home, "daemon.json") });
  try {
    await fn({ home, daemon });
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

test("an MCP client receives the answer from ask_user", async () => {
  await withDaemon(async ({ home, daemon }) => {
    const server = createGlintServer({ home, agent: "Claude Code", project: "glint" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "glint-test", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["ask_user", "notify"]);
    const ask = listed.tools.find((tool) => tool.name === "ask_user");
    assert.match(ask?.description ?? "", /overlay/i);


    const call = client.callTool({
      name: "ask_user",
      arguments: {
        question: "Ship the migration?",
        choices: ["Apply it now", "Not yet"],
      },
    });
    const started = Date.now();
    while (daemon.pending().length === 0 && Date.now() - started < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const question = daemon.pending()[0];
    assert.ok(question);
    assert.equal(question?.agent, "Claude Code");
    assert.equal(question?.project, "glint");
    daemon.settle({ id: question?.id ?? "", status: "answered", choiceIndex: 0, via: "choice" });

    const result = await call;
    assert.equal(result.isError, undefined);
    const text = textOf(result.content);
    assert.match(text, /Apply it now/);
    assert.match(text, /"status":"answered"/);
    const structured = result.structuredContent as { answer?: string; choiceIndex?: number; status?: string };
    assert.equal(structured.status, "answered");
    assert.equal(structured.answer, "Apply it now");
    assert.equal(structured.choiceIndex, 0);

    await client.close();
  });
});

test("notify returns without waiting and a down daemon is a tool error", async () => {
  await withDaemon(async ({ home }) => {
    const server = createGlintServer({ home });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "glint-test", version: "0.0.0" });
    await client.connect(clientTransport);

    const notice = await client.callTool({ name: "notify", arguments: { message: "Index finished. 1,284 files." } });
    assert.match(textOf(notice.content), /Delivered/);
    assert.equal((notice.structuredContent as { delivered?: boolean }).delivered, true);

    await client.close();
  });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "glint-down-"));
  try {
    const server = createGlintServer({ home: empty, spawn: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "glint-test", version: "0.0.0" });
    await client.connect(clientTransport);
    const failed = await client.callTool({ name: "ask_user", arguments: { question: "Anyone?" } });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed.content), /not running/i);
    await client.close();
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("stdio MCP server lists tools for a real client", { timeout: 20_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(root, "src/cli.ts"), "mcp"],
    cwd: root,
    env: childEnv(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "glint-stdio", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["ask_user", "notify"]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
  } finally {
    await client.close();
  }
});

test("streamable HTTP MCP server answers notify", { timeout: 20_000 }, async () => {
  await withDaemon(async ({ home }) => {
    const http = await serveMcpHttp(0, { home, spawn: false });
    const transport = new StreamableHTTPClientTransport(new URL(http.url));
    const client = new Client({ name: "glint-http", version: "0.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "ask_user"));
      const notice = await client.callTool({
        name: "notify",
        arguments: { message: "Build finished", agent: "Codex", project: "glint" },
      });
      assert.match(textOf(notice.content), /Delivered/);
    } finally {
      await client.close();
      await http.close();
    }
  });
});

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("\n");
}

test("takopi sessions: no overlay, refused ask becomes plain-text guidance, notify is skipped", async () => {
  await withDaemon(async ({ home, daemon }) => {
    const server = createGlintServer({ home, env: { AGENTOS_TRANSPORT: "takopi" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "glint-test", version: "0.0.0" });
    await client.connect(clientTransport);

    assert.match(client.getInstructions() ?? "", /Takopi\/Telegram/);
    assert.match(client.getInstructions() ?? "", /Do not call ask_user or notify/);

    const ask = await client.callTool({ name: "ask_user", arguments: { question: "Ship it?" } });
    assert.equal(ask.isError, undefined);
    const structured = ask.structuredContent as { status?: string; via?: string };
    assert.equal(structured.status, "dismissed");
    assert.equal(structured.via, "dismiss");
    assert.match(textOf(ask.content), /reply text/);
    assert.match(textOf(ask.content), /Telegram/);
    assert.equal(daemon.pending().length, 0, "the daemon was never asked to ring");

    const notice = await client.callTool({ name: "notify", arguments: { message: "Done." } });
    assert.match(textOf(notice.content), /Skipped/);
    assert.equal((notice.structuredContent as { delivered?: boolean }).delivered, true);
    assert.equal(daemon.pending().length, 0);

    await client.close();
  });
});

test("active rule and MCP instructions require output first and mid-work-only ask_user", async () => {
  const server = createGlintServer({ suppressed: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "instructions-test", version: "0.0.0" });
  try {
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const ask = listed.tools.find((tool) => tool.name === "ask_user");
    const rule = fs.readFileSync(path.join(root, "skills/glint/RULE.md"), "utf8");
    for (const instruction of [rule, SERVER_INSTRUCTIONS, ask?.description ?? ""]) {
      assert.doesNotMatch(instruction, /one-line summary/i);
      assert.match(instruction, /write your full reply.*stop/is);
      assert.match(instruction, /without calling.*ask_user/i);
      assert.match(instruction, /middle of work/i);
      assert.match(instruction, /exact same text/i);
    }
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    const skill = fs.readFileSync(path.join(root, "skills/glint/SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /one-line summary/i);
    assert.match(skill, /without calling `ask_user`/);
  } finally {
    await client.close();
  }
});

test("delivery mode is resolved per MCP call: off and notify asks return reply guidance", async () => {
  const env: NodeJS.ProcessEnv = { GLINT_MODE: "off" };
  const server = createGlintServer({ env, spawn: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mode-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    for (const mode of ["off", "notify"]) {
      env.GLINT_MODE = mode;
      const result = await client.callTool({ name: "ask_user", arguments: { question: "Ship?" } });
      assert.equal((result.structuredContent as { status: string }).status, "dismissed");
      assert.match(textOf(result.content), /reply text/);
    }
    env.GLINT_MODE = "off";
    const result = await client.callTool({ name: "notify", arguments: { message: "Done" } });
    assert.match(textOf(result.content), /Skipped/);
  } finally {
    await client.close();
  }
});

test("notify mode MCP: posts the full message, then off skips the same request", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "glint-mcp-mode-"));
  const { PROTOCOL_VERSION, parseNotifyInput } = await import("../src/protocol.js");
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ version: PROTOCOL_VERSION, port: 12345, token: "test" }));
  const delivered: string[] = [];
  // Replace only HTTP transport; exercise MCP dispatch, the client and wire validation.
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/v1/health")) return new Response("{}", { status: 200 });
    assert.ok(url.endsWith("/v1/notify"), "never opens an ask request");
    delivered.push(parseNotifyInput(JSON.parse(String(init?.body))).message);
    return new Response(JSON.stringify({ id: "notice", delivered: true }), { status: 200 });
  });
  const env: NodeJS.ProcessEnv = { GLINT_MODE: "notify" };
  const server = createGlintServer({ env, home, spawn: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "notify-mode-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const message = "  # Final\r\n" + "line\n".repeat(700) + "  ";
    const notice = await client.callTool({ name: "notify", arguments: { message } });
    assert.equal(notice.isError, undefined);
    assert.deepEqual(delivered, [message]);
    env.GLINT_MODE = "off";
    await client.callTool({ name: "notify", arguments: { message } });
    assert.deepEqual(delivered, [message]);
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
