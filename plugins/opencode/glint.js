// Glint plugin for OpenCode (layer 2: deterministic "stopped and waiting" calls).
//
// When a top-level session goes idle, this opens a Glint holocall with the
// agent's last message. If you answer, your answer is sent back into the same
// session as the next prompt, so the agent continues without you touching the
// terminal. Dismiss, "That's all", or a timeout lets the session rest.
//
// `glint install opencode --write` fills in the two paths below. You can also
// override them with GLINT_NODE and GLINT_CLI.
import { spawn } from "node:child_process";

const GLINT_NODE = process.env.GLINT_NODE || "__GLINT_NODE__";
const GLINT_CLI = process.env.GLINT_CLI || "__GLINT_CLI__";
const PREFIX = "The user replied through Glint";
const PREFIX_KEEP = "The user picked option";

function runHook(event, payload, signal) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(GLINT_NODE, [GLINT_CLI, "hook", "opencode", event], {
        stdio: ["pipe", "pipe", "ignore"],
        env: process.env,
      });
    } catch {
      finish(null);
      return;
    }
    const abort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish(null);
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        finish(out.trim() ? JSON.parse(out) : null);
      } catch {
        finish(null);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function textOf(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export const GlintPlugin = async ({ client, directory }) => {
  const inflight = new Map(); // sessionID -> AbortController
  const chains = new Map(); // sessionID -> consecutive Glint continuations
  const ours = new Set(); // sessionIDs whose next user message is our injected answer

  // Last assistant text, and whether the agent's last tool call in this turn
  // was Glint's ask_user (then it already called you; don't ring twice).
  async function lastTurn(sessionID) {
    let text = "";
    let consulted = false;
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const list = Array.isArray(res?.data) ? res.data : [];
      let toolSeen = false;
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (item?.info?.role === "user") break; // start of this turn
        if (item?.info?.role !== "assistant") continue;
        if (!text) text = textOf(item.parts);
        const parts = item.parts || [];
        for (let j = parts.length - 1; j >= 0 && !toolSeen; j--) {
          if (parts[j]?.type === "tool") {
            toolSeen = true;
            const name = String(parts[j].tool || "");
            consulted = /glint/i.test(name) && /ask_user/i.test(name);
          }
        }
      }
    } catch {}
    return { text, consulted };
  }

  async function isChild(sessionID) {
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      return Boolean(res?.data?.parentID);
    } catch {
      return false;
    }
  }

  async function onIdle(sessionID) {
    if (process.env.GLINT_HOOK === "0" || inflight.has(sessionID)) return;
    if (await isChild(sessionID)) return; // subagents report to their parent, not to you
    const controller = new AbortController();
    inflight.set(sessionID, controller);
    try {
      const last = await lastTurn(sessionID);
      const out = await runHook(
        "session.idle",
        {
          sessionID,
          cwd: directory,
          last_assistant_message: last.text,
          glint_consulted: last.consulted,
          chain: chains.get(sessionID) ?? 0,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (out && out.action === "continue" && typeof out.prompt === "string" && out.prompt) {
        chains.set(sessionID, (chains.get(sessionID) ?? 0) + 1);
        ours.add(sessionID);
        await client.session.promptAsync({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: out.prompt }] },
        });
      } else {
        chains.set(sessionID, 0);
      }
    } catch {
      // Never break the session over a notification.
    } finally {
      if (inflight.get(sessionID) === controller) inflight.delete(sessionID);
    }
  }

  return {
    event: async ({ event }) => {
      if (event?.type === "session.idle" && event.properties?.sessionID) {
        void onIdle(event.properties.sessionID); // detached: never hold up OpenCode's event bus
      }
    },
    "chat.message": async (input, output) => {
      const id = input?.sessionID;
      if (!id) return;
      const text = textOf(output?.parts);
      if (ours.has(id) || text.startsWith(PREFIX) || text.startsWith(PREFIX_KEEP)) {
        ours.delete(id);
        return;
      }
      // You typed in the terminal: hang up any open call for this session.
      chains.set(id, 0);
      inflight.get(id)?.abort();
    },
    "permission.ask": async (input, output) => {
      if (process.env.GLINT_APPROVALS !== "1") return;
      const out = await runHook("permission.ask", {
        sessionID: input?.sessionID,
        cwd: directory,
        tool_name: input?.type || input?.permission || "permission",
        tool_input: input?.pattern ?? input?.metadata ?? input?.title ?? null,
      });
      if (out && (out.action === "allow" || out.action === "deny")) output.status = out.action;
    },
    dispose: async () => {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    },
  };
};
