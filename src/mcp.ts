import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { askUser, notifyUser, type ClientOptions } from "./client.js";
import { captureOrigin, type Origin } from "./origin.js";
import { projectLabel } from "./project.js";
import { glintDeliveryMode } from "./suppress.js";
import {
  formatAskResult,
  formatNotifyResult,
  GlintError,
  layoutSchema,
  type AskResult,
  type NotifyResult,
} from "./protocol.js";

const VERSION = "0.4.0";

/** Sent to the client at initialize; apps without a rules file (Claude Desktop chat) still get the rule. */
export const SERVER_INSTRUCTIONS =
  "At the end of a turn (finished, blocked, or needs a decision), write your full reply as normal output, then stop without calling ask_user. The Stop hook rings Glint with your complete last message verbatim. Only use ask_user in the middle of work when you must wait for an answer before continuing: first write the question in your output, then pass the exact same text as question. Offer 2-4 short choices when helpful and continue with the answer. Use notify for FYI updates.";

/** Same server, opposite rule: the person is reading a chat, not this desktop. */
export const SUPPRESSED_INSTRUCTIONS =
  "Glint is off for this session (Takopi/Telegram transport, headless run or explicit suppression). Do not call ask_user or notify. The person reads your reply in the chat, so put any question, choice list, or status in the reply text and finish the turn.";

const SUPPRESSED_ASK_TEXT =
  "Glint cannot ask for an answer in this delivery mode. Put the question or decision in your reply text instead. For Takopi/Telegram sessions, Takopi delivers it to Telegram.";
const SUPPRESSED_NOTIFY_TEXT = "Skipped: Glint is off for this session.";

export interface GlintServerOptions extends ClientOptions {
  agent?: string;
  project?: string;
  /** Environment used for delivery resolution; read again for each tool call. */
  env?: NodeJS.ProcessEnv;
  /** Force suppression on or off instead of detecting it. */
  suppressed?: boolean;
}

const askArgs = z.object({
  question: z.string().min(1).describe("Exact same question text already written in your output; shown verbatim in the Glint overlay."),
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
    .describe("Usually omit: the user picks the overlay style with `glint pick`. Forces one layout for this call: deneme1 (top-right), deneme2 (centered HUD), deneme3 (neon ! badge), ticker (bottom strip), bubble (next to the pointer), edge (right edge column), island (top-center pill)."),
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
    .describe("Usually omit: the user picks the overlay style with `glint pick`. Forces one layout for this call: deneme1 (top-right), deneme2 (centered HUD), deneme3 (neon ! badge), ticker (bottom strip), bubble (next to the pointer), edge (right edge column), island (top-center pill)."),
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
  const deliveryMode = () => options.suppressed === undefined
    ? glintDeliveryMode({ env: options.env }).mode
    : options.suppressed ? "off" : "ring";
  const instructions = deliveryMode() === "off" ? SUPPRESSED_INSTRUCTIONS
    : deliveryMode() === "notify"
      ? "Glint is in notify mode. Do not call ask_user; put questions and choices in your reply text. Use notify for non-blocking notices. Write your full final reply and stop."
      : SERVER_INSTRUCTIONS;
  const server = new McpServer(
    { name: "glint", version: VERSION },
    { instructions },
  );
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
        "Call the person through the Glint holocall overlay only in the middle of work, when you must wait for an answer before continuing. First write the question in your output, then pass the exact same text as question. Offer 2-4 short choices when helpful; the person may also type a free answer. Continue with the answer. At the end of a turn (finished, blocked, or needs a decision), write your full reply as normal output, then stop without calling ask_user. The Stop hook shows your complete last message verbatim.",
      inputSchema: askArgs,
      outputSchema: askOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args, ctx) => {
      if (deliveryMode() !== "ring") {
        return toolResult(SUPPRESSED_ASK_TEXT, {
          id: "suppressed",
          status: "dismissed",
          answer: null,
          choiceIndex: null,
          via: "dismiss",
        });
      }
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
      if (deliveryMode() === "off") return toolResult(SUPPRESSED_NOTIFY_TEXT, { id: "suppressed", delivered: true });
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
function sessionFields(): { session: string; harness: string; cwd: string; origin?: Origin } {
  const env = process.env;
  const session =
    env.GLINT_SESSION?.trim() ||
    env.CODEX_THREAD_ID?.trim() ||
    env.CLAUDE_SESSION_ID?.trim() ||
    env.OPENCODE_SESSION_ID?.trim() ||
    `mcp-${process.ppid}`;
  const harness = inferHarness();
  const origin = process.env.GLINT_ORIGIN === "0" ? undefined : captureOrigin({ cwd: process.cwd(), title: env.GLINT_TITLE });
  if (origin) {
    origin.harness = harness;
    origin.session = session.slice(0, 200);
  }
  return { session: session.slice(0, 200), harness, cwd: process.cwd(), ...(origin ? { origin } : {}) };
}

function inferAgent(): string {
  const env = process.env;
  if (env.GLINT_AGENT?.trim()) return env.GLINT_AGENT.trim();
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return "Codex";
  if (env.OPENCODE || env.OPENCODE_SESSION_ID) return "OpenCode";
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return "Cursor";
  if (env.GLINT_HARNESS === "claude-desktop") return "Claude Desktop";
  return "agent";
}

function inferProject(): string {
  return projectLabel(process.cwd(), process.env.GLINT_PROJECT);
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
