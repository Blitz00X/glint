const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glint", {
  ready() {
    ipcRenderer.send("renderer-ready");
  },
  onConfig(callback) {
    ipcRenderer.on("config", (_event, config) => callback(config));
  },
  onQuestion(callback) {
    ipcRenderer.on("question", (_event, question) => callback(question));
  },
  onNotice(callback) {
    ipcRenderer.on("notice", (_event, notice) => callback(notice));
  },
  onResolved(callback) {
    ipcRenderer.on("resolved", (_event, payload) => callback(payload));
  },
  onEvent(callback) {
    ipcRenderer.on("event", (_event, event) => callback(event));
  },
  onHistory(callback) {
    ipcRenderer.on("history", (_event, events) => callback(events));
  },
  onToggleFeed(callback) {
    ipcRenderer.on("toggle-feed", () => callback());
  },
  onFocusLatest(callback) {
    ipcRenderer.on("focus-latest", () => callback());
  },
  onLayout(callback) {
    ipcRenderer.on("layout", (_event, layout) => callback(layout));
  },
  answer(payload) {
    return ipcRenderer.invoke("answer", payload);
  },
  resize(height, layout, collapsed, mode) {
    ipcRenderer.send("resize", height, layout, collapsed, mode);
  },
  focusWindow() {
    ipcRenderer.send("focus-window");
  },
});
