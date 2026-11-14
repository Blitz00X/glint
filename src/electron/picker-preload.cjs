const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("glintPicker", {
  state() {
    return ipcRenderer.invoke("picker:state");
  },
  use(layout) {
    return ipcRenderer.invoke("picker:use", layout);
  },
  preview(layout) {
    return ipcRenderer.invoke("picker:preview", layout);
  },
  close() {
    ipcRenderer.send("picker:close");
  },
  onLayout(callback) {
    ipcRenderer.on("picker:layout", (_event, layout) => callback(layout));
  },
});
