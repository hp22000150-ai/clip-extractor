"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  submitApiKey: (key) => ipcRenderer.send("submit-api-key", key),
  cancelSetup: () => ipcRenderer.send("cancel-setup"),
  openExternal: (url) => ipcRenderer.send("open-external", url),
});
