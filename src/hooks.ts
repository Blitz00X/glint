import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { harnessName } from "./identity.js";
import { captureOrigin, defaultOriginDeps } from "./origin.js";
import { ensureHome, glintHome } from "./paths.js";
import type { AskInput, AskResult, NotifyInput } from "./protocol.js";
import { projectLabel } from "./project.js";
import { glintDeliveryMode, sessionSuppressed } from "./suppress.js";

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

/** Session titles Takopi gives its runs: "Takopi", "Takopi · …". */
export function isTakopiSessionTitle(title: string | undefined): boolean {
  return /^\s*takopi\b/i.test(title ?? "");
}

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

/* ---------- plain-text questions (the agent forgot to call ask_user) ---------- */

/** Drop fenced code blocks so `a ? b : c` or a "which" in code never looks like a question. */
function withoutCode(text: string): string {
  return text.replace(/\r/g, "").replace(/```[\s\S]*?(```|$)/g, "\n").replace(/`[^`\n]*`/g, "x");
}

function lowerTr(text: string): string {
  return text.toLocaleLowerCase("tr");
}

const QUESTION_PHRASES: RegExp[] = [
  /\b(should|shall|can|may) i\b/,
  /\b(do|would) you (want|like|prefer)\b/,
  /\bwant me to\b/,
  /\bwhich (one|option|approach|way|path|of (these|the|them)|do you|would you|should)\b/,
  /\bhow (would|should|do) you (like|want)\b/,
  /\bhow should i\b/,
  /\bwhat would you like\b/,
  /\blet me know\b/,
  /\b(please|can you|could you) (confirm|choose|pick|decide|clarify|provide|share|approve)\b/,
  /\b(need|awaiting|waiting for|waiting on) your (input|decision|answer|approval|confirmation|go-ahead|call)\b/,
  /\bbefore i (proceed|continue|go ahead)\b/,
  /\bshould we\b/,
  /ister misin|ister misiniz|istiyor musun|istersin|istersen söyle/,
  /\bhangisi|\bhangisini|\bhangi (seçenek|yol|yaklaşım|yöntem)/,
  /onaylar m[ıi]s[ıi]n|onaylıyor musun|onay(ın|ınız|ini|inizi)? (lazım|gerek|bekliyorum)/,
  /nasıl devam|devam edeyim mi|devam edelim mi|ilerleyeyim mi|yapayım mı|yapalım mı/,
  /ne yapmamı|ne dersin|ne yapalım|karar(ın|ınız)|tercih(in|iniz|en)|söyler misin|belirtir misin/,
];

const BLOCKER_PHRASES: RegExp[] = [
  /\bi'?m (blocked|stuck)\b|\bi am (blocked|stuck)\b|\bblocked (on|by)\b/,
  /\b(can't|cannot|can not|unable to) (proceed|continue|go further|finish|complete)\b/,
  /\bi need (access|credentials|permission|a token|an api key|you to)\b/,
  /\b(requires|need) your (input|access|credentials|permission|help)\b/,
  /\bmissing (credentials|permissions?|access|an? api key|token)\b/,
  /takıldım|bloke|devam edemiyorum|ilerleyemiyorum|erişimim yok|yetkim yok|izin(in|iniz)? (gerek|lazım)|senden .{0,40}(lazım|gerekiyor|bekliyorum)/,
];

/** Turkish yes/no particle at the end of a sentence: "devam edeyim mi", "uygun mu". */
const TR_PARTICLE = /\s(m[ıiuü]|m[ıiuü]s[ıiuü]n|m[ıiuü]y[ıi]m|m[ıiuü]s[ıiuü]n[ıiuü]z)\s*[.!]?\s*$/;

/** The last few paragraphs of a message (code removed), where a question would be. */
function tailParagraphs(text: string, maxChars: number): string[] {
  const paragraphs = withoutCode(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let size = 0;
  for (let i = paragraphs.length - 1; i >= 0 && out.length < 3; i--) {
    out.unshift(paragraphs[i]!);
    size += paragraphs[i]!.length;
    if (size >= maxChars) break;
  }
  return out;
}

export interface PlainQuestion {
  /** Trimmed, markdown-lite tail of the agent's message to show on the call. */
  body: string;
  /** Options the agent listed; empty means free text only. */
  choices: string[];
  why: "options" | "question-mark" | "phrase" | "blocker";
}

/**
 * Decide whether the agent's last message is really a question or a decision
 * request written in plain text (instead of calling glint ask_user): it lists
 * options, ends a line with "?", uses an asking phrase ("should I",
 * "ister misin", "hangisi"…), or says it is blocked. Only the tail of the
 * message is examined so a long summary that mentions "which" stays a stop.
 */
export function detectPlainQuestion(text: string): PlainQuestion | null {
  if (!text || !text.trim()) return null;
  const choices = choicesFromMessage(text);
  const tail = tailParagraphs(text, 700);
  const lastPara = tail.at(-1) ?? "";
  const tailText = lowerTr(tail.slice(-2).join("\n"));
  const lastLines = lastPara
    .split("\n")
    .map((l) => l.trim().replace(/[*_)"'»”\s]+$/, ""))
    .filter(Boolean)
    .slice(-3);
  let why: PlainQuestion["why"] | null = null;
  if (choices.length > 0) why = "options";
  else if (lastLines.some((l) => /[?？]$/.test(l)) || /[?？]\s*$/.test(lastPara.slice(-300))) why = "question-mark";
  else if (QUESTION_PHRASES.some((re) => re.test(tailText)) || lastLines.some((l) => TR_PARTICLE.test(lowerTr(l)))) why = "phrase";
  else if (BLOCKER_PHRASES.some((re) => re.test(tailText))) why = "blocker";
  if (!why) return null;
  return { body: questionBody(text), choices: choices.length > 0 ? choices : inlineChoices(lastLines), why };
}

const INLINE_SKIP = new Set(["it", "this", "that", "them", "me", "you", "now", "not", "no", "yes", "so", "bu", "şu", "o", "değil"]);

/** "Postgres or SQLite?" / "Postgres mi SQLite mı?" at the end of the last question line → two buttons. */
export function inlineChoices(lastLines: string[]): string[] {
  const line = [...lastLines].reverse().find((l) => /[?？]$/.test(l));
  if (!line) return [];
  const clean = (w: string) => w.replace(/^[*_`"'“(]+|[*_`"'”),.:;]+$/g, "").trim();
  const tr = /(\S+)\s+m[ıiuü]\s*,?\s+(?:yoksa\s+)?(\S+)\s+m[ıiuü]\s*[?？]$/iu.exec(line);
  const en = /(\S+)\s*,?\s+or\s+(\S+)\s*[?？]$/i.exec(line);
  const m = tr ?? en;
  if (!m) return [];
  const a = clean(m[1]!);
  const b = clean(m[2]!);
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return [];
  if (INLINE_SKIP.has(lowerTr(a)) || INLINE_SKIP.has(lowerTr(b))) return [];
  return [a, b];
}

