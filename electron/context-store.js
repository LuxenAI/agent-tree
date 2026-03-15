const fs = require("fs");
const path = require("path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compactNote(value, fallback = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;

  const sentence = trimmed.split(/[.!?]/)[0]?.trim() || trimmed;
  return sentence.length > 72 ? `${sentence.slice(0, 69).trimEnd()}...` : sentence;
}

function cleanList(values = []) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function collectDescendantIds(agents, agentId) {
  const directChildren = agents
    .filter((agent) => agent.parentId === agentId)
    .map((agent) => agent.id);

  return directChildren.flatMap((childId) => [childId, ...collectDescendantIds(agents, childId)]);
}

function normalizeState(input) {
  const state = clone(input || {});
  const previousVersion = Number(state.version || 1);
  state.version = 8;
  state.contextEntries = Array.isArray(state.contextEntries) ? state.contextEntries : [];
  state.agents = Array.isArray(state.agents) ? state.agents : [];
  state.swarm = {
    objective: "",
    provider: "codex",
    treeReady: false,
    status: "idle",
    phase: "idle",
    lastError: "",
    updatedAt: new Date(0).toISOString(),
    ...(state.swarm || {}),
  };

  const agentsById = new Map();
  state.agents = state.agents.map((agent) => {
    const normalized = {
      ...agent,
      sessionActive:
        typeof agent.sessionActive === "boolean" ? agent.sessionActive : false,
      recent: Array.isArray(agent.recent) ? agent.recent : [],
      completed: Array.isArray(agent.completed) ? agent.completed : [],
      runtime:
        agent.runtime && typeof agent.runtime === "object"
          ? {
              pid:
                typeof agent.runtime.pid === "number" && Number.isFinite(agent.runtime.pid)
                  ? agent.runtime.pid
                  : null,
              mode: String(agent.runtime.mode || "").trim(),
              runId:
                typeof agent.runtime.runId === "number" && Number.isFinite(agent.runtime.runId)
                  ? agent.runtime.runId
                  : null,
              source: String(agent.runtime.source || "").trim() || "codex",
              startedAt: String(agent.runtime.startedAt || "").trim(),
            }
          : null,
    };

    if (previousVersion < 4 && normalized.id !== "master") {
      normalized.recent = normalized.recent.filter(
        (item) => item !== "Session started." && item !== "Session stopped."
      );
    }

    agentsById.set(normalized.id, normalized);
    return normalized;
  });

  const activateAncestors = (agent) => {
    let current = agent;
    while (current?.parentId) {
      const parent = agentsById.get(current.parentId);
      if (!parent) break;
      if (current.sessionActive) {
        parent.sessionActive = true;
      }
      current = parent;
    }
  };

  state.agents.forEach((agent) => activateAncestors(agent));

  const master = agentsById.get("master");
  const hasLiveChildren = state.agents.some((agent) => agent.id !== "master" && agent.sessionActive);
  const hasMasterRuntime = Boolean(master?.runtime);
  const shouldAutoRevealTree =
    state.swarm.treeReady ||
    hasLiveChildren ||
    hasMasterRuntime ||
    state.swarm.status === "running" ||
    state.swarm.status === "error";
  state.swarm.treeReady = shouldAutoRevealTree;

  if (master && !shouldAutoRevealTree && !master.runtime) {
    master.sessionActive = false;
  }
  if (master) {
    master.status = master.status || (master.sessionActive ? "live" : "queued");
  }

  return state;
}

class ContextStore {
  constructor(filePath, seedPath) {
    this.filePath = filePath;
    this.seedPath = seedPath;
    this.ensureStore();
  }

