## Glint (reach the user without the terminal)

- **End of turn (finished, blocked, or needs a decision):** write your full reply as normal output, then stop without calling `ask_user`. The Stop hook rings Glint with your complete last message verbatim. Include any question and choices in that reply; do not compose a separate tool message.
- **Only in the middle of work**, when you must wait for an answer before continuing: first write the question in your output, then call the `glint` MCP tool `ask_user` (it may appear as `glint_ask_user` or `mcp__glint__ask_user`) with the exact same text as `question`. Offer 2–4 short `choices` when helpful; the user can also type a free answer. Continue with the answer.
- **Progress / FYI** that needs no reply: `notify`.
- Set `agent` (e.g. "Claude Code", "Codex", "OpenCode", "Antigravity") and `project` (repo or folder name).
- If `ask_user` returns `dismissed` or `timeout`, write your reply and stop; do not call it again in a loop.
