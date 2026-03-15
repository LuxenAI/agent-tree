const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { ContextStore } = require("./context-store");
const { SwarmRuntime } = require("./swarm-runtime");

const isMac = process.platform === "darwin";
let contextStore;
let swarmRuntime;
let reconcileTimer;

app.setName("Agent Tree");

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1320,
    minHeight: 840,
    title: "Agent Tree",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  window.loadFile(path.join(__dirname, "..", "ui", "index.html"));
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => {
    window.show();
  });
}

function broadcastState() {
  const state = contextStore.getState();
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send("agent-tree:state-changed", state);
  });
}

app.whenReady().then(() => {
  contextStore = new ContextStore(
    path.join(app.getPath("userData"), "agent-tree-context-db.json"),
    path.join(__dirname, "..", "shared", "default-state.json")
  );
  contextStore.resetLaunchView();
  swarmRuntime = new SwarmRuntime({
    contextStore,
    workdir: path.join(__dirname, ".."),
    onStateChanged: broadcastState,
  });
  swarmRuntime.reconcileDetectedSessions();

  ipcMain.handle("agent-tree:get-state", () => contextStore.getState());
  ipcMain.handle("agent-tree:get-runtime-info", () => swarmRuntime.getRuntimeInfo());
  ipcMain.handle("agent-tree:start-swarm", (_event, payload) => {
    const state = swarmRuntime.startObjective(payload);
    broadcastState();
    return state;
  });
  ipcMain.handle("agent-tree:stop-swarm", () => {
    const state = swarmRuntime.stopObjective();
    broadcastState();
    return state;
  });

  ipcMain.handle("agent-tree:start-session", (_event, payload) => {
    const state = contextStore.startSession(payload);
    broadcastState();
    return state;
  });
  ipcMain.handle("agent-tree:stop-session", (_event, payload) => {
    const state = contextStore.stopSession(payload);
    broadcastState();
    return state;
  });
  ipcMain.handle("agent-tree:save-session", (_event, payload) => {
    const state = contextStore.saveSession(payload);
    broadcastState();
    return state;
  });
  ipcMain.handle("agent-tree:add-context-entry", (_event, payload) => {
    const state = contextStore.addContextEntry(payload);
    broadcastState();
    return state;
  });

  createWindow();
  broadcastState();
  reconcileTimer = setInterval(() => {
    swarmRuntime.reconcileDetectedSessions();
  }, 2000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (!isMac) {
    app.quit();
  }
});
