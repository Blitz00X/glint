// Glint plugin for OpenCode 2.x (V2 plugin API: default export {id, setup}).
//
// Just before a top-level session goes idle, OpenCode runs the
// "experimental.idle" hook. Glint opens a holocall with the agent's last
// message there; if you answer, the answer is admitted into the same
// execution as a synthetic message, so the agent keeps going without you
// touching the terminal. Dismiss, a timeout, or a short stop ("that's all",
// "dur") lets the session rest.
//
// `glint install opencode --write` fills in the two paths below and lists this
// file under "plugin" in opencode.json(c). GLINT_NODE / GLINT_CLI override them.
import { spawn } from "node:child_process";

const GLINT_NODE = process.env.GLINT_NODE || "__GLINT_NODE__";
const GLINT_CLI = process.env.GLINT_CLI || "__GLINT_CLI__";

function runHook(event, payload) {
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

export default {
  id: "glint",
  async setup(ctx) {
    const lastText = new Map(); // sessionID -> last assistant text this turn
    const lastTool = new Map(); // sessionID -> name of the last tool started this turn
    const chains = new Map(); // sessionID -> Glint continuations in a row
    const toolNames = new Map(); // tool call id -> tool name
    const stop = new AbortController();

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
      if (process.env.GLINT_HOOK === "0") return;
      const sessionID = idle?.sessionID;
      if (!sessionID) return;
      if (Array.isArray(idle.background) && idle.background.some((job) => job.sessionID === sessionID)) return; // it will wake again
      try {
        const info = await ctx.session.get({ sessionID });
        const session = info?.data ?? info;
        if (session?.parentID) return; // subagents report to their parent, not to you
      } catch {}
      const out = await runHook("session.idle", {
        sessionID,
        cwd: ctx.location?.directory,
        last_assistant_message: lastText.get(sessionID) || "",
        glint_consulted: isGlintAsk(lastTool.get(sessionID)),
        chain: chains.get(sessionID) ?? 0,
      });
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