/** Light markdown clean-up for the panel: no #, **, `, link URLs or code fences; bullets become •. */
export function markdownLite(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The end of the message (≤ max chars, whole paragraphs where possible), markdown-lite. */
export function questionBody(text: string, max = 900): string {
  const clean = markdownLite(text);
  if (clean.length <= max) return clean;
  const paragraphs = clean.split(/\n\s*\n/);
  const kept: string[] = [];
  let size = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i]!;
    if (size + p.length + 2 > max) {
      if (kept.length === 0) kept.unshift(p.slice(p.length - (max - 1)));
      break;
    }
    kept.unshift(p);
    size += p.length + 2;
  }
  return `…${kept.join("\n\n")}`;
}

/* ---------- built-in ask tools (AskUserQuestion, request_user_input, question) ---------- */

/** Built-in "ask the user" tools of the harnesses, which Glint answers instead of the terminal. */
export function isBuiltinAskTool(name: unknown): boolean {
  if (typeof name !== "string" || !name) return false;
  if (isGlintAskTool(name)) return false;
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  return n === "askuserquestion" || n === "requestuserinput" || n === "question" || n === "askuser" || n === "askfollowupquestion" || n === "notifyuser";
}

/**
 * agy's notify_user is both "FYI" and "I need you". Only treat it as a
 * question when it blocks on the user, asks for feedback, or reads as one.
 */
