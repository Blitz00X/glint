# Changelog

Earlier releases are recorded in Git tags (`v0.3.0`, `v0.3.1`).

## 0.4.1 — 2026-11-15

### Added

- **`glint focus`:** asks the running daemon to focus the newest panel. This is
  the reliable focus path on GNOME Wayland, where Electron's X11 global
  shortcut does not receive keys while a native Wayland app is focused.
- Daemon `POST /v1/focus` endpoint and overlay focus sink.

### Changed

- README documents the GNOME Wayland custom shortcut.

## 0.4.0 — 2026-11-15

### Added

- **Call origin:** every MCP call and hook now carries the working folder and
  git branch, the app/terminal (GNOME Terminal, tmux, VS Code, Cursor, Codex
  Desktop, Claude Desktop, kitty…), the tty, and a short session title.
- **Jump to source:** the panel and the group feed have a “go to terminal/app”
  action (`Ctrl+Shift+J` for the active call). GNOME Terminal tabs use the
  search provider (works on Wayland), tmux selects the pane, X11/XWayland
  windows use `wmctrl`/`xdotool`, and the fallback copies a safe `cd` command.
- **Desktop install targets:** `glint install claude-desktop` writes
  `mcpServers.glint` to `claude_desktop_config.json`; `codex-desktop` reuses
  the Codex core configuration and labels its calls Codex Desktop.
- **Doctor coverage:** checks the desktop targets and the tools needed for
  jump-to-source.
- **MCP server instructions:** Claude Desktop chat gets the “ask through Glint”
  rule even though it has no lifecycle hooks or rules file.
- **Node guard:** `npm test` now fails clearly on Node older than 20, and
  `.nvmrc` pins the supported major.

### Changed

- README documents desktop apps, call origin and jump-to-source.
- `glint install`/`uninstall` accept `claude-desktop` and `codex-desktop`
  (plus aliases such as `claude-app`, `codex-app`).

### Fixed

- `v0.4.0` includes `657faf5` (executable `dist/cli.js` after build), which
  `v0.3.1` did not contain.
