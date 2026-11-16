import fs from "node:fs";

/** True when Glint is running inside WSL (WSLg), where X11 global grabs do not
 * receive keys while a Windows application owns the focus. */
export function isWsl(env: NodeJS.ProcessEnv = process.env, osRelease?: string): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  let text = osRelease;
  if (text == null) {
    try {
      text = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8");
    } catch {
      return false;
    }
  }
  return /microsoft/i.test(text);
}

/** What `glint demo` prints before the first call rings. */
export function demoGuide(wsl: boolean): string[] {
  const lines = [
    "Glint demo — three sample calls will ring.",
    "The first panel is focused for you; click a panel if the keyboard does not reach it.",
    "Keys: 1–9 choose · Enter send · Esc dismiss.",
  ];
  if (wsl) {
    lines.push(
      "WSL: Ctrl+Shift+G/F/L are X11 global shortcuts and do not receive keys under WSLg.",
      "Use `glint focus` in another terminal, or click the panel, before typing.",
    );
  }
  return lines;
}