function agyNotifyAsks(input: unknown): AskToolQuestion[] {
  if (!input || typeof input !== "object") return [];
  const a = input as Record<string, unknown>;
  const message = [a.Message, a.message, a.Text, a.text].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (!message) return [];
  const blocking = a.BlockedOnUser === true || a.blockedOnUser === true || a.AskForUserFeedback === true || a.askForUserFeedback === true;
  const plain = detectPlainQuestion(message);
  if (!blocking && !plain) return [];
  return [{ question: plain ? plain.body : questionBody(message), header: "", choices: plain ? plain.choices : choicesFromMessage(message), multiple: false }];
}

export interface AskToolQuestion {
  /** Exact question text (the key Claude expects in `answers`). */
  question: string;
  header: string;
  choices: string[];
  multiple: boolean;
}

function optionLabel(option: unknown): string {
  if (typeof option === "string") return option.trim();
  if (option && typeof option === "object") {
    const o = option as Record<string, unknown>;
    for (const key of ["label", "value", "title", "text"]) if (typeof o[key] === "string" && (o[key] as string).trim()) return (o[key] as string).trim();
  }
  return "";
}

/** Questions in an ask tool's input: Claude/Codex/OpenCode use {questions:[{question, header, options:[{label}]}]}. */
export function askToolQuestions(input: unknown): AskToolQuestion[] {
  if (!input || typeof input !== "object") return typeof input === "string" && input.trim() ? [{ question: input.trim(), header: "", choices: [], multiple: false }] : [];
  const obj = input as Record<string, unknown>;
  const list = Array.isArray(obj.questions) ? obj.questions : [obj];
  const out: AskToolQuestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const question = [q.question, q.prompt, q.text, q.message].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    if (!question) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [];
    out.push({
      question,
      header: typeof q.header === "string" ? q.header.trim() : "",
      choices: rawOptions.map(optionLabel).filter(Boolean).slice(0, 9),
      multiple: q.multiSelect === true || q.multiple === true || q.multi_select === true,
    });
  }
  return out;
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
export const DEFAULT_MAX_CHAIN = 50;
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
  /** Session title when the harness sends one (OpenCode plugin does). */
  sessionTitle: string;
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
  // executionNum counts agy Stop invocations, including background-task
  // stops we skip. Only an explicit caller-managed chain is a chain count.
  const chainRaw = payload.chain;
  const toolCall = (payload.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : {}) as Record<string, unknown>;
  const consultedGlint =
    payload.glint_consulted === true || (transcript ? lastToolWasGlintAsk(transcript) : false);
  return {
    consultedGlint,
    session,
    cwd,
    sessionTitle: pickString(payload, ["session_title", "sessionTitle"]),
    lastMessage,
    stopHookActive: payload.stop_hook_active === true || payload.stopHookActive === true || payload.continuationActive === true,
    // agy sends {toolCall: {name, args}}.
    toolName: pickString(toolCall, ["name"]) || pickString(payload, ["tool_name", "toolName", "tool", "permission", "type"]),
    toolInput: toolCall.args ?? payload.tool_input ?? payload.toolInput ?? payload.args ?? payload.metadata ?? payload.pattern ?? null,
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

/**
 * agy's Stop fields (terminationReason/continuationActive/executionNum) do
 * not identify pending jobs. Match the brain transcript's task lifecycle,
 * in file order, without relying on step_index being unique. Fail open if
 * the current USER_INPUT boundary is missing from the bounded tail or the
 * current turn contains unreadable records.
 */
export function agyHasPendingBackgroundTask(file: string, maxBytes = 2_000_000): boolean {
  const lines = readTail(file, maxBytes).split("\n");
  const turn: Record<string, unknown>[] = [];
  let foundUser = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      entry = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    if (entry.type === "USER_INPUT") {
      foundUser = true;
      break;
    }
    turn.push(entry);
  }
  if (!foundUser) return false;
  const pending = new Set<string>();
  for (const entry of turn.reverse()) {
    if (typeof entry.content !== "string") continue;
    if (entry.source === "MODEL" && entry.type === "GENERIC" && entry.status === "RUNNING") {
      const start = /^Tool is running as a background task with task id: (\S+)[ \t]*\r?$/m.exec(entry.content);
      if (start) pending.add(start[1]!);
    } else if (entry.source === "SYSTEM" && entry.type === "SYSTEM_MESSAGE") {
      // Require the system envelope and matching sender, not text quoted in
      // tool output or an assistant/user message. Failure results finish too.
      const done = /^\[Message\] timestamp=\S+ sender=(\S+) priority=\S+ content=Task id "([^"\r\n]+)" finished with result:/m.exec(entry.content);
      if (done && done[1] === done[2]) pending.delete(done[2]!);
      if (/^\[Message\] timestamp=\S+ sender=system priority=\S+ content=\[Notice\] All your subagents and background tasks have been stopped due to server restart\./m.test(entry.content)) pending.clear();
    }
  }
  return pending.size > 0;
}

