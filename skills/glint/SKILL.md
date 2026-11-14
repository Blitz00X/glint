---
name: glint
description: Reach the user through the Glint holocall overlay instead of silently waiting in the terminal. Use whenever you finish a task, get blocked on a decision, need approval, or want to post a progress update while the user is not looking at this terminal.
---

# Glint

Glint is a translucent overlay on the user's desktop. When you call it, a
"holocall" panel rings with your name, project, and a short session tag; the
user answers with 1–9, Enter, or free text, and the answer comes straight back
to you as the tool result. Every call and notice also lands in one shared
group-chat feed, so the user can see what all their agents said.

The user runs many agents in the background. **If you stop without calling
Glint, nobody notices you are waiting.**

## When to call

| Situation | Tool | Example |
|---|---|---|
| You finished the task | `ask_user` | "Done: 14 tests pass, PR branch pushed. What next?" choices: `Open the PR`, `Write docs`, `Stop here` |
| You are blocked on a decision | `ask_user` | "Migration needs a NOT NULL column. How?" choices: `Backfill then constrain`, `Default value`, `Skip` |
| You need approval for something risky | `ask_user` | "About to delete 3 stale branches. OK?" choices: `Yes`, `No` |
| Progress the user might like to see | `notify` | "Halfway: API done, starting the UI." |

## How to call

`ask_user` arguments:

- `question` (required): first a one-line summary of where you are, then the question. Keep it under ~400 characters.
- `choices` (optional, ≤ 9): short labels, best 2–4. The user can still type a free answer.
- `agent`: your product name — "Claude Code", "Codex", "OpenCode", "Antigravity", "Cursor".
- `project`: repo or folder name.
- `timeout_ms` (optional): omit to wait until the user answers.

`notify` arguments: `message`, `agent`, `project`. Returns immediately.

Tool names differ by harness: `ask_user`, `glint_ask_user` (OpenCode), `mcp__glint__ask_user` (Claude Code).

## After the call

- `answered`: treat `answer` as the user's next message and keep working. Don't ask the same thing again.
- `dismissed` or `timeout`: stop, leave a short summary in your final message, and end your turn. Never call Glint in a loop.

## Safety net

Glint also installs lifecycle hooks (`glint install <harness>`) that ring the
user when you stop even if you forget to call. Calling `ask_user` yourself is
still better: you can write a clear question and choices instead of the hook
forwarding your last message.

## Short rule for AGENTS.md / CLAUDE.md

See `RULE.md` next to this file; `glint install <harness> --write` appends it
for you.
