import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectLabel } from "./project.js";

/**
 * Where a call came from: the folder and branch, the app or terminal, and
 * enough to jump back to it (GNOME Terminal tab, tmux pane, X11 window, pid).
 * Captured by the MCP server / hook process, which runs inside the agent's
 * terminal or app, so its environment and process ancestry point at it.
 */
export const originSchema = z.object({
  cwd: z.string().max(1_000).optional(),
  /** Human project label; a bare session UUID is never used. */
  project: z.string().max(120).optional(),
  /** Harness id and its session id, so a terminal can resume the same TUI. */
  harness: z.string().max(40).optional(),
  session: z.string().max(200).optional(),
  branch: z.string().max(200).optional(),
  /** Human name: "GNOME Terminal", "tmux", "VS Code", "Cursor", "Codex Desktop", "Claude Desktop", "kitty"… */
  app: z.string().max(60).optional(),
  kind: z.enum(["gnome-terminal", "tmux", "vscode", "terminal", "desktop", "unknown"]).optional(),
  tty: z.string().max(40).optional(),
  /** Pid of the process that owns the window (terminal emulator or desktop app). */
  pid: z.number().int().positive().optional(),
  /** X11 window id (WINDOWID), decimal or 0x hex. */
  windowId: z.string().regex(/^(0x[0-9a-fA-F]+|\d+)$/).optional(),
  /** GNOME Terminal tab: the uuid in GNOME_TERMINAL_SCREEN. */
  gnomeScreen: z.string().regex(/^[0-9a-fA-F_-]{36}$/).optional(),
  tmux: z
    .object({
      socket: z.string().max(400),
      pane: z.string().regex(/^%\d+$/),
      target: z.string().max(200).optional(),
    })
    .optional(),
  /** Short session title or the last thing the user asked (trimmed). */
  title: z.string().max(160).optional(),
});

export type Origin = z.infer<typeof originSchema>;

export interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  cmdline: string;
}

export interface OriginDeps {
  env: NodeJS.ProcessEnv;
  pid: number;
  cwd: string;
  /** Read one process; null when it's gone or unreadable. */
  proc(pid: number): ProcInfo | null;
  /** tty of a process (e.g. "pts/3") or null. */
  tty(pid: number): string | null;
  /** Environment of another process (tmux client), or null. */
  environ(pid: number): Record<string, string> | null;
  /** Run a short command, return stdout or null. */
  run(cmd: string, args: string[]): string | null;
  branch(cwd: string): string | null;
}

export function readProc(pid: number): ProcInfo | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    let cmdline = "";
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    } catch {}
    return { pid, ppid, comm, cmdline };
  } catch {
    return null;
  }
}

function readTty(pid: number): string | null {
  for (const fd of [0, 1, 2]) {
    try {
      const link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (/^\/dev\/(pts\/\d+|tty\w*)$/.test(link)) return link.slice(5);
    } catch {}
  }
  return null;
}