/** Keep the new-turn reset even when executionNum=0 was a skipped Stop. */
function agyTurn(payload: Record<string, unknown>): string | undefined {
  const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
  if (!transcript) return undefined;
  const lines = readTail(transcript, 2_000_000).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!);
      if (entry?.type === "USER_INPUT") return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
    } catch { /* Ignore partial tail records for turn identity only. */ }
  }
  return undefined;
}

/** Text of a user message entry in a Claude/Codex JSONL transcript, or "" if it isn't one. */
function userText(entry: Record<string, unknown>): string {
  const message = (entry.message ?? entry.payload ?? entry) as Record<string, unknown>;
  if (entry.type === "event_msg" && message.type === "user_message" && typeof message.message === "string") return message.message;
  const isUser = entry.type === "user" || message.role === "user";
  if (!isUser) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // A tool result is not something the person typed.
  if (content.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "tool_result")) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter(Boolean)
    .join(" ");
}

/** The last thing the person typed, from the hook payload or the transcript tail (for the call's context line). */
export function lastUserPrompt(payload: Record<string, unknown>, maxBytes = 1_000_000): string {
  const direct = pickString(payload, ["session_title", "sessionTitle", "title", "prompt", "last_user_message", "last-user-message", "lastUserMessage", "user_prompt", "lastUserInput", "last_user_input"]);
  if (direct) return direct;
  const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
  if (!transcript) return "";
  const lines = readTail(transcript, maxBytes).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes("user")) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = userText(entry).trim();
    // Skip harness-injected blocks (<environment_context>, <system-reminder>…) and Glint's own continuations.
    if (!text || text.startsWith("<") || /^Stop hook feedback|^The user (picked|replied|answered)[^"]{0,40}Glint/i.test(text)) continue;
    return text;
  }
  return "";
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
  [key: string]: { count: number; at: number; agyTurn?: string };
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
  // agy 1.5.x leaves continuationActive false. Use its zero only to reset a
  // new turn; count actual Glint continuations locally, never skipped stops.
  if (harness === "agy" && input.raw.executionNum === 0) return 0;
  const state = readChain(dir);
  const entry = state[key];
  if (!entry) return 0;
  if (harness === "agy") {
    const turn = agyTurn(input.raw);
    if (turn && turn !== entry.agyTurn) return 0;
  }
  if ((harness === "claude" || harness === "codex") && !input.stopHookActive) return 0;
  if (now - entry.at > CHAIN_RESET_MS) return 0;
  return entry.count;
}

function bumpChain(dir: string, key: string, count: number, now: number, agyTurn?: string): void {
  const state = readChain(dir);
  state[key] = { count, at: now, ...(agyTurn ? { agyTurn } : {}) };
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

/** Continuation after the user answered a question the agent asked in plain text. */
export function answerMessage(answer: string, choiceIndex: number | null): string {
  const picked = choiceIndex != null ? ` (option ${choiceIndex + 1})` : "";
  return `The user answered your question through Glint${picked}: "${answer}". Continue accordingly. Next time ask with the glint ask_user tool instead of plain text.`;
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

/** Payload keys whose string values are kept in GLINT_HOOK_LOG; every other string is redacted. */
const LOG_KEEP_KEYS = new Set([
  "hook_event_name",
  "hookEventName",
  "event",
  "type",
  "stop_hook_active",
  "continuationActive",
  "executionNum",
  "chain",
  "terminationReason",
  "stopReason",
  "stop_reason",
  "tool_name",
  "toolName",
  "name",
  "source",
  "model",
  "permission_mode",
]);

/**
 * GLINT_HOOK_LOG writes the hook payload *shape* for debugging, not its
 * content: prompts, assistant messages, transcript paths, cwd, tool input and
 * any other free text are replaced with `<redacted:N chars>`. Numbers,
 * booleans and a short allow-list of enum-like fields are kept.
 */
export function redactHookPayload(value: unknown, key = ""): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return LOG_KEEP_KEYS.has(key) && value.length <= 80 ? value : `<redacted:${value.length} chars>`;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactHookPayload(item, key));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactHookPayload(v, k);
    return out;
  }
  return "<redacted>";
}

