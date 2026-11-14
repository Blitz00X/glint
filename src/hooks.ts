import fs from "node:fs";
import path from "node:path";
import { harnessName } from "./identity.js";
import { ensureHome, glintHome } from "./paths.js";
import type { AskInput, AskResult, NotifyInput } from "./protocol.js";

/**
 * Layer 2 of Glint: deterministic lifecycle hooks.
 *
 * The harness runs `glint hook <harness> <event>` when the agent stops (or
 * wants a tool approved). We open a Glint call, wait for the person, and print
 * whatever JSON that harness understands so the agent keeps going with the
 * answer, without anyone touching the terminal. Dismiss, timeout, or any
 * failure lets the agent stop normally: a hook must never wedge a session.
 */

export const HARNESSES = ["claude", "codex", "agy", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

export type HookEvent = "stop" | "pretooluse" | "notify";

/**
 * Stop calls never get made-up buttons. When the agent's last message ends
 * with a clear list of options (numbered, lettered or bulleted, next to a
 * question), those become the choices; otherwise the panel shows only the
 * free-text box.
 */
export function choicesFromMessage(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const item = /^\s*(?:\d{1,2}[.)]|\(?[a-zA-Z]\)|[-*•])\s+(.+?)\s*$/;
  // Find the last block of consecutive list items (blank lines inside allowed).
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (item.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (item.test(line)) start = i;
    else if (line.trim() === "") continue;
    else break;
  }
  const block = lines.slice(start, end + 1).filter((line) => item.test(line));
  if (block.length < 2 || block.length > 9) return [];
  const after = lines.slice(end + 1).map((l) => l.trim()).filter(Boolean);
  if (after.length > 2) return [];
  const before = lines.slice(0, start).map((l) => l.trim()).filter(Boolean).slice(-2);
  const optionWords = /\b(option|options|choose|choice|pick|prefer|which|should i|want me|seçenek|seç|hangisi|hangi|ister misin|tercih)\b/i;
  const asks =
    [...before, ...after].some((l) => /[?？]\s*$/.test(l) || /[?？]/.test(l)) ||
    before.some((l) => /:\s*$/.test(l) && optionWords.test(l)) ||
    block.some((l) => /[?？]\s*$/.test(l));
  if (!asks) return [];
  return block
    .map((line) => item.exec(line)![1]!.replace(/\*\*|__|`/g, "").trim())
    .map((choice) => (choice.length > 140 ? `${choice.slice(0, 139)}…` : choice))
    .filter(Boolean);
}

/**
 * Short free-text replies that mean "stop", so typing "that's all" or
 * "bu kadar" ends the turn like picking the second choice does.
 */
const STOP_PHRASES = new Set([
  "thats all",
  "thats all stop here",
  "thats it",
  "stop",
  "stop here",
  "done",
  "all done",
  "nothing else",
  "nothing",
  "no thanks",
  "end",
  "bitti",
  "bu kadar",
  "tamam bu kadar",
  "simdilik bu kadar",
  "yeter",
  "dur",
  "gerek yok",
  "baska bir sey yok",
]);

export function isStopPhrase(answer: string): boolean {
  const norm = answer
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return STOP_PHRASES.has(norm);
}
export const APPROVAL_CHOICES = ["Allow", "Deny", "Decide in the terminal"] as const;

export const DEFAULT_HOOK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 2 * 60_000;
export const DEFAULT_MAX_CHAIN = 8;
/** A chain counter older than this is treated as a fresh conversation. */
export const CHAIN_RESET_MS = 30 * 60_000;

export interface HookDeps {
  ask(input: AskInput, signal: AbortSignal): Promise<AskResult>;
  notify(input: NotifyInput): Promise<unknown>;
  /** Directory for the loop-guard counter. Defaults to GLINT_HOME. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface HookOutcome {
  /** What we decided. noop = say nothing and let the harness do its default. */
  action: "continue" | "stop" | "allow" | "deny" | "ask" | "noop";
  /** Exactly what to print on stdout (may be empty). */
  stdout: string;
  /** Text handed back to the agent when it continues or is denied. */
  message?: string;
  /** Why we did not open a call or did not continue, for logs and tests. */
  reason?: string;
}

export interface NormalizedHookInput {
  session: string;
  cwd: string;
  lastMessage: string;
  stopHookActive: boolean;
  toolName: string;
  toolInput: unknown;
  /** Chain count supplied by a caller that tracks it itself (OpenCode plugin). */
  chain: number | null;
  /** The agent's last tool call this turn was Glint's ask_user: the user was just consulted. */
  consultedGlint: boolean;
  raw: Record<string, unknown>;
}

export function parseHarness(value: string | undefined): Harness | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "claude" || v === "claude-code" || v === "claudecode") return "claude";
  if (v === "codex") return "codex";
  if (v === "agy" || v === "antigravity") return "agy";
  if (v === "opencode") return "opencode";
  return null;
}

export function parseHookEvent(value: string | undefined): HookEvent | null {
  const v = (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (v === "stop" || v === "idle" || v === "sessionidle" || v === "session.idle" || v === "agentturncomplete") return "stop";
  if (v === "pretooluse" || v === "permission" || v === "permissionask" || v === "permission.ask" || v === "approval")
    return "pretooluse";
  if (v === "notify" || v === "notification") return "notify";
  return null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0];
  }
  return "";
}

export function parseHookPayload(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function normalizeHookInput(payload: Record<string, unknown>, fallbackCwd = process.cwd()): NormalizedHookInput {
  const session = pickString(payload, [
    "session_id",
    "sessionId",
    "sessionID",
    "thread-id",
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
    "trajectory_id",
    "trajectoryId",
  ]);
  const cwd =
    pickString(payload, ["cwd", "workspace", "workspace_root", "workspaceRoot", "workspace_roots", "workspaceRoots", "directory"]) ||
    fallbackCwd;
  let lastMessage = pickString(payload, [
    "last_assistant_message",
    "last-assistant-message",
    "lastAssistantMessage",
    "last_message",
    "lastMessage",
    "response",
    "message",
  ]);
  const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
  if (!lastMessage && transcript) lastMessage = lastAssistantFromTranscript(transcript);
  // agy numbers its Stop runs within a turn (executionNum: 0, 1, 2…); its
  // continuationActive flag stays false in agy 1.5.x, so it can't be used.
  const chainRaw = payload.chain ?? payload.executionNum;
  const consultedGlint =
    payload.glint_consulted === true || (transcript ? lastToolWasGlintAsk(transcript) : false);
  return {
    consultedGlint,
    session,
    cwd,
    lastMessage: lastMessage.trim(),
    stopHookActive: payload.stop_hook_active === true || payload.stopHookActive === true || payload.continuationActive === true,
    toolName: pickString(payload, ["tool_name", "toolName", "tool", "permission", "type"]),
    toolInput: payload.tool_input ?? payload.toolInput ?? payload.args ?? payload.metadata ?? payload.pattern ?? null,
    chain: typeof chainRaw === "number" && Number.isFinite(chainRaw) ? chainRaw : null,
    raw: payload,
  };
}

export function isGlintAskTool(name: unknown): boolean {
  return typeof name === "string" && /glint/i.test(name) && /ask_user/i.test(name);
}

/**
 * True when the last tool the agent used in its final turn was Glint's
 * ask_user, i.e. it already talked to the user right before stopping. Ringing
 * again would be a double call.
 */
export function lastToolWasGlintAsk(file: string, maxBytes = 2_000_000): boolean {
  const lines = readTail(file, maxBytes).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const codex = codexRolloutVerdict(entry);
    if (codex !== null) return codex;
    const agy = agyStepVerdict(entry);
    if (agy !== null) return agy;
    const message = (entry.message ?? entry) as Record<string, unknown>;
    const role = (message.role ?? entry.type) as string | undefined;
    const content = message.content;
    if (role === "user") {
      const isToolResult = Array.isArray(content) && content.some((part) => (part as { type?: string })?.type === "tool_result");
      if (!isToolResult) return false; // reached the human's prompt: no tool in this turn
      continue;
    }
    if (role !== "assistant" || !Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j] as { type?: string; name?: string };
      if (part?.type === "tool_use") return isGlintAskTool(part.name);
    }
  }
  return false;
}

/**
 * Codex rollout lines: `event_msg` items (McpToolCall, UserMessage) and
 * `response_item` tool calls. Returns true/false when the line decides the
 * question, null when it should be skipped.
 */
function codexRolloutVerdict(entry: Record<string, unknown>): boolean | null {
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;
  if (entry.type === "event_msg") {
    if (payload.type === "user_message") return false;
    const item = payload.item as Record<string, unknown> | undefined;
    if (payload.type !== "item_completed" || !item) return null;
    if (item.type === "UserMessage") return false;
    if (item.type === "McpToolCall") return /glint/i.test(String(item.server ?? "")) && item.tool === "ask_user";
    return null;
  }
  if (entry.type === "response_item") {
    const t = payload.type;
    if (t === "message" && payload.role === "user") return false;
    if (t === "function_call" || t === "custom_tool_call" || t === "mcp_tool_call") {
      const text = `${String(payload.name ?? "")} ${typeof payload.input === "string" ? payload.input : ""} ${typeof payload.arguments === "string" ? payload.arguments : ""}`;
      return /mcp__glint__ask_user|glint[._]ask_user/i.test(text);
    }
    return null;
  }
  return null;
}

/** agy transcript steps: USER_INPUT ends the search; a PLANNER_RESPONSE with tool_calls decides it. */
function agyStepVerdict(entry: Record<string, unknown>): boolean | null {
  if (typeof entry.step_index !== "number" || typeof entry.type !== "string") return null;
  if (entry.type === "USER_INPUT") return false;
  if (entry.type !== "PLANNER_RESPONSE" || !Array.isArray(entry.tool_calls) || entry.tool_calls.length === 0) return null;
  const last = entry.tool_calls[entry.tool_calls.length - 1] as { name?: unknown; args?: Record<string, unknown> };
  const name = String(last?.name ?? "");
  if (isGlintAskTool(name)) return true;
  if (name !== "call_mcp_tool") return false;
  const strip = (v: unknown) => String(v ?? "").replace(/^"+|"+$/g, "");
  return /glint/i.test(strip(last.args?.ServerName)) && strip(last.args?.ToolName) === "ask_user";
}

function readTail(file: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

/** Claude Code / Codex transcripts are JSONL; take the last assistant text. */
export function lastAssistantFromTranscript(file: string, maxBytes = 2_000_000): string {
  let data: string;
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    data = buf.toString("utf8");
  } catch {
    return "";
  }
  const lines = data.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // agy (Antigravity CLI) transcript steps: {source: "MODEL", type: "PLANNER_RESPONSE", content}
    if (entry.source === "MODEL" && entry.type === "PLANNER_RESPONSE") {
      if (typeof entry.content === "string" && entry.content.trim()) return entry.content;
      continue;
    }
    const message = (entry.message ?? entry.payload ?? entry) as Record<string, unknown>;
    const role = (entry.type ?? message.role) as string | undefined;
    if (role !== "assistant" && message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
  }
  return "";
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/* ---------- loop guard ---------- */

interface ChainState {
  [key: string]: { count: number; at: number };
}

function chainFile(dir: string): string {
  return path.join(dir, "hook-chain.json");
}

function readChain(dir: string): ChainState {
  try {
    return JSON.parse(fs.readFileSync(chainFile(dir), "utf8")) as ChainState;
  } catch {
    return {};
  }
}

function writeChain(dir: string, state: ChainState, now: number): void {
  try {
    ensureHome(dir);
    for (const [key, value] of Object.entries(state)) {
      if (now - value.at > CHAIN_RESET_MS * 4) delete state[key];
    }
    const tmp = `${chainFile(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, chainFile(dir));
  } catch {
    // The guard is best effort; the human in the loop is the real limit.
  }
}

/**
 * How many times in a row this session has been sent back to work by Glint.
 * Claude Code and Codex tell us when a stop comes right after a hook
 * continuation (stop_hook_active); a stop without it starts a new chain.
 */
export function currentChain(
  dir: string,
  key: string,
  input: NormalizedHookInput,
  harness: Harness,
  now: number,
): number {
  if (input.chain != null) return input.chain;
  const state = readChain(dir);
  const entry = state[key];
  if (!entry) return 0;
  if ((harness === "claude" || harness === "codex") && !input.stopHookActive) return 0;
  if (now - entry.at > CHAIN_RESET_MS) return 0;
  return entry.count;
}

function bumpChain(dir: string, key: string, count: number, now: number): void {
  const state = readChain(dir);
  state[key] = { count, at: now };
  writeChain(dir, state, now);
}

function clearChain(dir: string, key: string, now: number): void {
  const state = readChain(dir);
  if (state[key]) {
    delete state[key];
    writeChain(dir, state, now);
  }
}

/* ---------- output per harness ---------- */

export function stopOutput(harness: Harness, decision: "continue" | "stop", message = ""): string {
  if (harness === "opencode") {
    return JSON.stringify(decision === "continue" ? { action: "continue", prompt: message } : { action: "stop" });
  }
  if (decision === "stop") return harness === "agy" ? "{}" : "";
  if (harness === "agy") return JSON.stringify({ decision: "continue", reason: message });
  // Claude Code and Codex: "block" the stop and hand the reason to the model.
  return JSON.stringify({ decision: "block", reason: message });
}

export function approvalOutput(harness: Harness, decision: "allow" | "deny" | "ask", reason: string): string {
  if (harness === "opencode") return JSON.stringify({ action: decision, reason });
  if (harness === "agy") return JSON.stringify({ decision, reason });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

export function continuationMessage(answer: string, choiceIndex: number | null): string {
  if (choiceIndex != null) {
    return `The user picked option ${choiceIndex + 1} through Glint: "${answer}". Continue accordingly.`;
  }
  return `The user replied through Glint: "${answer}". Treat this as their next message and continue accordingly.`;
}

function summarizeTool(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const command = obj.command ?? obj.cmd ?? obj.CommandLine;
    if (typeof command === "string") return `${name}: ${command}`;
    const file = obj.file_path ?? obj.filePath ?? obj.path;
    if (typeof file === "string") return `${name}: ${file}`;
  }
  if (typeof input === "string" && input.trim()) return `${name}: ${input}`;
  if (Array.isArray(input) && input.every((x) => typeof x === "string")) return `${name}: ${input.join(" ")}`;
  const json = input == null ? "" : JSON.stringify(input);
  return json && json !== "{}" ? `${name}: ${json}` : name;
}

/* ---------- main entry ---------- */

export async function runHook(
  harness: Harness,
  event: HookEvent,
  rawInput: string,
  deps: HookDeps,
): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const payload = parseHookPayload(rawInput);
  if (env.GLINT_HOOK_LOG === "1") {
    try {
      const dir = deps.stateDir ?? glintHome();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hook-payloads.jsonl"), `${JSON.stringify({ at: now(), harness, event, payload })}\n`);
    } catch {
      // debugging aid only
    }
  }
  const input = normalizeHookInput(payload);
  const agent = harnessName(harness);
  const project = path.basename(input.cwd) || "workspace";
  const identity = {
    agent,
    project,
    harness,
    cwd: input.cwd,
    ...(input.session ? { session: input.session.slice(0, 200) } : {}),
  };

  if (env.GLINT_HOOK === "0" || env.GLINT_HOOKS === "0") {
    return noop(harness, event, "hooks disabled by GLINT_HOOK=0");
  }

  if (event === "notify") {
    const text = input.lastMessage || "Turn complete.";
    try {
      await deps.notify({ message: clip(text, 1_900), ...identity });
    } catch {
      // Never fail the harness over a notice.
    }
    return { action: "noop", stdout: "", reason: "notify is fire-and-forget" };
  }

  if (event === "pretooluse") {
    return runApproval(harness, input, identity, deps, env);
  }

  // Stop / idle.
  // agy also runs Stop on errors, cancels and budget limits; only a normal
  // end of turn (NO_TOOL_CALL) should open a call.
  const terminationReason = typeof input.raw.terminationReason === "string" ? input.raw.terminationReason : "";
  if (harness === "agy" && terminationReason && terminationReason !== "NO_TOOL_CALL") {
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: `agy stopped with ${terminationReason}` };
  }
  if (input.consultedGlint && env.GLINT_HOOK_ALWAYS !== "1") {
    return {
      action: "stop",
      stdout: stopOutput(harness, "stop"),
      reason: "the agent already called glint ask_user right before stopping",
    };
  }
  const stateDir = deps.stateDir ?? glintHome();
  const key = `${harness}:${input.session || input.cwd}`;
  const maxChain = envNumber(env, "GLINT_HOOK_MAX_CHAIN", DEFAULT_MAX_CHAIN);
  const chain = currentChain(stateDir, key, input, harness, now());
  if (chain >= maxChain) {
    clearChain(stateDir, key, now());
    try {
      await deps.notify({
        message: `Stopped after ${chain} hook continuations in a row (GLINT_HOOK_MAX_CHAIN=${maxChain}). Answer in the terminal to go on.`,
        ...identity,
      });
    } catch {
      // ignore
    }
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: "loop guard: chain limit reached" };
  }

  const timeoutMs = envNumber(env, "GLINT_HOOK_TIMEOUT_MS", DEFAULT_HOOK_TIMEOUT_MS);
  const question = input.lastMessage
    ? clip(input.lastMessage, 1_800)
    : `${agent} stopped and is waiting for you. Anything else?`;
  const result = await askWithDeadline(
    deps,
    {
      question,
      choices: choicesFromMessage(input.lastMessage),
      timeoutMs,
      kind: "stop",
      ...identity,
    },
    timeoutMs + 2_000,
  );

  if (!result || result.status !== "answered" || !result.answer) {
    clearChain(stateDir, key, now());
    const why = !result ? "glint unreachable or hook deadline" : result.status;
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: why };
  }
  if (isStopPhrase(result.answer)) {
    clearChain(stateDir, key, now());
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: "user chose to stop" };
  }
  const message = continuationMessage(result.answer, result.choiceIndex);
  bumpChain(stateDir, key, chain + 1, now());
  return { action: "continue", stdout: stopOutput(harness, "continue", message), message };
}