function readEnviron(pid: number): Record<string, string> | null {
  try {
    const out: Record<string, string> = {};
    for (const entry of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return null;
  }
}

/** Current git branch for a folder, read from .git/HEAD without spawning git. */
export function gitBranch(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotgit = path.join(dir, ".git");
    try {
      let gitDir = dotgit;
      const st = fs.statSync(dotgit);
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
        if (!m) return null;
        gitDir = path.resolve(dir, m[1]!.trim());
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1]! : head.slice(0, 8);
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export function defaultOriginDeps(): OriginDeps {
  return {
    env: process.env,
    pid: process.pid,
    cwd: process.cwd(),
    proc: readProc,
    tty: readTty,
    environ: readEnviron,
    run(cmd, args) {
      try {
        return execFileSync(cmd, args, { encoding: "utf8", timeout: 1_500, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        return null;
      }
    },
    branch: gitBranch,
  };
}

interface AppMatch {
  app: string;
  kind: Origin["kind"];
}

/** Recognize a terminal emulator, editor or desktop app from one ancestor. */
export function classifyProcess(p: Pick<ProcInfo, "comm" | "cmdline">): AppMatch | null {
  const comm = p.comm.toLowerCase();
  const cmd = p.cmdline.toLowerCase();
  const exe = cmd.split(" ")[0] ?? "";
  if (comm.startsWith("gnome-terminal") || exe.endsWith("/gnome-terminal-server")) return { app: "GNOME Terminal", kind: "gnome-terminal" };
  if (exe.includes("/chatgpt/") || comm === "chatgpt") return { app: "Codex Desktop", kind: "desktop" };
  if (comm.startsWith("claude-desktop") || exe.includes("/claude-desktop/") || exe.includes("claude.app/")) return { app: "Claude Desktop", kind: "desktop" };
  if (/(^|\/)cursor($|\s)/.test(exe) || exe.includes("/cursor/") || comm === "cursor") return { app: "Cursor", kind: "vscode" };
  if (/(^|\/)(code|code-insiders|codium|vscodium)$/.test(exe) || exe.includes("/visual studio code") || exe.includes("/vscode/") || comm === "code") return { app: "VS Code", kind: "vscode" };
  const terms: Array<[RegExp, string]> = [
    [/^(kitty)$/, "kitty"],
    [/^(alacritty)$/, "Alacritty"],
    [/^(wezterm|wezterm-gui)$/, "WezTerm"],
    [/^(konsole)$/, "Konsole"],
    [/^(tilix)$/, "Tilix"],
    [/^(ptyxis|ptyxis-agent)$/, "Ptyxis"],
    [/^(ghostty)$/, "Ghostty"],
    [/^(terminator)$/, "Terminator"],
    [/^(xterm|uxterm)$/, "xterm"],
    [/^(foot|footclient)$/, "foot"],
    [/^(xfce4-terminal)$/, "Xfce Terminal"],
    [/^(warp|warp-terminal)$/, "Warp"],
    [/^(terminal|iterm2)$/, comm === "iterm2" ? "iTerm2" : "Terminal"],
  ];
  for (const [re, name] of terms) if (re.test(comm)) return { app: name, kind: "terminal" };
  return null;
}

function clipText(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/**
 * Capture the origin of the current process. Cheap (reads /proc, at most one
 * tmux query) and never throws.
 */
export function captureOrigin(opts: { cwd?: string; title?: string } = {}, deps: OriginDeps = defaultOriginDeps()): Origin {
  const origin: Origin = {};
  try {
    const env = deps.env;
    const cwd = opts.cwd || deps.cwd;
    if (cwd) {
      origin.cwd = cwd.slice(0, 1_000);
      origin.project = projectLabel(cwd, undefined, env).slice(0, 120);
      const branch = deps.branch(cwd);
      if (branch) origin.branch = branch.slice(0, 200);
    }
    if (opts.title?.trim()) origin.title = clipText(opts.title, 160);

    // Walk up the process tree to the window owner.
    let match: AppMatch | null = null;
    let ownerPid: number | undefined;
    let tty: string | null = null;
    let pid = deps.pid;
    for (let i = 0; i < 24 && pid > 1; i++) {
      const p = deps.proc(pid);
      if (!p) break;
      if (!tty && i > 0) tty = deps.tty(pid);
      const m = classifyProcess(p);
      if (m) {
        match = m;
        ownerPid = p.pid;
        // Desktop apps run helpers (app-server, renderer): climb to the topmost
        // process of the same app, which owns the window.
        let up = deps.proc(p.ppid);
        for (let j = 0; j < 8 && up && up.pid > 1 && classifyProcess(up)?.app === m.app; j++) {
          ownerPid = up.pid;
          up = deps.proc(up.ppid);
        }
        break;
      }
      if (p.comm === "tmux: server" || p.comm.startsWith("tmux")) break; // the client side is found via TMUX below
      pid = p.ppid;
    }
    if (!tty) tty = deps.tty(deps.pid);
    if (tty) origin.tty = tty;

    let gnomeScreen = env.GNOME_TERMINAL_SCREEN;
    let windowId = env.WINDOWID;

    // tmux: remember the pane, then find the terminal that shows its client.
    const tmuxEnv = env.TMUX;
    const pane = env.TMUX_PANE;
    if (tmuxEnv && pane && /^%\d+$/.test(pane)) {
      const socket = tmuxEnv.split(",")[0]!;
      const target = deps.run("tmux", ["-S", socket, "display-message", "-p", "-t", pane, "#{session_name}:#{window_index}.#{pane_index}"]);
      origin.tmux = { socket: socket.slice(0, 400), pane, ...(target ? { target: target.slice(0, 200) } : {}) };
      const clients = deps.run("tmux", ["-S", socket, "list-clients", "-t", (target ?? "").split(":")[0] || pane, "-F", "#{client_pid}"]);
      const clientPid = Number((clients ?? "").split("\n")[0]);
      if (Number.isInteger(clientPid) && clientPid > 1) {
        const cenv = deps.environ(clientPid);
        if (cenv?.GNOME_TERMINAL_SCREEN) gnomeScreen = cenv.GNOME_TERMINAL_SCREEN;
        if (cenv?.WINDOWID) windowId = cenv.WINDOWID;
        let cp = clientPid;
        for (let i = 0; i < 16 && cp > 1; i++) {
          const p = deps.proc(cp);
          if (!p) break;
          const m = classifyProcess(p);
          if (m) {
            match = m;
            ownerPid = p.pid;
            break;
          }
          cp = p.ppid;
        }
      }
      if (!match) match = { app: "tmux", kind: "tmux" };
    }

    if (!match) {
      const tp = (env.TERM_PROGRAM ?? "").toLowerCase();
      if (tp === "vscode") match = { app: /cursor/i.test(env.VSCODE_GIT_ASKPASS_NODE ?? env.VSCODE_IPC_HOOK_CLI ?? "") ? "Cursor" : "VS Code", kind: "vscode" };
      else if (tp === "apple_terminal") match = { app: "Terminal", kind: "terminal" };
      else if (tp === "iterm.app") match = { app: "iTerm2", kind: "terminal" };
      else if (tp === "wezterm") match = { app: "WezTerm", kind: "terminal" };
      else if (env.KITTY_WINDOW_ID) match = { app: "kitty", kind: "terminal" };
    }

    if (gnomeScreen) {
      const uuid = gnomeScreen.split("/").pop()!.replace(/_/g, "-");
      if (/^[0-9a-fA-F-]{36}$/.test(uuid)) origin.gnomeScreen = uuid;
      if (!match) match = { app: "GNOME Terminal", kind: "gnome-terminal" };
    }
    if (windowId && /^(0x[0-9a-fA-F]+|\d+)$/.test(windowId)) origin.windowId = windowId;
    if (match) {
      origin.app = match.app;
      origin.kind = origin.tmux ? "tmux" : match.kind;
      if (origin.tmux && match.app !== "tmux") origin.app = `tmux · ${match.app}`;
    } else {
      origin.kind = "unknown";
    }
    if (ownerPid) origin.pid = ownerPid;
  } catch {
    // best effort
  }
  return origin;
}

/** One-line summary for the panel, e.g. "glint ⎇ main · GNOME Terminal · pts/3". */
export function originLine(origin: Origin | undefined): string {
  if (!origin) return "";
  const parts: string[] = [];
  if (origin.cwd) parts.push(`${origin.project || path.basename(origin.cwd) || origin.cwd}${origin.branch ? ` ⎇ ${origin.branch}` : ""}`);
  if (origin.app) parts.push(origin.tmux?.target ? `${origin.app} ${origin.tmux.target}` : origin.app);
  if (origin.tty && origin.kind !== "desktop") parts.push(origin.tty);
  return parts.join(" · ");
}

/** Shell-quoted `cd` for the fallback when the window can't be focused. */
export function cdCommand(cwd: string): string {
  return `cd '${cwd.replace(/'/g, `'\\''`)}'`;
}
