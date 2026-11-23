---
name: glint
description: Use Glint for questions that must be answered in the middle of work and for progress updates. At the end of a turn, write the full reply and stop; the Stop hook shows it verbatim.
---

# Glint

Glint is a translucent overlay on the user's desktop. When you call it, a
"holocall" panel rings with your name, project, and a short session tag; the
user answers with 1–9, Enter, or free text, and the answer comes straight back
to you as the tool result. Every call and notice also lands in one shared
group-chat feed, so the user can see what all their agents said.

At the end of a turn (finished, blocked, or needs a decision), write your full
reply as normal output, then stop without calling `ask_user`. The Stop hook
rings Glint with your complete last message verbatim, including any question
and choices in that reply.

## When to call

Use `ask_user` only in the middle of work when you must wait for an answer
before continuing. First write the question in your output, then pass the
exact same text as `question`. Continue with the answer. Use `notify` for
progress or FYI updates that need no reply.

## How to call

`ask_user` arguments:

- `question` (required): the exact same text as the question you already wrote in your output (up to 20,000 characters).
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

Glint installs lifecycle hooks (`glint install <harness>`) that ring after your
normal reply. The call body is your complete last message; detected questions
and options only determine buttons and call kind. Built-in ask tools (Claude's
`AskUserQuestion`, Codex's `request_user_input`) can also be answered through Glint.

## Short rule for AGENTS.md / CLAUDE.md

See `RULE.md` next to this file; `glint install <harness> --write` appends it
for you.
