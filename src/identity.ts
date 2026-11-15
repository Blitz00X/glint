import { createHash } from "node:crypto";
import type { Origin } from "./origin.js";
import { projectLabel } from "./project.js";

/**
 * Caller identity shown on a Glint call and in the feed.
 * The tag and color are derived from a hash so the same session always
 * looks the same, without the daemon having to remember anything.
 */
export interface Caller {
  /** Display name, e.g. "Claude Code". */
  name: string;
  /** Project label, usually the basename of the working directory. */
  project: string;
  /** Short stable session tag, e.g. "a3f9". Shown as #a3f9. */
  tag: string;
  /** Stable accent color for this session (hex). */
  color: string;
  /** Harness id when known: claude, codex, agy, opencode, mcp, cli. */
  harness: string;
  /** Where the call came from (folder, branch, terminal/app) and how to jump back. */
  origin?: Origin;
}

/**
 * Twelve accents that stay readable on a dark translucent panel and are far
 * enough apart that two sessions side by side are easy to tell apart.
 */
export const SESSION_PALETTE = [
  "#3ee8ff", // cyan
  "#ff4fd8", // magenta
  "#ffb347", // amber
  "#9dff6a", // lime
  "#a98bff", // violet
  "#ff6b6b", // coral
  "#2fe0b0", // teal
  "#ffe14d", // gold
  "#5aa8ff", // sky
  "#ff8fb1", // rose
  "#c6ff3d", // acid
  "#ff9a3c", // orange
] as const;

const TAG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function sessionHash(harness: string, cwd: string, session: string): Buffer {
  return createHash("sha256")
    .update(`${harness.trim().toLowerCase()}\u0000${cwd.trim()}\u0000${session.trim()}`)
    .digest();
}

export function sessionTag(harness: string, cwd: string, session: string, length = 4): string {
  const digest = sessionHash(harness, cwd, session);
  let out = "";
  for (let i = 0; i < length; i++) out += TAG_ALPHABET[digest[i]! % TAG_ALPHABET.length];
  return out;
}

export function sessionColor(harness: string, cwd: string, session: string): string {
  const digest = sessionHash(harness, cwd, session);
  return SESSION_PALETTE[digest.readUInt16BE(8) % SESSION_PALETTE.length]!;
}

export function harnessName(harness: string | undefined): string {
  switch ((harness ?? "").trim().toLowerCase()) {
    case "claude":
    case "claude-code":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "codex-desktop":
      return "Codex Desktop";
    case "codex":
      return "Codex";
    case "agy":
    case "antigravity":
      return "Antigravity";
    case "opencode":
      return "OpenCode";
    case "cursor":
      return "Cursor";
    case "gemini":
      return "Gemini CLI";
    default:
      return "";
  }
}

export function harnessFromAgent(agent: string | undefined): string {
  const value = (agent ?? "").toLowerCase();
  if (value.includes("claude")) return "claude";
  if (value.includes("codex")) return "codex";
  if (value.includes("antigravity") || value === "agy") return "agy";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("gemini")) return "gemini";
  return value.replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

export interface CallerInput {
  agent?: string;
  project?: string;
  session?: string;
  harness?: string;
  /** Full working directory when known; hashed instead of the project label. */
  cwd?: string;
  origin?: Origin;
}

/**
 * Build the caller for a question or notice. Without a session id the tag is
 * derived from agent + project, so one agent in one project keeps one color.
 */
export function callerFor(input: CallerInput): Caller {
  const harness = (input.harness?.trim() || harnessFromAgent(input.agent)).toLowerCase();
  const name = input.agent?.trim() || harnessName(harness) || "agent";
  const project = input.project?.trim() ? projectLabel(input.cwd, input.project) : input.cwd?.trim() ? projectLabel(input.cwd) : "";
  const where = input.cwd?.trim() || project;
  const session = input.session?.trim() || `${name}@${where}`;
  // Older MCP servers captured an origin before project labels existed; fill
  // it here so the panel never shows a bare UUID to the person.
  const origin = input.origin ? { ...input.origin } : undefined;
  if (origin && !origin.project && origin.cwd) origin.project = projectLabel(origin.cwd).slice(0, 120);
  return {
    name,
    project,
    tag: sessionTag(harness, where, session),
    color: sessionColor(harness, where, session),
    harness,
    ...(origin && Object.keys(origin).length > 0 ? { origin } : {}),
  };
}