export async function runHook(
  harness: Harness,
  event: HookEvent,
  rawInput: string,
  deps: HookDeps,
): Promise<HookOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  // The person is not at this desktop: no call, no notice, no continuation.
  const delivery = glintDeliveryMode({ env });
  if (delivery.mode === "off") return noop(harness, event, `glint suppressed (${delivery.reason})`);
  const payload = parseHookPayload(rawInput);
  if (env.GLINT_HOOK_LOG === "1") {
    try {
      const dir = deps.stateDir ?? glintHome();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "hook-payloads.jsonl"), `${JSON.stringify({ at: now(), harness, event, payload: redactHookPayload(payload) })}\n`, { mode: 0o600 });
    } catch {
      // debugging aid only
    }
  }
  const input = normalizeHookInput(payload);
  // A titled Takopi session can share an OpenCode server with the person's
  // terminal, so the process tree alone is not enough there.
  if (isTakopiSessionTitle(input.sessionTitle)) return noop(harness, event, "glint suppressed (takopi session title)");
  if (sessionSuppressed(input.session)) return noop(harness, event, "glint suppressed (muted session)");
  const agent = harnessName(harness);
  const project = projectLabel(input.cwd);
  const origin = env.GLINT_ORIGIN === "0" ? undefined : captureOrigin({ cwd: input.cwd, title: lastUserPrompt(payload) }, { ...defaultOriginDeps(), env });
  if (origin) {
    origin.harness = harness;
    if (input.session) origin.session = input.session.slice(0, 200);
  }
  const identity = {
    agent,
    project,
    harness,
    cwd: input.cwd,
    ...(input.session ? { session: input.session.slice(0, 200) } : {}),
    ...(origin ? { origin } : {}),
  };

  if (env.GLINT_HOOK === "0" || env.GLINT_HOOKS === "0") {
    return noop(harness, event, "hooks disabled by GLINT_HOOK=0");
  }

  if (event === "notify") {
    const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
    if (harness === "agy" && transcript && agyHasPendingBackgroundTask(transcript)) {
      return noop(harness, event, "agy background task still pending");
    }
    const text = input.lastMessage || "Turn complete.";
    try {
      await deps.notify({ message: text, ...identity });
    } catch {
      // Never fail the harness over a notice.
    }
    return { action: "noop", stdout: "", reason: "notify is fire-and-forget" };
  }

  if (event === "pretooluse") {
    if (delivery.mode !== "ring") return noop(harness, event, "notify mode: defer to harness");
    if (isBuiltinAskTool(input.toolName)) return runAskTool(harness, input, identity, deps, env);
    return runApproval(harness, input, identity, deps, env);
  }

  // Stop / idle.
  // agy also runs Stop on errors, cancels and budget limits; only a normal
  // end of turn (NO_TOOL_CALL) should open a call.
  const terminationReason = typeof input.raw.terminationReason === "string" ? input.raw.terminationReason : "";
  if (harness === "agy" && terminationReason && terminationReason !== "NO_TOOL_CALL") {
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: `agy stopped with ${terminationReason}` };
  }
  const transcript = pickString(payload, ["transcript_path", "transcriptPath"]);
  if (harness === "agy" && transcript && agyHasPendingBackgroundTask(transcript)) {
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: "agy background task still pending" };
  }
  if (delivery.mode === "notify") {
    try {
      await deps.notify({ message: input.lastMessage || `${agent} stopped and is waiting for you. Anything else?`, ...identity });
    } catch {
      // A failed notice must never prevent the normal stop.
    }
    return { action: "stop", stdout: stopOutput(harness, "stop"), reason: "notify mode" };
  }
  const stateDir = deps.stateDir ?? glintHome();
  const key = `${harness}:${input.session || input.cwd}`;
  // 0 is an explicit opt-out for people who drive a long conversation by hand;
  // the default stays a last-resort brake for unattended/runaway hooks.
  const maxChain = env.GLINT_HOOK_MAX_CHAIN === "0"
    ? Number.POSITIVE_INFINITY
    : envNumber(env, "GLINT_HOOK_MAX_CHAIN", DEFAULT_MAX_CHAIN);
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
  // Detection supplies buttons and call kind only. The body is always the
  // complete last output, including markdown and surrounding whitespace.
  const plain = env.GLINT_DETECT_QUESTIONS === "0" ? null : detectPlainQuestion(input.lastMessage);
  const question = input.lastMessage || `${agent} stopped and is waiting for you. Anything else?`;
  const result = await askWithDeadline(
    deps,
    {
      question,
      choices: plain ? plain.choices : choicesFromMessage(input.lastMessage),
      timeoutMs,
      kind: plain ? "question" : "stop",
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
  const message = plain ? answerMessage(result.answer, result.choiceIndex) : continuationMessage(result.answer, result.choiceIndex);
  bumpChain(stateDir, key, chain + 1, now(), harness === "agy" ? agyTurn(input.raw) : undefined);
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

/**
 * The agent called its harness's own ask tool (Claude's AskUserQuestion,
 * Codex's request_user_input, OpenCode's question). Ring each question in
 * Glint; once all are answered, hand the answers back: Claude gets the tool
 * allowed with `answers` filled in (its own answer format), others get the
 * tool denied with the answers in the reason. If the user doesn't answer in
 * Glint, do nothing so the harness asks in the terminal as usual.
 */
async function runAskTool(
  harness: Harness,
  input: NormalizedHookInput,
  identity: Omit<AskInput, "question">,
  deps: HookDeps,
  env: NodeJS.ProcessEnv,
): Promise<HookOutcome> {
  if (env.GLINT_ASK_TOOLS === "0") return { action: "noop", stdout: "", reason: "GLINT_ASK_TOOLS=0" };
  const isNotify = input.toolName.toLowerCase().replace(/[^a-z]/g, "") === "notifyuser";
  const questions = isNotify ? agyNotifyAsks(input.toolInput) : askToolQuestions(input.toolInput);
  if (questions.length === 0) return { action: "noop", stdout: "", reason: isNotify ? "notify_user without a question" : "ask tool without a readable question" };
  const timeoutMs = envNumber(env, "GLINT_HOOK_TIMEOUT_MS", DEFAULT_HOOK_TIMEOUT_MS);
  const answers: Array<{ q: AskToolQuestion; answer: string }> = [];
  for (const [i, q] of questions.entries()) {
    const prefix = questions.length > 1 ? `(${i + 1}/${questions.length}) ` : "";
    const header = q.header && !q.question.toLowerCase().includes(q.header.toLowerCase()) ? `${q.header}: ` : "";
    const hint = q.multiple && q.choices.length > 0 ? "\n(Several allowed: type them separated by commas.)" : "";
    const result = await askWithDeadline(
      deps,
      { ...identity, question: clip(`${prefix}${header}${q.question}${hint}`, 1_800), choices: q.choices, timeoutMs, kind: "question" },
      timeoutMs + 2_000,
    );
    if (!result || result.status !== "answered" || !result.answer) {
      return { action: "noop", stdout: "", reason: result ? `ask tool: ${result.status}` : "glint unreachable or hook deadline" };
    }
    answers.push({ q, answer: result.answer });
  }
  const summary = answers.map(({ q, answer }) => `"${clip(q.question, 300)}" → "${answer}"`).join("; ");
  if (harness === "opencode") {
    // The OpenCode plugin replies to the question form itself with these answers.
    const reason = `Answered by the user in Glint: ${summary}`;
    return { action: "allow", stdout: JSON.stringify({ action: "answer", answers: answers.map((a) => a.answer), reason }), message: reason };
  }
  const mode = env.GLINT_ASK_TOOL_MODE === "deny" || env.GLINT_ASK_TOOL_MODE === "allow" ? env.GLINT_ASK_TOOL_MODE : harness === "claude" ? "allow" : "deny";
  if (mode === "allow" && (harness === "claude" || harness === "codex") && input.toolInput && typeof input.toolInput === "object") {
    const updatedInput = {
      ...(input.toolInput as Record<string, unknown>),
      answers: Object.fromEntries(answers.map(({ q, answer }) => [q.question, answer])),
    };
    const reason = `Answered by the user in Glint: ${summary}`;
    return {
      action: "allow",
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason, updatedInput },
      }),
      message: reason,
    };
  }
  const reason = `The user already answered through Glint, so this tool was not shown. Answers: ${summary}. Use these answers and continue; do not ask again.`;
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
