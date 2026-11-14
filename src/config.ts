import fs from "node:fs";
import path from "node:path";
import { glintHome } from "./paths.js";
import { parseLayout, type OverlayLayout } from "./protocol.js";

/** Persistent user settings, kept in GLINT_HOME/config.json (mode 0600). */
export interface GlintConfig {
  layout?: OverlayLayout;
}

export function configPath(home = glintHome()): string {
  return path.join(home, "config.json");
}

export function readConfig(home = glintHome()): GlintConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(home), "utf8")) as Record<string, unknown>;
    const config: GlintConfig = {};
    const layout = typeof raw.layout === "string" ? parseLayout(raw.layout) : undefined;
    if (layout) config.layout = layout;
    return config;
  } catch {
    return {};
  }
}

export function writeConfig(patch: GlintConfig, home = glintHome()): GlintConfig {
  const file = configPath(home);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const next = { ...existing, ...patch };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return readConfig(home);
}

export type LayoutSource = "env" | "config" | "default";

/**
 * Which layout the daemon starts with. An explicitly set GLINT_LAYOUT wins,
 * then the picker's saved choice in config.json, then deneme1.
 */
export function resolveStartLayout(
  env: NodeJS.ProcessEnv = process.env,
  home = glintHome(),
): { layout: OverlayLayout; source: LayoutSource } {
  const fromEnv = parseLayout(env.GLINT_LAYOUT);
  if (fromEnv) return { layout: fromEnv, source: "env" };
  const saved = readConfig(home).layout;
  if (saved) return { layout: saved, source: "config" };
  return { layout: "deneme1", source: "default" };
}
