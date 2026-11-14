import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import path from "node:path";
import { createDaemon, type DaemonHandle } from "../daemon.js";
import { CONCEPTS } from "../concepts.js";
import { resolveStartLayout, writeConfig } from "../config.js";
import { createDnd, type DndController } from "../dnd.js";
import { glintHome, packageRoot, statePath } from "../paths.js";
import { parseLayout, type AskResult, type OverlayLayout, type SettleInput } from "../protocol.js";

// Transparent child windows on Linux composite reliably with these switches,
// and they have to be set before the app is ready.
if (process.platform === "linux") {
  if (!process.env.GLINT_OZONE_PLATFORM) {
    app.commandLine.appendSwitch("ozone-platform", "x11");
  }
  app.commandLine.appendSwitch("enable-transparent-visuals");
  if (process.env.GLINT_GPU !== "1") app.disableHardwareAcceleration();
}
if (process.argv.includes("--no-sandbox") || process.env.GLINT_NO_SANDBOX === "1") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-setuid-sandbox");
}

const WINDOW_WIDTH = 476;
const BADGE_SIZE = 84;
const HOTKEY = process.env.GLINT_HOTKEY?.trim() || "CommandOrControl+Shift+G";
const FEED_HOTKEY = process.env.GLINT_FEED_HOTKEY?.trim() || "CommandOrControl+Shift+F";
const FEED_WIDTH = 520;
// GNOME/Ubuntu notification banners drop from the top bar and can be ~150px
// tall; start panels below that zone. GLINT_TOP_OFFSET overrides (pixels).
const TOP_OFFSET = Number.isFinite(Number(process.env.GLINT_TOP_OFFSET)) && process.env.GLINT_TOP_OFFSET?.trim()
  ? Number(process.env.GLINT_TOP_OFFSET)
  : process.platform === "linux" ? 168 : 16;
const MUTED = process.env.GLINT_MUTE === "1";
const PICKER_HOTKEY = process.env.GLINT_PICKER_HOTKEY?.trim() || "CommandOrControl+Shift+L";
// Start layout: explicit GLINT_LAYOUT > picker choice in ~/.glint/config.json > deneme1.
const START = resolveStartLayout();
const INITIAL_LAYOUT: OverlayLayout = START.layout;
const BUBBLE_WIDTH = 420;
const TICKER_MAX_HEIGHT = 340;
const EDGE_WIDTH = 400;
const ISLAND_WIDTH = 640;

let win: BrowserWindow | null = null;
let daemon: DaemonHandle | null = null;
let dnd: DndController | null = null;
const pendingIpc: Array<{ channel: string; payload: unknown }> = [];
let rendererReady = false;
let activeLayout: OverlayLayout = INITIAL_LAYOUT;
let displayLayout: OverlayLayout = INITIAL_LAYOUT;
let displayCollapsed = false;
let displayMode: "calls" | "feed" = "calls";
let pickerWin: BrowserWindow | null = null;
let bubbleAnchor: { x: number; y: number } | null = null;
const previewIds = new Set<string>();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusLatest();
  });
  app.whenReady().then(() => {
    void start().catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      app.exit(1);
    });
  });
}

