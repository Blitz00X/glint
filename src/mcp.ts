import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { z } from "zod";
import { askUser, notifyUser, type ClientOptions } from "./client.js";
import {
  formatAskResult,
  formatNotifyResult,
  GlintError,
  layoutSchema,
  type AskResult,
  type NotifyResult,
} from "./protocol.js";

const VERSION = "0.2.0";

export interface GlintServerOptions extends ClientOptions {
  agent?: string;
  project?: string;
}

const askArgs = z.object({
  question: z.string().min(1).describe("Question shown to the user in the Glint overlay."),
  choices: z
    .array(z.string().min(1))
    .max(9)
    .optional()
    .describe("Optional choices, at most 9. The user can press 1-9 or type their own answer."),
  agent: z.string().min(1).max(80).optional().describe("Who is asking. Example: Claude Code, Codex, Cursor."),
  project: z.string().min(1).max(120).optional().describe("Project or workspace label shown on the panel."),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(3_600_000)
    .optional()
    .describe("Milliseconds to wait before returning status timeout. Omit to wait until the user answers."),
  layout: layoutSchema
    .optional()
    .describe("Overlay preset: deneme1 (top-right corner), deneme2 (80% centered), or deneme3 (top-left neon ! badge)."),
});

const notifyArgs = z.object({
  message: z.string().min(1).describe("Short status shown in the overlay. Does not wait for a reply."),
  agent: z.string().min(1).max(80).optional().describe("Who is notifying. Example: Claude Code."),
  project: z.string().min(1).max(120).optional().describe("Project or workspace label."),
  duration_ms: z
    .number()
    .int()
    .min(500)
    .max(120_000)
    .optional()
    .describe("How long the notice stays visible. Defaults to about 6.5 seconds."),
  layout: layoutSchema
    .optional()
    .describe("Overlay preset: deneme1 (top-right corner), deneme2 (80% centered), or deneme3 (top-left neon ! badge)."),
});

const askOutput = z.object({
  id: z.string(),
  status: z.enum(["answered", "dismissed", "timeout"]),
  answer: z.string().nullable(),
  choiceIndex: z.number().int().nullable(),
  via: z.enum(["choice", "text", "dismiss", "timeout", "disconnect"]).nullable(),
});

const notifyOutput = z.object({
  id: z.string(),
  delivered: z.literal(true),
});

export function createGlintServer(options: GlintServerOptions = {}): McpServer {
  const server = new McpServer({ name: "glint", version: VERSION });
  const clientOptions: ClientOptions = {
    home: options.home,
    spawn: options.spawn,
    noSandbox: options.noSandbox,
  };

  server.registerTool(
    "ask_user",
    {
      title: "Ask the user",
      description:
        "Call the person through the Glint holocall overlay and wait until they answer, dismiss it, or the timeout passes. Use it whenever you would otherwise stop and wait in the terminal: you finished and need to know what's next, you are blocked on a decision, or you need approval. Put a one-line summary of where you are first, then the question. Offer 2-4 numbered choices when you can; the person may also type a free answer. The answer comes back as this tool's result, so keep working with it.",
      inputSchema: askArgs,
      outputSchema: askOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, ctx) => {
      try {
        const result = await askUser(
          {
            question: args.question,
            choices: args.choices,
            agent: clip(args.agent ?? options.agent ?? inferAgent(), 80),
            project: clip(args.project ?? options.project ?? inferProject(), 120),
            timeoutMs: args.timeout_ms,
            layout: args.layout,
            ...sessionFields(),
          },
          { ...clientOptions, signal: ctx.mcpReq.signal },
        );
        return toolResult(formatAskResult(result), result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "notify",
    {
      title: "Notify the user",
      description:
        "Post a non-blocking message to the Glint overlay and its group-chat feed, then return immediately. Use it for progress or 'done' status the person should see without leaving what they are doing. Use ask_user instead when you need a reply.",
      inputSchema: notifyArgs,
      outputSchema: notifyOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, ctx) => {
      try {
        const result = await notifyUser(
          {
            message: args.message,
            agent: clip(args.agent ?? options.agent ?? inferAgent(), 80),
            project: clip(args.project ?? options.project ?? inferProject(), 120),
            durationMs: args.duration_ms,
            layout: args.layout,
            ...sessionFields(),
          },
          { ...clientOptions, signal: ctx.mcpReq.signal },
        );
        return toolResult(formatNotifyResult(result), result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export interface HttpMcpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function serveMcpHttp(port: number, options: GlintServerOptions = {}): Promise<HttpMcpServer> {
  const handler = createMcpHandler(() => createGlintServer(options));
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new GlintError("MCP HTTP server failed to bind");
  const bound = address.port;
  return {
    port: bound,
    url: `http://127.0.0.1:${bound}/mcp`,
    async close() {
      await handler.close();
      await closeServer(server);
    },
  };
}

function toolResult(text: string, structuredContent: AskResult | NotifyResult) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Glint could not reach the overlay: ${message}` }],
    isError: true,
  };
}

function inferHarness(): string {
  const env = process.env;
  if (env.GLINT_HARNESS?.trim()) return env.GLINT_HARNESS.trim();
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return "codex";
  if (env.OPENCODE || env.OPENCODE_SESSION_ID) return "opencode";
  if (env.ANTIGRAVITY_AGENT || env.AGY_SESSION_ID) return "agy";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "cursor";
  return "mcp";
}

/**
 * MCP gives a server no session id, but a stdio server lives exactly as long
 * as its agent session, so the parent pid is a good stand-in.
 */
function sessionFields(): { session: string; harness: string; cwd: string } {
  const env = process.env;
  const session =
    env.GLINT_SESSION?.trim() ||
    env.CODEX_THREAD_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    env.OPENCODE_SESSION_ID?.trim() ||
    `mcp-${process.ppid}`;
  return { session: session.slice(0, 200), harness: inferHarness(), cwd: process.cwd() };
}

function inferAgent(): string {
  const env = process.env;
  if (env.GLINT_AGENT?.trim()) return env.GLINT_AGENT.trim();
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return "Codex";
  if (env.OPENCODE || env.OPENCODE_SESSION_ID) return "OpenCode";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "Cursor";
  return "agent";
}

function inferProject(): string {
  if (process.env.GLINT_PROJECT?.trim()) return process.env.GLINT_PROJECT.trim();
  const base = path.basename(process.cwd());
  return base && base !== "/" ? base : "workspace";
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  return closed;
}
