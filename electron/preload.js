const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentTreeDesktop", {
  runtime: "Electron Desktop",
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  getState: () => ipcRenderer.invoke("agent-tree:get-state"),
  getRuntimeInfo: () => ipcRenderer.invoke("agent-tree:get-runtime-info"),
  startSwarm: (payload) => ipcRenderer.invoke("agent-tree:start-swarm", payload),
  stopSwarm: () => ipcRenderer.invoke("agent-tree:stop-swarm"),
  startSession: (payload) => ipcRenderer.invoke("agent-tree:start-session", payload),
  stopSession: (payload) => ipcRenderer.invoke("agent-tree:stop-session", payload),
  saveSession: (payload) => ipcRenderer.invoke("agent-tree:save-session", payload),
  addContextEntry: (payload) => ipcRenderer.invoke("agent-tree:add-context-entry", payload),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("agent-tree:state-changed", listener);
    return () => ipcRenderer.removeListener("agent-tree:state-changed", listener);
  },
});