async function start(): Promise<void> {
  if (process.platform === "darwin") app.dock?.hide();
  createWindow();
  dnd = createDnd({ home: glintHome(), log: (line) => console.error(line) });
  daemon = await createDaemon({
    onPendingChange: (count) => dnd?.sync(count),
    stateFile: statePath(),
    initialLayout: INITIAL_LAYOUT,
    log: (line) => console.error(line),
    sink: {
      question: (question) => emit("question", question),
      notice: (notice) => emit("notice", notice),
      resolved: (id, result) => emit("resolved", { id, result }),
      event: (event) => emit("event", event),
      layoutChanged: (layout) => {
        activeLayout = layout;
        displayLayout = layout;
        bubbleAnchor = null;
        emit("layout", layout);
        try {
          writeConfig({ layout });
        } catch (error) {
          console.error(`could not save layout: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (pickerWin && !pickerWin.isDestroyed()) pickerWin.webContents.send("picker:layout", layout);
      },
      openPicker: () => {
        openPicker();
      },
    },
  });
  const registered = globalShortcut.register(HOTKEY, () => focusLatest());
  if (!registered) console.error(`Could not register hotkey ${HOTKEY}`);
  const feedRegistered = globalShortcut.register(FEED_HOTKEY, () => toggleFeed());
  if (!feedRegistered) console.error(`Could not register feed hotkey ${FEED_HOTKEY}`);
  const pickerRegistered = globalShortcut.register(PICKER_HOTKEY, () => openPicker());
  if (!pickerRegistered) console.error(`Could not register picker hotkey ${PICKER_HOTKEY}`);
  registerPickerIpc();
  if (process.env.GLINT_OPEN_PICKER === "1") openPicker();
  console.error(`glint overlay ready on 127.0.0.1:${daemon.port}  hotkey ${hotkeyLabel(HOTKEY)}`);
}

function createWindow(): void {
  const root = packageRoot();
  win = new BrowserWindow({
    ...place(80, displayLayout),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    title: "Glint",
    webPreferences: {
      preload: path.join(root, "src/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  void win.loadFile(path.join(root, "overlay/index.html"));

  ipcMain.on("renderer-ready", () => {
    rendererReady = true;
    win?.webContents.send("config", {
      hotkeyLabel: hotkeyLabel(HOTKEY),
      feedHotkeyLabel: hotkeyLabel(FEED_HOTKEY),
      layout: daemon?.layout() ?? activeLayout,
      mute: MUTED,
      openFeed: process.env.GLINT_OPEN_FEED === "1",
    });
    win?.webContents.send("history", daemon?.events() ?? []);
    for (const message of pendingIpc) win?.webContents.send(message.channel, message.payload);
    pendingIpc.length = 0;
    for (const question of daemon?.pending() ?? []) {
      win?.webContents.send("question", question);
    }
  });

  ipcMain.on("resize", (_event, height: unknown, layoutArg: unknown, collapsedArg: unknown, modeArg: unknown) => {
    displayMode = modeArg === "feed" ? "feed" : "calls";
    if (!win || win.isDestroyed()) return;
    const requested = typeof height === "number" && Number.isFinite(height) ? height : 0;
    if (typeof layoutArg === "string") {
      const parsed = parseLayout(layoutArg);
      if (parsed) displayLayout = parsed;
    }
    displayCollapsed = collapsedArg === true;
    if (requested <= 0) {
      if (win.isFocused()) win.blur();
      win.hide();
      bubbleAnchor = null;
      return;
    }
    const next = place(requested, displayLayout, displayCollapsed);
    const wasVisible = win.isVisible();
    applyBounds(next);
    win.setAlwaysOnTop(true, "screen-saver");
    if (!wasVisible) {
      win.showInactive();
      win.moveTop();
    }
  });

  ipcMain.handle("answer", (_event, body: SettleInput) => {
    if (!daemon) return { ok: false, error: "daemon is not ready" };
    return daemon.settle(body);
  });

  ipcMain.on("focus-window", () => {
    if (!win || win.isDestroyed()) return;
    win.setFocusable(true);
    win.focus();
  });

  screen.on("display-metrics-changed", () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const bounds = win.getBounds();
    applyBounds(place(bounds.height, displayLayout, displayCollapsed));
  });
}

function applyBounds(next: { x: number; y: number; width: number; height: number }): void {
  if (!win || win.isDestroyed()) return;
  const current = win.getBounds();
  const unchanged =
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    Math.abs(current.height - next.height) < 2;
  if (unchanged) return;
  win.setResizable(true);
  win.setBounds(next);
  win.setResizable(false);
}

function emit(channel: string, payload: unknown): void {
  if (!rendererReady || !win || win.isDestroyed()) {
    // Questions are replayed from the daemon's pending list on ready.
    // Feed events are replayed from the daemon's history on ready.
    if (channel !== "question" && channel !== "event") pendingIpc.push({ channel, payload });
    return;
  }
  win.webContents.send(channel, payload);
  if ((channel === "question" || channel === "notice") && win.isVisible()) {
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
  }
}

function toggleFeed(): void {
  if (!win || win.isDestroyed() || !rendererReady) return;
  win.webContents.send("toggle-feed");
}

function focusLatest(): void {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.setFocusable(true);
  win.show();
  win.focus();
  win.webContents.send("focus-latest");
}

function place(
  requestedHeight: number,
  layout: OverlayLayout = displayLayout,
  collapsed = displayCollapsed,
): { x: number; y: number; width: number; height: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  if (displayMode === "feed" && layout !== "deneme2") {
    const height = Math.max(1, Math.min(Math.ceil(requestedHeight), Math.max(120, area.height - TOP_OFFSET - 16)));
    const x = layout === "deneme3" ? area.x + 16 : area.x + area.width - FEED_WIDTH - 16;
    return { x: Math.round(x), y: Math.round(area.y + TOP_OFFSET), width: FEED_WIDTH, height };
  }
  if (layout === "ticker") {
    const height = Math.max(1, Math.min(Math.ceil(requestedHeight), TICKER_MAX_HEIGHT, area.height - 16));
    return {
      x: Math.round(area.x + 12),
      y: Math.round(area.y + area.height - height - 8),
      width: Math.round(area.width - 24),
      height,
    };
  }
  if (layout === "edge") {
    const y = area.y + Math.min(TOP_OFFSET, Math.round(area.height / 4));
    return {
      x: Math.round(area.x + area.width - EDGE_WIDTH),
      y: Math.round(y),
      width: EDGE_WIDTH,
      height: Math.max(120, Math.round(area.y + area.height - y - 8)),
    };
  }
  if (layout === "island") {
    const height = Math.max(1, Math.min(Math.ceil(requestedHeight), Math.max(80, area.height - 40)));
    const width = Math.min(ISLAND_WIDTH, area.width - 32);
    return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + 10), width, height };
  }
  if (layout === "bubble") {
    if (!bubbleAnchor) bubbleAnchor = screen.getCursorScreenPoint();
    return bubbleBounds(bubbleAnchor, requestedHeight, screen.getDisplayNearestPoint(bubbleAnchor).workArea);
  }
  if (layout === "deneme2") {
    const bounds = display.bounds;
    const width = Math.round(bounds.width * 0.8);
    const height = Math.round(bounds.height * 0.8);
    const x = Math.round(bounds.x + (bounds.width - width) / 2);
    const y = Math.max(area.y, Math.round(bounds.y + (bounds.height - height) / 2));
    return { x, y, width, height };
  }
  if (layout === "deneme3") {
    if (collapsed) {
      return {
        x: Math.round(area.x + 16),
        y: Math.round(area.y + TOP_OFFSET),
        width: BADGE_SIZE,
        height: BADGE_SIZE,
      };
    }
    const height = Math.max(1, Math.min(Math.ceil(requestedHeight), Math.max(80, area.height - TOP_OFFSET - 16)));
    return {
      x: Math.round(area.x + 16),
      y: Math.round(area.y + TOP_OFFSET),
      width: WINDOW_WIDTH,
      height,
    };
  }
  const height = Math.max(1, Math.min(Math.ceil(requestedHeight), Math.max(80, area.height - TOP_OFFSET - 16)));
  return {
    x: Math.round(area.x + area.width - WINDOW_WIDTH - 16),
    y: Math.round(area.y + TOP_OFFSET),
    width: WINDOW_WIDTH,
    height,
  };
}

function bubbleBounds(
  anchor: { x: number; y: number },
  requestedHeight: number,
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(BUBBLE_WIDTH, area.width - 16);
  const height = Math.max(1, Math.min(Math.ceil(requestedHeight), area.height - 16));
  const x = Math.min(Math.max(area.x + 8, anchor.x - 22), area.x + area.width - width - 8);
  let y = anchor.y + 12;
  if (y + height > area.y + area.height - 8) y = Math.max(area.y + 8, anchor.y - height - 12);
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/* ------------------------------------------------------------ concept picker */

function openPicker(): void {
  if (pickerWin && !pickerWin.isDestroyed()) {
    pickerWin.show();
    pickerWin.focus();
    return;
  }
  const root = packageRoot();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1240, area.width - 40);
  const height = Math.min(860, area.height - 40);
  pickerWin = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    show: false,
    backgroundColor: "#05080e",
    title: "Glint — concepts",
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(root, "src/electron/picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  pickerWin.setMenuBarVisibility(false);
  pickerWin.once("ready-to-show", () => {
    pickerWin?.show();
    pickerWin?.focus();
  });
  pickerWin.on("closed", () => {
    pickerWin = null;
  });
  void pickerWin.loadFile(path.join(root, "overlay/picker.html"));
}

let pickerIpcRegistered = false;
function registerPickerIpc(): void {
  if (pickerIpcRegistered) return;
  pickerIpcRegistered = true;
  ipcMain.handle("picker:state", () => ({
    current: daemon?.layout() ?? activeLayout,
    startSource: START.source,
    envLayout: process.env.GLINT_LAYOUT?.trim() || null,
    hotkey: hotkeyLabel(PICKER_HOTKEY),
    concepts: CONCEPTS,
  }));
  ipcMain.handle("picker:use", (_event, raw: unknown) => {
    const layout = typeof raw === "string" ? parseLayout(raw) : undefined;
    if (!layout || !daemon) return { ok: false, error: "unknown layout" };
    return { ok: true, layout: daemon.setLayout(layout) };
  });
  ipcMain.handle("picker:preview", async (_event, raw: unknown) => {
    const layout = typeof raw === "string" ? parseLayout(raw) : undefined;
    if (!layout || !daemon) return { ok: false, error: "unknown layout" };
    return previewCall(layout);
  });
  ipcMain.on("picker:close", () => {
    pickerWin?.close();
  });
}

/** Ring a sample call in `layout` through the daemon's own HTTP API, like an agent would. */
async function previewCall(layout: OverlayLayout): Promise<{ ok: boolean; error?: string }> {
  if (!daemon) return { ok: false, error: "daemon is not ready" };
  for (const id of previewIds) daemon.settle({ id, status: "dismissed" });
  previewIds.clear();
  const concept = CONCEPTS.find((item) => item.layout === layout);
  const body = {
    question: `Preview of "${concept?.name ?? layout}". Done with the payments migration — apply it in one step, or expand and contract?`,
    choices: ["Apply it now", "Expand, then contract", "Not yet"],
    agent: "Glint preview",
    project: "concept-picker",
    session: "glint-picker-preview",
    timeoutMs: 45_000,
    layout,
  };
  const before = new Set(daemon.pending().map((question) => question.id));
  const request = fetch(`${daemon.baseUrl}/v1/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((res) => res.json() as Promise<AskResult>)
    .catch(() => null);
  for (let i = 0; i < 40; i++) {
    const fresh = daemon.pending().find((question) => !before.has(question.id));
    if (fresh) {
      previewIds.add(fresh.id);
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { ok: false, error: "preview call did not ring" };
}

function hotkeyLabel(accel: string): string {
  const mod = process.platform === "darwin" ? "cmd" : "ctrl";
  return accel
    .replaceAll("CommandOrControl", mod)
    .replaceAll("Command", "cmd")
    .replaceAll("Control", "ctrl")
    .replaceAll("Shift", "shift")
    .replaceAll("Alt", "alt")
    .replaceAll("+", "+")
    .toLowerCase();
}

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  globalShortcut.unregisterAll();
  const running = daemon;
  daemon = null;
  await running?.close();
  dnd?.restore();
}

app.on("before-quit", () => {
  void shutdown();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => app.quit());
  });
}

// Last-chance restore of notification banners if the process dies abruptly.
process.on("exit", () => {
  dnd?.restore();
});

app.on("window-all-closed", () => {
  // The overlay window lives for the whole session; closing the picker must not quit.
  if (!win || win.isDestroyed()) app.quit();
});

