import { execFile } from "node:child_process";
import { cdCommand, originSchema, type Origin } from "./origin.js";

/**
 * "Jump to source": bring the window a call came from to the front.
 * Tries, in order: tmux pane select, GNOME Terminal tab (its search
 * provider activates the exact tab), X11 window id, X11 windows of the owner
 * pid (XWayland apps such as Codex Desktop), the optional glint-focus GNOME
 * Shell extension, and finally copies a `cd` command so you can get there
 * by hand. Every command is run without a shell, with validated arguments.
 */

export interface JumpResult {
  ok: boolean;
  /** Which method raised the window (or "copy" for the fallback). */
  method: string;
  /** Short text for the panel, e.g. "GNOME Terminal tab" or "copied: cd '/x'". */
  message: string;
  tried: string[];
  copied?: string;
}

export interface JumpDeps {
  run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }>;
  copy?(text: string): void;
  now?(): number;
}

export function defaultJumpDeps(copy?: (text: string) => void): JumpDeps {
  return {
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 3_000, encoding: "utf8" }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? "") }));
      }),
    copy,
  };
}

/** The harness command that reopens the same session in its TUI, when known. */
function resumeCommand(origin: Origin): string[] | null {
  if (!origin.session) return null;
  if (origin.harness === "opencode") return ["opencode", "--session", origin.session];
  return null;
}

/**
 * No window to raise (an app-managed session): open a terminal at the folder.
 * If the harness exposes a session id, start its TUI on that same session
 * instead of a bare shell.
 */
async function openTerminal(cwd: string, origin: Origin, deps: JumpDeps): Promise<{ ok: boolean; resumed: boolean }> {
  const resume = resumeCommand(origin);
  if (resume) {
    const gnome = await deps.run("gnome-terminal", [`--working-directory=${cwd}`, "--", ...resume]);
    if (gnome.ok) return { ok: true, resumed: true };
  }
  const attempts: Array<[string, string[]]> = [
    ["gnome-terminal", [`--working-directory=${cwd}`]],
    ["kgx", ["--working-directory", cwd]],
    ["ptyxis", ["--new-window", "--working-directory", cwd]],
  ];
  for (const [cmd, args] of attempts) {
    if ((await deps.run(cmd, args)).ok) return { ok: true, resumed: false };
  }
  return { ok: false, resumed: false };
}

async function x11ActivatePid(pid: number, deps: JumpDeps): Promise<boolean> {
  // wmctrl -lp lists managed (mapped, top-level) X11 windows with their pid.
  const list = await deps.run("wmctrl", ["-lp"]);
  if (list.ok) {
    const ids = list.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 3 && Number(cols[2]) === pid)
      .map((cols) => cols[0]!);
    for (const id of ids) {
      if ((await deps.run("wmctrl", ["-i", "-a", id])).ok) return true;
    }
  }
  const found = await deps.run("xdotool", ["search", "--onlyvisible", "--pid", String(pid)]);
  const ids = found.ok ? found.stdout.split("\n").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)) : [];
  for (const id of ids.reverse()) {
    if ((await deps.run("xdotool", ["windowactivate", id])).ok) return true;
  }
  return false;
}

export async function jumpTo(raw: unknown, deps: JumpDeps): Promise<JumpResult> {
  const parsed = originSchema.safeParse(raw);
  const origin: Origin = parsed.success ? parsed.data : {};
  const tried: string[] = [];
  let paneSelected = false;

  if (origin.tmux) {
    tried.push("tmux");
    const { socket, pane } = origin.tmux;
    const w = await deps.run("tmux", ["-S", socket, "select-window", "-t", pane]);
    const p = await deps.run("tmux", ["-S", socket, "select-pane", "-t", pane]);
    // Show the pane on the attached client too (if it is looking at another session).
    await deps.run("tmux", ["-S", socket, "switch-client", "-t", pane]);
    paneSelected = w.ok && p.ok;
  }

  if (origin.gnomeScreen) {
    tried.push("gnome-terminal");
    const ts = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const r = await deps.run("gdbus", [
      "call", "--session", "--dest", "org.gnome.Terminal",
      "--object-path", "/org/gnome/Terminal/SearchProvider",
      "--method", "org.gnome.Shell.SearchProvider2.ActivateResult",
      origin.gnomeScreen, "[]", String(ts),
    ]);
    if (r.ok) return { ok: true, method: "gnome-terminal", message: `GNOME Terminal tab${paneSelected ? " + tmux pane" : ""}`, tried };
  }

  if (origin.windowId) {
    tried.push("x11-window");
    const id = origin.windowId.startsWith("0x") ? String(parseInt(origin.windowId, 16)) : origin.windowId;
    if ((await deps.run("xdotool", ["windowactivate", id])).ok) return { ok: true, method: "x11-window", message: `${origin.app ?? "window"}${paneSelected ? " + tmux pane" : ""}`, tried };
  }

  if (origin.pid) {
    tried.push("x11-pid");
    if (await x11ActivatePid(origin.pid, deps)) return { ok: true, method: "x11-pid", message: `${origin.app ?? "window"}${paneSelected ? " + tmux pane" : ""}`, tried };
    // Optional GNOME Shell extension shipped in extras/ (Wayland-native windows).
    tried.push("glint-focus");
    const ext = await deps.run("gdbus", [
      "call", "--session", "--dest", "org.gnome.Shell",
      "--object-path", "/io/github/blitz00x/GlintFocus",
      "--method", "io.github.blitz00x.GlintFocus.ActivatePid", String(origin.pid),
    ]);
    if (ext.ok && /true/.test(ext.stdout)) return { ok: true, method: "glint-focus", message: `${origin.app ?? "window"}${paneSelected ? " + tmux pane" : ""}`, tried };
  }

  if (paneSelected) return { ok: true, method: "tmux", message: "tmux pane selected (raise its terminal yourself)", tried };

  // App-managed sessions (OpenMausBot, a server, a container) have a cwd but
  // no terminal window to raise. Open one at the folder instead of only
  // copying a cd command the person may never see.
  if (origin.cwd && origin.kind !== "desktop" && origin.kind !== "vscode") {
    tried.push("terminal");
    const opened = await openTerminal(origin.cwd, origin, deps);
    if (opened.ok) {
      const where = origin.project || origin.cwd;
      const what = origin.harness === "opencode" ? "OpenCode TUI" : "agent session";
      return {
        ok: true,
        method: opened.resumed ? "session" : "terminal",
        message: opened.resumed ? `opened the ${what} in a terminal (${where})` : `opened a terminal in ${where}`,
        tried,
      };
    }
  }

  const where = [origin.cwd, origin.tty].filter(Boolean).join(" · ");
  if (origin.cwd && deps.copy) {
    const cd = cdCommand(origin.cwd);
    try {
      deps.copy(cd);
      return { ok: false, method: "copy", message: `couldn't focus it · copied: ${cd}${origin.tty ? ` (${origin.tty})` : ""}`, tried, copied: cd };
    } catch {}
  }
  return { ok: false, method: "none", message: where ? `couldn't focus it · ${where}` : "no source recorded for this call", tried };
}
