// Glint plugin for OpenCode 2.x (V2 plugin API: default export {id, setup}).
//
// Just before a top-level session goes idle, OpenCode runs the
// "experimental.idle" hook. Glint opens a holocall with the agent's last
// message there; if you answer, the answer is admitted into the same
// execution as a synthetic message, so the agent keeps going without you
// touching the terminal. Dismiss, a timeout, or a short stop ("that's all",
// "dur") lets the session rest.
//
// When the agent uses OpenCode's own `question` tool, Glint rings it first;
// your answer becomes the tool result. Dismiss it and the usual question form
// appears in the terminal.
//
// `glint install opencode --write` fills in the two paths below and lists this
// file under "plugin" in opencode.json(c). GLINT_NODE / GLINT_CLI override them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLINT_NODE = process.env.GLINT_NODE || "__GLINT_NODE__";
const GLINT_CLI = process.env.GLINT_CLI || "__GLINT_CLI__";

function runHook(event, payload, signal) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(GLINT_NODE, [GLINT_CLI, "hook", "opencode", event], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    } catch {
      resolve(null);
      return;
    }
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(null));
    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener("abort", () => child.kill(), { once: true });
    }
    child.on("close", () => {
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const isGlintAsk = (call) => /glint/i.test(String(call || "")) && /ask_user/i.test(String(call || ""));

// Standalone installed plugin: same executable/flag rules as src/suppress.ts.
const baseName = (token) => String(token || "").split(/[\\/]/).pop() || "";

export function isHeadlessProcess(entry) {
  const argv = entry.argv;
  const first = baseName(argv[0] ?? "").toLowerCase();
  const runtime = /^(node|nodejs|bun|python[0-9.]*)$/.test(first);
  const index = runtime ? 1 : 0;
  const executable = baseName(argv[index] ?? "").toLowerCase().replace(/\.(?:js|mjs|cjs)$/, "");
  const flags = {
    claude: ["-p", "--print"], agy: ["-p", "--print"], gemini: ["-p", "--prompt"],
  };
  const command = executable === "codex" ? "exec" : executable === "opencode" ? "run" : undefined;
  if (!command && !flags[executable]) return false;
  const valued = new Set([
    "-c", "--config", "-C", "--cd", "--cwd", "-m", "--model", "--profile", "--provider",
    "--session", "--session-id", "--resume", "--permission-mode", "--output-format", "--input-format",
    "--system-prompt", "--append-system-prompt", "--settings", "--allowedTools", "--disallowedTools",
    "--sandbox", "--ask-for-approval", "-a", "--add-dir", "--directory", "--agent", "--log-level",
  ]);
  const switches = new Set([
    "--json", "--verbose", "--debug", "--full-auto", "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-skip-permissions", "--yolo", "--continue", "--skip-git-repo-check",
  ]);
  for (let i = index + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return false;
    if (command && arg === command) return true;
    const flag = arg.split("=", 1)[0];
    if (flags[executable]?.includes(flag)) return true;
    if (valued.has(flag)) {
      if (!arg.includes("=")) i++;
      continue;
    }
    if (switches.has(arg)) continue;
    return false;
  }
  return false;
}

function readProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    let argv = [];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch {}
    return { comm, ppid, argv };
  } catch { return null; }
}

export function deliveryMode({ env = process.env, ppid = process.pid, proc = readProcess } = {}) {
  if (env.GLINT_SUPPRESS === "1" || String(env.AGENTOS_TRANSPORT || "").trim().toLowerCase() === "takopi") return "off";
  let headless = false;
  let pid = ppid;
  // Include this process: OpenCode itself can be `opencode run`.
  for (let i = 0; i < 24 && pid > 1; i++) {
    const entry = proc(pid);
    if (!entry) break;
    const { argv, comm } = entry;
    const base = (value) => baseName(value).toLowerCase();
    if (base(comm) === "takopi" || argv.slice(0, 2).some((arg) => base(arg) === "takopi") ||
        ((argv[1] === "-m" || argv[1] === "run") && base(argv[2]) === "takopi")) return "off";
    // OpenMausBot shows its bots' replies itself (same rule as src/suppress.ts).
    if ([comm, argv[0]].some((v) => ["openmausbot", "openmausbot.appimage"].includes(base(v || "")))) return "off";
    headless ||= isHeadlessProcess(entry);
    pid = entry.ppid;
  }
  if (["ring", "notify", "off"].includes(env.GLINT_MODE)) return env.GLINT_MODE;
  return headless ? "off" : "ring";
}

// Compatibility export for callers checking whether this plugin stays inert.
export const fromTakopi = (env = process.env) => deliveryMode({ env }) === "off";

