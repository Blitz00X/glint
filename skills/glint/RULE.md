## Glint (reach the user without the terminal)

The user does not watch this terminal. **Never ask the user anything in plain text** (no "should I…?", no option lists in your reply). Always call the `glint` MCP tool `ask_user` instead (it may appear as `glint_ask_user` or `mcp__glint__ask_user`), with 2–4 short `choices` when you can; the user can also type a free answer. Use the answer as their next message and keep going.

- **Finished** or **blocked**: still call `ask_user`, with a one-line summary and the open issues listed, before you stop.
- **Progress / FYI** that needs no reply: `notify`.
- Set `agent` (e.g. "Claude Code", "Codex", "OpenCode", "Antigravity") and `project` (repo or folder name).
- If `ask_user` returns `dismissed` or `timeout`, stop and summarize; don't call it again in a loop.
