import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * GNOME Do Not Disturb while a Glint call is open, so notification banners
 * (notify-send, chat apps) don't cover the panel. The previous value of
 * org.gnome.desktop.notifications show-banners is saved in GLINT_HOME and
 * restored when the last call ends, when the daemon exits, or on the next
 * start after a crash. GLINT_DND=0 turns this off.
 */

export const DND_SCHEMA = "org.gnome.desktop.notifications";
export const DND_KEY = "show-banners";

export type GsettingsRunner = (args: string[]) => string;

export interface DndOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  run?: GsettingsRunner;
  log?: (line: string) => void;
}

export interface DndController {
  readonly supported: boolean;
  /** Pass the number of open calls; turns DND on at >0 and restores at 0. */
  sync(openCalls: number): void;
  /** Restore the saved value (daemon exit). */
  restore(): void;
}

const defaultRun: GsettingsRunner = (args) =>
  execFileSync("gsettings", args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();

export function savedFile(home: string): string {
  return path.join(home, "dnd-saved.json");
}

export function createDnd(options: DndOptions): DndController {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const log = options.log ?? (() => {});
  const file = savedFile(options.home);
  let supported = false;
  if (env.GLINT_DND !== "0" && process.platform !== "win32" && process.platform !== "darwin") {
    try {
      // Fails when gsettings is missing or the schema/key doesn't exist.
      const writable = run(["writable", DND_SCHEMA, DND_KEY]);
      supported = writable === "true";
    } catch {
      supported = false;
    }
  }
  let active = false;

  const read = (): string | null => {
    try {
      const value = run(["get", DND_SCHEMA, DND_KEY]);
      return value === "true" || value === "false" ? value : null;
    } catch {
      return null;
    }
  };
  const write = (value: string): void => {
    try {
      run(["set", DND_SCHEMA, DND_KEY, value]);
    } catch (error) {
      log(`dnd: could not set ${DND_KEY}=${value}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const readSaved = (): string | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { value?: unknown };
      return parsed.value === "true" || parsed.value === "false" ? parsed.value : null;
    } catch {
      return null;
    }
  };

  const restore = (): void => {
    if (!supported) return;
    const saved = readSaved();
    if (saved != null) {
      write(saved);
      log(`dnd: restored ${DND_KEY}=${saved}`);
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
    active = false;
  };

  // Crash recovery: a saved value left over from a previous run is restored.
  if (supported && readSaved() != null) restore();

  return {
    get supported() {
      return supported;
    },
    sync(openCalls: number) {
      if (!supported) return;
      if (openCalls > 0 && !active) {
        active = true;
        const current = read();
        if (current === "true") {
          try {
            fs.mkdirSync(options.home, { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ value: current, at: Date.now() }));
          } catch {
            // still turn DND on; worst case the user re-enables banners
          }
          write("false");
          log("dnd: banners off while a call is open");
        }
      } else if (openCalls === 0 && active) {
        restore();
      }
    },
    restore,
  };
}