// OpenCode may set the plugin up more than once in one process (e.g. global +
// project scope); only one copy may ring for a given session or form.
const local = (globalThis.__glintInflight ??= new Set());
// ...sometimes in two processes, so the claim is also a lock file.
const lockFile = (key) => path.join(os.tmpdir(), `glint-opencode-${key.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
const inflight = {
  /** Atomically claim `key`; false if another copy (this process or another) holds it. */
  claim(key) {
    if (local.has(key)) return false;
    const file = lockFile(key);
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < 20 * 60_000) return false; // held
        fs.writeFileSync(file, String(process.pid)); // stale lock left by a crash
      } catch {
        return false;
      }
    }
    local.add(key);
    return true;
  },
  release(key) {
    local.delete(key);
    try {
      if (fs.readFileSync(lockFile(key), "utf8") === String(process.pid)) fs.rmSync(lockFile(key));
    } catch {}
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "glint",
  async setup(ctx) {
    const lastText = new Map(); // sessionID -> last assistant text this turn
    const lastTool = new Map(); // sessionID -> name of the last tool started this turn
    const chains = new Map(); // sessionID -> Glint continuations in a row
    const toolNames = new Map(); // tool call id -> tool name
    const stop = new AbortController();
    // OpenCode's own `question` tool: ring it in Glint first; if you answer
    // there, that is the tool's result. Dismiss/timeout falls back to the
    // normal question form in the terminal.
    async function ringQuestion(sessionID, input, signal) {
      if (deliveryMode() !== "ring" || process.env.GLINT_HOOK === "0" || process.env.GLINT_ASK_TOOLS === "0") return null;
      const questions = Array.isArray(input?.questions) ? input.questions : [];
      if (questions.length === 0) return null;
      const out = await runHook(
        "PreToolUse",
        {
          sessionID,
          cwd: ctx.location?.directory,
          tool_name: "question",
          tool_input: {
            questions: questions.map((q) => ({
              question: q.question || q.header || "",
              header: q.header || "",
              options: (q.options || []).map((o) => ({ label: o.label })),
              multiple: q.multiple === true,
            })),
          },
        },
        signal,
      );
      if (!out || out.action !== "answer" || !Array.isArray(out.answers)) return null;
      return questions.map((q, i) => {
        const value = String(out.answers[i] ?? "").trim();
        if (!value) return [];
        return q.multiple === true ? value.split(",").map((v) => v.trim()).filter(Boolean) : [value];
      });
    }

    try {
      await ctx.tool.transform((tools) => {
        if (!tools.get("question")) return;
        tools.update("question", (tool) => {
          const original = tool.execute;
          tool.execute = async (input, toolCtx) => {
            if (deliveryMode() !== "ring") return original(input, toolCtx);
            const key = `question:${toolCtx?.sessionID}:${toolCtx?.id ?? toolCtx?.callID ?? JSON.stringify(input).length}`;
            // Another copy of this plugin is already ringing (or fell back): just run the tool.
            if (!inflight.claim(key)) return original(input, toolCtx);
            try {
              let answers = null;
              try {
                answers = await ringQuestion(toolCtx?.sessionID, input, toolCtx?.signal);
              } catch {}
              if (!answers) return await original(input, toolCtx);
              const content = `User has answered your questions (through Glint): ${input.questions
                .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
                .join(", ")}. You can now continue with the user's answers in mind.`;
              return { output: { answers }, content, metadata: { answers } };
            } finally {
              inflight.release(key);
            }
          };
        });
      });
    } catch {}

    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.execution.started", "session.text.ended", "session.tool.input.started", "session.tool.called"],
        signal: stop.signal,
      })) {
        const data = event?.data || {};
        const id = data.sessionID;
        if (!id) continue;
        if (event.type === "session.execution.started") {
          // A new prompt from you: fresh turn, fresh loop guard.
          lastText.delete(id);
          lastTool.delete(id);
          chains.set(id, 0);
        } else if (event.type === "session.text.ended" && typeof data.text === "string" && data.text.trim()) {
          lastText.set(id, data.text);
        } else if (event.type === "session.tool.input.started") {
          toolNames.set(data.id, data.name);
          lastTool.set(id, String(data.name || ""));
        } else if (event.type === "session.tool.called") {
          // Code-mode wrappers (e.g. "execute") call glint.ask_user from inside
          // their input, so look at the input too.
          let input = "";
          try {
            input = JSON.stringify(data.input ?? "");
          } catch {}
          lastTool.set(id, `${toolNames.get(data.id) || ""} ${input}`.slice(0, 4000));
        }
      }
    })().catch(() => {});

    await ctx.session.hook("experimental.idle", async (idle) => {
      if (deliveryMode() === "off" || process.env.GLINT_HOOK === "0") return;
      const sessionID = idle?.sessionID;
      if (!sessionID) return;
      if (Array.isArray(idle.background) && idle.background.some((job) => job.sessionID === sessionID)) return; // it will wake again
      let sessionTitle = "";
      try {
        const info = await ctx.session.get({ sessionID });
        const session = info?.data ?? info;
        if (session?.parentID) return; // subagents report to their parent, not to you
        if (typeof session?.title === "string") sessionTitle = session.title;
      } catch {}
      if (!inflight.claim(`idle:${sessionID}`)) return;
      // The idle hook can run before the last session.text.ended event reaches us.
      for (let i = 0; i < 20 && !lastText.get(sessionID); i++) await sleep(100);
      let out;
      try {
        out = await runHook("session.idle", {
          sessionID,
          cwd: ctx.location?.directory,
          last_assistant_message: lastText.get(sessionID) || "",
          session_title: sessionTitle,
          glint_consulted: isGlintAsk(lastTool.get(sessionID)),
          chain: chains.get(sessionID) ?? 0,
        });
      } finally {
        inflight.release(`idle:${sessionID}`);
      }
      if (out && out.action === "continue" && typeof out.prompt === "string" && out.prompt) {
        chains.set(sessionID, (chains.get(sessionID) ?? 0) + 1);
        lastText.delete(sessionID);
        lastTool.delete(sessionID);
        try {
          await ctx.session.synthetic({ sessionID, text: out.prompt, description: "Reply through Glint" });
        } catch {
          await ctx.session.prompt({ sessionID, text: out.prompt }).catch(() => {});
        }
      } else {
        chains.set(sessionID, 0);
      }
    });

    return () => stop.abort();
  },
};