async function runApproval(
  harness: Harness,
  input: NormalizedHookInput,
  identity: Omit<AskInput, "question">,
  deps: HookDeps,
  env: NodeJS.ProcessEnv,
): Promise<HookOutcome> {
  const timeoutMs = envNumber(env, "GLINT_APPROVAL_TIMEOUT_MS", DEFAULT_APPROVAL_TIMEOUT_MS);
  const what = clip(summarizeTool(input.toolName || "tool", input.toolInput), 900);
  const result = await askWithDeadline(
    deps,
    {
      ...identity,
      question: `Approve this tool call?\n${what}`,
      choices: [...APPROVAL_CHOICES],
      timeoutMs,
      kind: "approval",
    },
    timeoutMs + 2_000,
  );
  if (!result || result.status !== "answered" || !result.answer) {
    return { action: "noop", stdout: "", reason: result ? result.status : "glint unreachable or hook deadline" };
  }
  if (result.choiceIndex === 0 && result.answer === APPROVAL_CHOICES[0]) {
    const reason = "Approved by the user in Glint.";
    return { action: "allow", stdout: approvalOutput(harness, "allow", reason), message: reason };
  }
  if (result.choiceIndex === 1 && result.answer === APPROVAL_CHOICES[1]) {
    const reason = "Denied by the user in Glint.";
    return { action: "deny", stdout: approvalOutput(harness, "deny", reason), message: reason };
  }
  if (result.choiceIndex === 2 && result.answer === APPROVAL_CHOICES[2]) {
    return { action: "ask", stdout: approvalOutput(harness, "ask", "Deferred to the terminal from Glint."), reason: "deferred" };
  }
  const reason = `Denied in Glint with feedback: "${result.answer}"`;
  return { action: "deny", stdout: approvalOutput(harness, "deny", reason), message: reason };
}

function noop(harness: Harness, event: HookEvent, reason: string): HookOutcome {
  if (event === "stop") return { action: "noop", stdout: stopOutput(harness, "stop"), reason };
  return { action: "noop", stdout: "", reason };
}

/**
 * Ask, but never wait past `deadlineMs`: abort the request (which the daemon
 * treats as a dropped call and closes the panel) and return null.
 */
async function askWithDeadline(deps: HookDeps, input: AskInput, deadlineMs: number): Promise<AskResult | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, deadlineMs);
  });
  try {
    return await Promise.race([deps.ask(input, controller.signal).catch(() => null), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read all of stdin, but give up quickly when nothing is piped in. */
export function readStdin(idleMs = 1_500): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let timer = setTimeout(done, idleMs);
    function done() {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      clearTimeout(timer);
      timer = setTimeout(done, idleMs);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}
