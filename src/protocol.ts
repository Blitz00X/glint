import { z } from "zod";
import type { Caller } from "./identity.js";
import { originSchema } from "./origin.js";

export type { Caller } from "./identity.js";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_CHOICES = 9;
export const MAX_PENDING = 12;
export const DEFAULT_NOTICE_MS = 6_500;
export const MAX_EVENTS = 100;
export const CALL_KINDS = ["question", "stop", "approval"] as const;
export const callKindSchema = z.enum(CALL_KINDS);
export type CallKind = z.infer<typeof callKindSchema>;
export const LAYOUT_MODES = ["deneme1", "deneme2", "deneme3", "ticker", "bubble", "edge", "island"] as const;

export const layoutSchema = z.enum(LAYOUT_MODES);
export type OverlayLayout = z.infer<typeof layoutSchema>;

const LAYOUT_ALIASES: Record<string, OverlayLayout> = {
  deneme1: "deneme1",
  corner: "deneme1",
  "top-right-stack": "deneme1",
  "01": "deneme1",
  deneme2: "deneme2",
  center: "deneme2",
  "giant-hud": "deneme2",
  "02": "deneme2",
  deneme3: "deneme3",
  badge: "deneme3",
  "bang-badge": "deneme3",
  "03": "deneme3",
  ticker: "ticker",
  "bottom-ticker": "ticker",
  "04": "ticker",
  bubble: "bubble",
  "cursor-bubble": "bubble",
  "05": "bubble",
  edge: "edge",
  "edge-strip": "edge",
  "06": "edge",
  island: "island",
  "island-pill": "island",
  "08": "island",
};

export function parseLayout(value: string | undefined): OverlayLayout | undefined {
  if (!value) return undefined;
  return LAYOUT_ALIASES[value.trim().toLowerCase()];
}

export class GlintError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "GlintError";
    this.status = status;
  }
}

export const askInputSchema = z.object({
  question: z.string().min(1).max(20_000).refine((text) => text.trim().length > 0, "Question must not be blank"),
  choices: z.array(z.string().trim().min(1).max(240)).max(MAX_CHOICES).optional(),
  agent: z.string().trim().min(1).max(80).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  layout: layoutSchema.optional(),
  session: z.string().trim().min(1).max(200).optional(),
  harness: z.string().trim().min(1).max(40).optional(),
  cwd: z.string().trim().min(1).max(1_000).optional(),
  origin: originSchema.optional(),
  kind: callKindSchema.optional(),
});

export type AskInput = z.infer<typeof askInputSchema>;

export const notifyInputSchema = z.object({
  message: z.string().min(1).max(20_000).refine((text) => text.trim().length > 0, "Message must not be blank"),
  agent: z.string().trim().min(1).max(80).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  durationMs: z.number().int().min(500).max(120_000).optional(),
  layout: layoutSchema.optional(),
  session: z.string().trim().min(1).max(200).optional(),
  harness: z.string().trim().min(1).max(40).optional(),
  cwd: z.string().trim().min(1).max(1_000).optional(),
  origin: originSchema.optional(),
});

export type NotifyInput = z.infer<typeof notifyInputSchema>;

export const layoutInputSchema = z.object({
  layout: layoutSchema,
});

export type LayoutInput = z.infer<typeof layoutInputSchema>;

export const settleSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["answered", "dismissed"]),
  answer: z.string().max(4_000).optional(),
  choiceIndex: z.number().int().min(0).max(MAX_CHOICES - 1).optional(),
  via: z.enum(["choice", "text", "dismiss"]).optional(),
});

export type SettleInput = z.infer<typeof settleSchema>;

export interface Question {
  id: string;
  question: string;
  choices: string[];
  agent: string;
  project: string;
  timeoutMs: number | null;
  layout?: OverlayLayout;
  createdAt: number;
  kind: CallKind;
  caller: Caller;
}

export interface Notice {
  id: string;
  message: string;
  agent: string;
  project: string;
  durationMs: number;
  layout?: OverlayLayout;
  createdAt: number;
  caller: Caller;
}

/** One line in the group-chat feed. The daemon keeps the last MAX_EVENTS. */
export interface FeedEvent {
  seq: number;
  at: number;
  type: "call" | "answer" | "notice";
  /** Question or notice id this event belongs to. */
  ref: string;
  caller: Caller;
  text: string;
  kind?: CallKind;
  choices?: string[];
  status?: AskResult["status"];
  via?: AskVia | null;
}

export type AskVia = "choice" | "text" | "dismiss" | "timeout" | "disconnect";

export interface AskResult {
  id: string;
  status: "answered" | "dismissed" | "timeout";
  answer: string | null;
  choiceIndex: number | null;
  via: AskVia | null;
}

export interface NotifyResult {
  id: string;
  delivered: true;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  version: typeof PROTOCOL_VERSION;
  startedAt: number;
}

export interface OverlaySink {
  question(question: Question): void;
  notice(notice: Notice): void;
  resolved(id: string, result: AskResult): void;
  layoutChanged?(layout: OverlayLayout): void;
  /** Open the concept picker window. Returns false when there is no UI to open. */
  openPicker?(): void;
  /** Focus the newest panel. Used by `glint focus` from a Wayland keybinding. */
  focus?(): void;
  event?(event: FeedEvent): void;
}

export function formatAskResult(result: AskResult): string {
  const json = JSON.stringify({
    id: result.id,
    status: result.status,
    answer: result.answer,
    choiceIndex: result.choiceIndex,
    via: result.via,
  });
  if (result.status === "answered") {
    const which = result.choiceIndex != null ? ` (choice ${result.choiceIndex + 1})` : "";
    return `The user answered${which}: ${result.answer}\n${json}`;
  }
  if (result.status === "dismissed") {
    const why = result.via === "disconnect" ? " The request was cancelled." : "";
    return `The user dismissed the prompt without answering.${why}\n${json}`;
  }
  return `The prompt timed out before the user answered.\n${json}`;
}

export function formatNotifyResult(result: NotifyResult): string {
  return `Delivered to the Glint overlay.\n${JSON.stringify(result)}`;
}

export function parseAskInput(value: unknown): AskInput {
  const parsed = askInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new GlintError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }
  return parsed.data;
}

export function parseNotifyInput(value: unknown): NotifyInput {
  const parsed = notifyInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new GlintError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }
  return parsed.data;
}

export function parseSettleInput(value: unknown): SettleInput {
  const parsed = settleSchema.safeParse(value);
  if (!parsed.success) {
    throw new GlintError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }
  return parsed.data;
}

export function parseLayoutInput(value: unknown): LayoutInput {
  const parsed = layoutInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new GlintError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }
  return parsed.data;
}
