import fs from "node:fs";
import path from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID_RE = /^[0-9a-f]{8,}(?:-[0-9a-f]{2,}){1,}$/i;
const GENERIC_DIRS = new Set(["task-workspaces", "workspaces", "workspace", "tmp", "temp", "scratch", "run", "home", "projects"]);

/** A bare session/thread id is not a label a person can recognise. */
export function isOpaqueName(value: string | undefined): boolean {
  const name = (value ?? "").trim();
  if (!name) return true;
  return UUID_RE.test(name) || HEX_ID_RE.test(name);
}

function pretty(segment: string): string {
  const cleaned = segment.replace(/^\.+/, "");
  const key = cleaned.toLowerCase();
  if (key === "openmausbot" || key === "open-mausbot") return "OpenMausBot";
  return cleaned || segment;
}

interface BotCache {
  mtimeMs: number;
  names: Map<string, string>;
}

let botCache: BotCache | null = null;

/** OpenMausBot keeps bot ids in task-workspace paths; bots.json names them. */
function openMausBotName(botId: string, root: string): string {
  try {
    const file = path.join(root, "bots.json");
    const stat = fs.statSync(file);
    if (!botCache || botCache.mtimeMs !== stat.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      const names = new Map<string, string>();
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const bot = entry as { id?: unknown; name?: unknown };
          if (typeof bot.id === "string" && typeof bot.name === "string" && bot.name.trim()) names.set(bot.id, bot.name.trim());
        }
      }
      botCache = { mtimeMs: stat.mtimeMs, names };
    }
    return botCache.names.get(botId) ?? "";
  } catch {
    return "";
  }
}

/**
 * Label for the panel and feed. Prefers an explicit project name, then the
 * host's bot name, then the nearest readable directory. A UUID on its own is
 * never shown: a session the person cannot recognise is worse than "workspace".
 */
export function projectLabel(cwd?: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const given = (explicit ?? "").trim();
  if (given && !isOpaqueName(given)) return given;

  const dir = (cwd ?? "").trim();
  if (!dir) return "workspace";

  const hostRoot = (env.OMB_DATA_DIR ?? "").trim();
  if (hostRoot) {
    const rel = path.relative(hostRoot, dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      const parts = rel.split(path.sep).filter(Boolean);
      const botId = parts[0] === "task-workspaces" || parts[0] === "workspaces" ? parts[1] : undefined;
      if (botId && UUID_RE.test(botId)) {
        return openMausBotName(botId, hostRoot) || "OpenMausBot";
      }
    }
  }

  const parts = dir.split(/[\\/]+/).filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.includes(".openmausbot") && (lower.includes("task-workspaces") || lower.includes("workspaces"))) return "OpenMausBot";

  let index = parts.length - 1;
  while (index >= 0 && (isOpaqueName(parts[index]) || GENERIC_DIRS.has(lower[index] ?? ""))) index -= 1;
  if (index < 0) return "workspace";
  return pretty(parts[index] ?? "");
}
