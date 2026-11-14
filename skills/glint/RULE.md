## Glint (reach the user without the terminal)

The user does not watch this terminal. Whenever you would stop and wait for them, call them through Glint instead:

- **Finished**, **blocked on a decision**, or **need approval** → call the `glint` MCP tool `ask_user` (the tool may appear as `glint_ask_user` or `mcp__glint__ask_user`). Start the question with a one-line summary of where you are, then ask. Offer 2–4 short `choices` when you can; the user may also type a free answer. Use the answer as their next message and keep going.
- **Progress or FYI** that needs no reply → `notify`.
- Always set `agent` (your product name, e.g. "Claude Code", "Codex", "OpenCode", "Antigravity") and `project` (the repo or folder name).
- If `ask_user` returns `dismissed` or `timeout`, stop and summarize; do not call again in a loop.