  ensureStore() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      const seed = JSON.parse(fs.readFileSync(this.seedPath, "utf8"));
      this.write(normalizeState(seed));
      return;
    }

    const state = normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    this.write(state);
  }

  read() {
    return normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  getState() {
    return clone(this.read());
  }

  resetLaunchView() {
    const state = this.read();
    const hasRuntime = state.agents.some((agent) => agent.runtime);
    const hasActiveChildren = state.agents.some(
      (agent) => agent.id !== "master" && agent.sessionActive
    );
    const swarmBusy =
      state.swarm.status === "running" || state.swarm.status === "error";

    if (hasRuntime || hasActiveChildren || swarmBusy) {
      return clone(state);
    }

    state.agents.forEach((agent) => {
      agent.sessionActive = false;
      agent.runtime = null;
      if (agent.status !== "complete") {
        agent.status = "queued";
      }
    });

    state.swarm = {
      ...state.swarm,
      treeReady: false,
      status: "idle",
      phase: "idle",
      lastError: "",
      updatedAt: new Date().toISOString(),
    };

    this.write(state);
    return clone(state);
  }

  startSwarmRun(payload) {
    const state = this.read();
    const objective = String(payload.objective || "").trim();
    const provider = String(payload.provider || state.swarm.provider || "codex").trim().toLowerCase() || "codex";
    if (!objective) {
      throw new Error("Objective is required.");
    }

    const now = new Date().toISOString();
    state.agents.forEach((agent) => {
      if (agent.id === "master") {
        agent.sessionActive = true;
        agent.status = "live";
        agent.updatedAt = now;
        agent.current = "Planning subagent tasks from the master objective.";
        agent.next = `Spawn the first wave of ${provider} subagents.`;
        agent.cardNote = compactNote(agent.current, agent.cardNote);
      } else {
        agent.sessionActive = false;
        agent.status = "queued";
        agent.runtime = null;
      }
    });

    state.swarm = {
      ...state.swarm,
      objective,
      provider,
      treeReady: true,
      status: "running",
      phase: "planning",
      lastError: "",
      updatedAt: now,
    };

    this.write(state);
    return clone(state);
  }

  setSwarmState(payload) {
    const state = this.read();
    state.swarm = {
      ...state.swarm,
      ...payload,
      updatedAt: new Date().toISOString(),
    };

    this.write(state);
    return clone(state);
  }

  stopSwarmRun() {
    const state = this.read();
    const now = new Date().toISOString();

    state.agents.forEach((agent) => {
      if (agent.id === "master") {
        agent.sessionActive = true;
        agent.status = "live";
        agent.updatedAt = now;
        agent.runtime = null;
      } else {
        agent.sessionActive = false;
        agent.status = "queued";
        agent.runtime = null;
      }
    });

    state.swarm = {
      ...state.swarm,
      status: "idle",
      phase: "idle",
      updatedAt: now,
    };

    this.write(state);
    return clone(state);
  }

  startSession(payload) {
    const state = this.read();
    const agent = state.agents.find((item) => item.id === payload.agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${payload.agentId}`);
    }

    let current = agent;
    while (current) {
      current.sessionActive = true;
      current.status = current.id === payload.agentId ? "live" : current.status || "live";
      current.updatedAt = new Date().toISOString();
      current.cardNote = compactNote(current.current, current.cardNote || "Session started.");
      current = current.parentId
        ? state.agents.find((item) => item.id === current.parentId)
        : null;
    }

    state.swarm.treeReady = true;
    agent.recent = ["Session started.", ...agent.recent].slice(0, 6);
    this.write(state);
    return clone(state);
  }

  stopSession(payload) {
    const state = this.read();
    const agent = state.agents.find((item) => item.id === payload.agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${payload.agentId}`);
    }
    if (agent.id === "master") {
      throw new Error("Master session stays active.");
    }

    const now = new Date().toISOString();
    const ids = [agent.id, ...collectDescendantIds(state.agents, agent.id)];
    ids.forEach((id) => {
      const target = state.agents.find((item) => item.id === id);
      if (!target) return;
      target.sessionActive = false;
      target.status = "queued";
      target.updatedAt = now;
      target.runtime = null;
    });

    agent.recent = ["Session stopped.", ...agent.recent].slice(0, 6);
    this.write(state);
    return clone(state);
  }

  saveSession(payload) {
    const state = this.read();
    const agent = state.agents.find((item) => item.id === payload.agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${payload.agentId}`);
    }
    if (!agent.sessionActive) {
      throw new Error("Cannot update an inactive session.");
    }

    agent.status = payload.status || agent.status;
    agent.current = payload.current?.trim() || agent.current;
    agent.next = payload.next?.trim() || agent.next;
    agent.summary = payload.summary?.trim() || agent.summary;
    agent.cardNote = payload.cardNote?.trim() || compactNote(agent.current, agent.cardNote);
    if (typeof payload.sessionActive === "boolean") {
      agent.sessionActive = payload.sessionActive;
    }
    if ("runtime" in payload) {
      agent.runtime =
        payload.runtime && typeof payload.runtime === "object"
          ? {
              pid:
                typeof payload.runtime.pid === "number" && Number.isFinite(payload.runtime.pid)
                  ? payload.runtime.pid
                  : null,
              mode: String(payload.runtime.mode || "").trim(),
              runId:
                typeof payload.runtime.runId === "number" && Number.isFinite(payload.runtime.runId)
                  ? payload.runtime.runId
                  : null,
              source: String(payload.runtime.source || "").trim() || "codex",
              startedAt: String(payload.runtime.startedAt || "").trim(),
            }
          : null;
    }
    agent.updatedAt = new Date().toISOString();

    const recentItem = payload.recentItem?.trim();
    if (recentItem) {
      agent.recent = [recentItem, ...agent.recent].slice(0, 6);
    }
    const recentItems = cleanList(payload.recentItems || []);
    if (recentItems.length > 0) {
      agent.recent = [...recentItems.reverse(), ...agent.recent].slice(0, 6);
    }

    const completedItem = payload.completedItem?.trim();
    if (completedItem) {
      agent.completed = [completedItem, ...agent.completed].slice(0, 6);
    }
    const completedItems = cleanList(payload.completedItems || []);
    if (completedItems.length > 0) {
      agent.completed = [...completedItems.reverse(), ...agent.completed].slice(0, 6);
    }

    this.write(state);
    return clone(state);
  }

  addContextEntry(payload) {
    const state = this.read();
    const agent = state.agents.find((item) => item.id === payload.agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${payload.agentId}`);
    }
    if (!agent.sessionActive) {
      throw new Error("Cannot publish context from an inactive session.");
    }

    const summary = payload.summary?.trim();
    if (!summary) {
      throw new Error("Context summary is required.");
    }

    const nextId = `ctx-${String(state.contextEntries.length + 1).padStart(3, "0")}`;
    const entry = {
      id: nextId,
      agentId: payload.agentId,
      kind: payload.kind || "finding",
      summary,
      symbols: cleanList(payload.symbols || []),
      references: cleanList(payload.references || []).filter((reference) =>
        state.contextEntries.some((existing) => existing.id === reference)
      ),
      createdAt: new Date().toISOString(),
    };

    state.contextEntries.unshift(entry);
    agent.updatedAt = entry.createdAt;
    agent.recent = [`Published ${entry.id} to shared context.`, ...agent.recent].slice(0, 6);

    this.write(state);
    return clone(state);
  }
}

module.exports = { ContextStore };
