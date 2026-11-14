import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "glint") return dir;
      } catch {
        // Keep walking if a parent package.json is unreadable.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the glint package root");
}

export function glintHome(override?: string): string {
  if (override) return override;
  if (process.env.GLINT_HOME && process.env.GLINT_HOME.trim()) return process.env.GLINT_HOME;
  return path.join(os.homedir(), ".glint");
}

export function statePath(home = glintHome()): string {
  return path.join(home, "daemon.json");
}

export function logPath(home = glintHome()): string {
  return path.join(home, "daemon.log");
}

export function lockPath(home = glintHome()): string {
  return path.join(home, "spawn.lock");
}

export function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    // A home on a filesystem without chmod still works for local use.
  }
}
