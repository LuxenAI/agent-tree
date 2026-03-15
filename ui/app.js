const tiers = ["master", "lead", "worker"];
const treeWrap = document.getElementById("tree-wrap");
const treeLinks = document.getElementById("tree-links");
const treeEmpty = document.getElementById("tree-empty");
const detailEl = document.getElementById("agent-detail");
const filterBar = document.getElementById("lane-filters");
const tierContainers = {
  master: document.getElementById("tier-master"),
  lead: document.getElementById("tier-lead"),
  worker: document.getElementById("tier-worker"),
};
const tierSections = {
  master: document.querySelector('.tree-tier[data-tier="master"]'),
  lead: document.querySelector('.tree-tier[data-tier="lead"]'),
  worker: document.querySelector('.tree-tier[data-tier="worker"]'),
};

let agents = [];
let contextEntries = [];
let swarm = {
  objective: "",
  provider: "codex",
  status: "idle",
  phase: "idle",
  lastError: "",
  updatedAt: new Date(0).toISOString(),
};
let runtimeInfo = {
  defaultProvider: "codex",
  providers: [
    { id: "codex", label: "Codex", available: true },
    { id: "claude", label: "Claude", available: false },
  ],
};
let agentsById = new Map();
let activeFilter = "all";
let selectedAgentId = null;
let flashMessage = "";

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function laneLabel(lane) {
  return lane === "master"
    ? "Control"
    : lane.charAt(0).toUpperCase() + lane.slice(1);
}

function statusLabel(status) {
  if (status === "live") return "Live";
  if (status === "review") return "Review";
  if (status === "complete") return "Complete";
  if (status === "running") return "Running";
  return "Queued";
}

function swarmStatusLabel(status) {
  if (status === "running") return "Running";
  if (status === "complete") return "Complete";
  if (status === "error") return "Error";
  return "Idle";
}

function providerLabel(providerId) {
  const provider = runtimeInfo.providers.find((item) => item.id === providerId);
  if (provider?.label) return provider.label;
  return providerId === "claude" ? "Claude" : "Codex";
}

function relativeTime(timestamp) {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compactNote(value, fallback = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return fallback;

  const sentence = trimmed.split(/[.!?]/)[0]?.trim() || trimmed;
  return sentence.length > 72 ? `${sentence.slice(0, 69).trimEnd()}...` : sentence;
}

function isActiveAgent(agent) {
  return Boolean(agent?.sessionActive);
}

function getActiveAgents() {
  return agents.filter((agent) => isActiveAgent(agent));
}

function getActiveChildren(agentId) {
  return agents.filter((agent) => agent.parentId === agentId && isActiveAgent(agent));
}

function getDormantChildren(agentId) {
  return agents.filter((agent) => agent.parentId === agentId && !isActiveAgent(agent));
}

function getFallbackSelection() {
  return getActiveAgents()[0]?.id || null;
}

function hasMasterAgent() {
  return Boolean(agentsById.get("master")?.sessionActive);
}

function pathToRoot(agentId) {
  const chain = new Set();
  let current = agentsById.get(agentId);
  while (current) {
    chain.add(current.id);
    current = current.parentId ? agentsById.get(current.parentId) : null;
  }
  return chain;
}

function hydrateState(state) {
  agents = state.agents || [];
  contextEntries = state.contextEntries || [];
  swarm = {
    objective: "",
    provider: "codex",
    status: "idle",
    phase: "idle",
    lastError: "",
    updatedAt: new Date(0).toISOString(),
    ...(state.swarm || {}),
  };
  agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  const selectedAgent = agentsById.get(selectedAgentId);
  if (!selectedAgent || !isActiveAgent(selectedAgent)) {
    selectedAgentId = getFallbackSelection();
  }
}

async function loadRuntimeInfo() {
  if (!window.agentTreeDesktop?.getRuntimeInfo) {
    return;
  }

  runtimeInfo = {
    ...runtimeInfo,
    ...(await window.agentTreeDesktop.getRuntimeInfo()),
  };
}

async function loadInitialState() {
  if (window.agentTreeDesktop?.getState) {
    hydrateState(await window.agentTreeDesktop.getState());
    return;
  }

  const response = await fetch("../shared/default-state.json");
  hydrateState(await response.json());
}

function countEntriesForAgent(agentId) {
  return contextEntries.filter((entry) => entry.agentId === agentId).length;
}

function getRelevantEntries(agentId) {
  const owned = contextEntries.filter((entry) => entry.agentId === agentId);
  const ownedIds = new Set(owned.map((entry) => entry.id));
  const upstreamIds = new Set(
    owned.flatMap((entry) => entry.references || []).filter((reference) => !ownedIds.has(reference))
  );
  const upstream = contextEntries.filter((entry) => upstreamIds.has(entry.id));
  const downstream = contextEntries.filter(
    (entry) =>
      entry.agentId !== agentId &&
      !upstreamIds.has(entry.id) &&
      !ownedIds.has(entry.id) &&
      (entry.references || []).some((reference) => ownedIds.has(reference))
  );

  return [...owned.slice(0, 2), ...upstream.slice(0, 1), ...downstream.slice(0, 1)].slice(0, 4);
}

function renderTree() {
  const selectedPath = pathToRoot(selectedAgentId);
  const activeAgents = getActiveAgents();
  filterBar.classList.toggle("is-hidden", activeAgents.length < 2);

  treeEmpty.innerHTML = "";
  treeEmpty.classList.toggle("is-visible", activeAgents.length === 0);

  tiers.forEach((tier) => {
    tierContainers[tier].innerHTML = "";
    tierSections[tier].classList.toggle(
      "is-hidden",
      activeAgents.every((agent) => agent.tier !== tier)
    );
  });

  if (activeAgents.length === 0) {
    treeLinks.innerHTML = "";
    treeEmpty.innerHTML = `
      <div class="tree-empty-card">
        <p class="tree-empty-eyebrow">Start Clean</p>
        <h3 class="tree-empty-title">No agents yet</h3>
        <p class="tree-empty-copy">
          Add a master agent first. After that you can add child agents manually or let the master create them for you.
        </p>
        <button type="button" class="terminal-button primary" data-session-action="activate" data-agent-id="master">
          Add Master Agent
        </button>
      </div>
    `;
    return;
  }

  activeAgents.forEach((agent) => {
    const button = document.createElement("button");
    button.className = "agent-node";
    button.dataset.agentId = agent.id;
    button.dataset.lane = agent.lane;
    button.type = "button";

    if (selectedAgentId === agent.id) {
      button.classList.add("is-selected");
      button.setAttribute("aria-current", "true");
    }
    if (selectedPath.has(agent.id)) {
      button.classList.add("is-linked");
    }
    if (
      activeFilter !== "all" &&
      agent.lane !== activeFilter &&
      agent.lane !== "master"
    ) {
      button.classList.add("is-muted");
    }

    button.innerHTML = `
      <div class="agent-topline">
        <span class="status-pill status-${agent.status}">${statusLabel(agent.status)}</span>
        <span class="mini-pill">${relativeTime(agent.updatedAt)}</span>
      </div>
      <h3 class="agent-role">${escapeHtml(agent.name)}</h3>
      <p class="agent-subtitle">${escapeHtml(agent.role)}</p>
      <p class="agent-task">${escapeHtml(agent.cardNote)}</p>
      <div class="agent-meta">
        <span class="mini-pill">${laneLabel(agent.lane)}</span>
        <span class="mini-pill">${countEntriesForAgent(agent.id)} ctx</span>
      </div>
    `;

    button.addEventListener("click", () => {
      selectedAgentId = agent.id;
      flashMessage = "";
      renderAll();
    });

    tierContainers[agent.tier].appendChild(button);
  });

  requestAnimationFrame(drawTreeLinks);
}

function drawTreeLinks() {
  const bounds = treeWrap.getBoundingClientRect();
  treeLinks.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  treeLinks.innerHTML = "";

  const selectedPath = pathToRoot(selectedAgentId);
  getActiveAgents().forEach((agent) => {
    if (!agent.parentId) return;

    const parentEl = document.querySelector(`[data-agent-id="${agent.parentId}"]`);
    const childEl = document.querySelector(`[data-agent-id="${agent.id}"]`);
    if (!parentEl || !childEl) return;

    const parentRect = parentEl.getBoundingClientRect();
    const childRect = childEl.getBoundingClientRect();

    const startX = parentRect.left - bounds.left + parentRect.width / 2;
    const startY = parentRect.top - bounds.top + parentRect.height;
    const endX = childRect.left - bounds.left + childRect.width / 2;
    const endY = childRect.top - bounds.top;
    const deltaY = Math.max((endY - startY) * 0.52, 26);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${startX} ${startY} C ${startX} ${startY + deltaY}, ${endX} ${endY - deltaY}, ${endX} ${endY}`
    );
    path.classList.add("tree-curve");

    const isMuted =
      activeFilter !== "all" &&
      agent.lane !== activeFilter &&
      agent.lane !== "master";
    if (isMuted) {
      path.classList.add("is-muted");
    }
    if (selectedPath.has(agent.id) && selectedPath.has(agent.parentId)) {
      path.classList.add("is-active");
    }

    treeLinks.appendChild(path);
  });
}

function renderContextEntries(entries) {
  if (entries.length === 0) {
    return `<div class="terminal-empty">No shared context yet.</div>`;
  }

  return `
    <div class="context-stack">
      ${entries
        .map((entry) => {
          const owner = agentsById.get(entry.agentId);
          return `
            <article class="context-entry">
              <div class="context-meta">
                <span class="context-id">${entry.id}</span>
                <span>${entry.kind}</span>
                <span>${relativeTime(entry.createdAt)}</span>
              </div>
              <p class="context-summary">${escapeHtml(entry.summary)}</p>
              <div class="context-tags">
                <span class="terminal-pill">${escapeHtml(owner?.name || entry.agentId)}</span>
                ${(entry.symbols || [])
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((symbol) => `<span class="terminal-pill">${escapeHtml(symbol)}</span>`)
                  .join("")}
                ${(entry.references || [])
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((reference) => `<span class="terminal-pill">${escapeHtml(reference)}</span>`)
                  .join("")}
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderObjectiveControls() {
  if (!hasMasterAgent()) {
    return `
      <article class="terminal-block">
        <div class="terminal-head">
          <span class="terminal-label">Launch</span>
          <span class="status-pill status-queued">Idle</span>
        </div>
        <p class="terminal-subline">
          Start with a master agent. Once it exists, you can prompt it to create the rest of the tree or add subagents manually.
        </p>
        <div class="terminal-actions">
          <button type="button" class="terminal-button primary" data-session-action="activate" data-agent-id="master">
            Add Master Agent
          </button>
        </div>
      </article>
    `;
  }

  const statusClass =
    swarm.status === "running" ? "status-live" : swarm.status === "complete" ? "status-review" : "status-queued";
  const canRunElectron = Boolean(window.agentTreeDesktop?.startSwarm);
  const providerOptions = runtimeInfo.providers
    .map((provider) => {
      const selected = provider.id === (swarm.provider || runtimeInfo.defaultProvider);
      const unavailableSuffix = provider.available ? "" : " (Unavailable)";
      return `<option value="${escapeHtml(provider.id)}" ${selected ? "selected" : ""} ${
        provider.available ? "" : "disabled"
      }>${escapeHtml(provider.label + unavailableSuffix)}</option>`;
    })
    .join("");

  return `
    <article class="terminal-block">
      <div class="terminal-head">
        <span class="terminal-label">Swarm Runtime</span>
        <span class="status-pill ${statusClass}">${swarmStatusLabel(swarm.status)}</span>
      </div>
      <p class="terminal-subline">
        ${escapeHtml(
          swarm.objective || "No active objective. Prompt the master agent to create and launch tasks."
        )}
      </p>
      <div class="terminal-meta">
        <span class="terminal-pill">provider: ${escapeHtml(providerLabel(swarm.provider || runtimeInfo.defaultProvider))}</span>
        <span class="terminal-pill">phase: ${escapeHtml(swarm.phase || "idle")}</span>
        <span class="terminal-pill">${relativeTime(swarm.updatedAt)}</span>
      </div>
      ${
        swarm.lastError
          ? `<p class="terminal-feedback terminal-feedback-error">${escapeHtml(swarm.lastError)}</p>`
          : ""
      }
      ${
        canRunElectron
          ? `
            <form id="objective-form" class="objective-form">
              <label class="terminal-field">
                <span>Provider</span>
                <select name="provider">${providerOptions}</select>
              </label>
              <label class="terminal-field">
                <span>Master Prompt</span>
                <textarea
                  name="objective"
                  rows="2"
                  placeholder="Example: Improve the autoresearch loop around train.py, propose the next experiment, and surface the strongest constraints."
                >${escapeHtml(swarm.objective)}</textarea>
              </label>
              <div class="terminal-actions">
                <button type="submit" class="terminal-button primary" value="start-swarm">Run</button>
                ${
                  swarm.status === "running"
                    ? `<button type="submit" class="terminal-button" value="stop-swarm">Stop</button>`
                    : ""
                }
              </div>
            </form>
          `
          : `
            <p class="terminal-empty">
              Objective launch is available in the Electron app only.
            </p>
          `
      }
    </article>
  `;
}

function renderSessionGraph(activeChildren, dormantChildren) {
  if (activeChildren.length === 0 && dormantChildren.length === 0) {
    return `<div class="terminal-empty">Leaf session. No child agents under this node.</div>`;
  }

  return `
    ${
      activeChildren.length > 0
        ? `
          <div class="session-group">
            <span class="session-group-label">Running Children</span>
            <div class="session-command-stack">
              ${activeChildren
                .map(
                  (child) => `
                    <button
                      type="button"
                      class="session-command"
                      data-session-action="select"
                      data-agent-id="${child.id}"
                    >
                      <span class="terminal-prompt">&gt;</span>
                      <span class="session-command-copy">${escapeHtml(child.name)}</span>
                      <span class="session-command-meta">${statusLabel(child.status)}</span>
                    </button>
                  `
                )
                .join("")}
            </div>
          </div>
        `
        : ""
    }
    ${
      dormantChildren.length > 0
        ? `
          <div class="session-group">
            <span class="session-group-label">Add Children</span>
            <div class="session-command-stack">
              ${dormantChildren
                .map(
                  (child) => `
                    <button
                      type="button"
                      class="session-command"
                      data-session-action="activate"
                      data-agent-id="${child.id}"
                    >
                      <span class="terminal-prompt">+</span>
                      <span class="session-command-copy">${escapeHtml(child.name)}</span>
                      <span class="session-command-meta">Add</span>
                    </button>
                  `
                )
                .join("")}
            </div>
            <p class="terminal-empty">
              Add these manually or run the master prompt above and let it create only the agents it needs.
            </p>
          </div>
        `
        : ""
    }
  `;
}

function renderEmptyInspector() {
  const hasMaster = hasMasterAgent();
  detailEl.innerHTML = `
    <section class="terminal-shell terminal-shell-empty">
      <div class="terminal-bar">
        <div class="terminal-controls" aria-hidden="true">
          <span class="terminal-dot"></span>
          <span class="terminal-dot"></span>
          <span class="terminal-dot"></span>
        </div>
        <span class="terminal-title">session://none</span>
      </div>
      <div class="terminal-body">
        <article class="terminal-block">
          <span class="terminal-label">${hasMaster ? "Waiting" : "Workspace"}</span>
          ${
            hasMaster
              ? `
                <p class="terminal-empty">
                  Select the master agent or a running child to inspect its live session.
                </p>
              `
              : `
                <p class="terminal-empty">
                  Start from the tree with <strong>Add Master Agent</strong>. After that, the master can create subagents automatically or you can add them one by one.
                </p>
              `
          }
        </article>
      </div>
    </section>
  `;
  bindSessionControls();
}

function renderInspector() {
  const agent = agentsById.get(selectedAgentId);
  if (!agent || !isActiveAgent(agent)) {
    renderEmptyInspector();
    return;
  }

  const parent = agent.parentId ? agentsById.get(agent.parentId) : null;
  const activeChildren = getActiveChildren(agent.id);
  const dormantChildren = getDormantChildren(agent.id);
  const relatedEntries = getRelevantEntries(agent.id);
  const activityLines = [
    ...agent.recent.slice(0, 2).map((item) => ({ prefix: "+", value: item })),
    ...agent.completed.slice(0, 2).map((item) => ({ prefix: "#", value: item })),
  ];

  detailEl.innerHTML = `
    <section class="terminal-shell" data-lane="${agent.lane}">
      <div class="terminal-bar">
        <div class="terminal-controls" aria-hidden="true">
          <span class="terminal-dot"></span>
          <span class="terminal-dot"></span>
          <span class="terminal-dot"></span>
        </div>
        <div class="terminal-bar-meta">
          <span class="terminal-title">session://${agent.id}</span>
        </div>
      </div>

      <div class="terminal-body">
        ${renderObjectiveControls()}

        <article class="terminal-block">
          <div class="terminal-head">
            <span class="terminal-path">${laneLabel(agent.lane)} lane</span>
            <span class="status-pill status-${agent.status}">${statusLabel(agent.status)}</span>
          </div>
          <h2 class="terminal-agent">${escapeHtml(agent.name)}</h2>
          <p class="terminal-subline">${escapeHtml(agent.summary)}</p>
          <div class="terminal-meta">
            <span class="terminal-pill">${escapeHtml(agent.role)}</span>
            <span class="terminal-pill">${relativeTime(agent.updatedAt)}</span>
            <span class="terminal-pill">${escapeHtml(parent ? parent.name : "Top-level")}</span>
            <span class="terminal-pill">${activeChildren.length} live children</span>
            <span class="terminal-pill">${dormantChildren.length} dormant</span>
            <span class="terminal-pill">${countEntriesForAgent(agent.id)} ctx</span>
            ${
              agent.runtime?.source
                ? `<span class="terminal-pill">${escapeHtml(providerLabel(agent.runtime.source))}</span>`
                : ""
            }
            ${
              agent.runtime?.mode
                ? `<span class="terminal-pill">${escapeHtml(agent.runtime.mode)}</span>`
                : ""
            }
            ${
              agent.runtime?.pid
                ? `<span class="terminal-pill">pid ${escapeHtml(String(agent.runtime.pid))}</span>`
                : ""
            }
          </div>
        </article>

        <article class="terminal-block">
          <span class="terminal-label">Live Output</span>
          <div class="terminal-log">
            <div class="terminal-line">
              <span class="terminal-prompt">&gt;</span>
              <span>${escapeHtml(agent.current)}</span>
            </div>
            <div class="terminal-line">
              <span class="terminal-prompt">$</span>
              <span>${escapeHtml(agent.next)}</span>
            </div>
            ${
              activityLines.length > 0
                ? activityLines
                    .map(
                      (item) => `
                        <div class="terminal-line">
                          <span class="terminal-prompt">${item.prefix}</span>
                          <span>${escapeHtml(item.value)}</span>
                        </div>
                      `
                    )
                    .join("")
                : `
                  <div class="terminal-line">
                    <span class="terminal-prompt">.</span>
                    <span>No recent activity yet.</span>
                  </div>
                `
            }
          </div>
        </article>

        <article class="terminal-block">
          <span class="terminal-label">Session Graph</span>
          ${renderSessionGraph(activeChildren, dormantChildren)}
        </article>

        <article class="terminal-block">
          <span class="terminal-label">Shared DB</span>
          ${renderContextEntries(relatedEntries)}
        </article>
        ${flashMessage ? `<p class="terminal-feedback">${escapeHtml(flashMessage)}</p>` : ""}
      </div>
    </section>
  `;

  bindObjectiveForm();
  bindSessionControls();
}

function activateAgentLocally(agentId) {
  const nextAgents = agents.map((agent) => ({ ...agent }));
  const localMap = new Map(nextAgents.map((agent) => [agent.id, agent]));
  let current = localMap.get(agentId);
  while (current) {
    current.sessionActive = true;
    current.status = "live";
    current.updatedAt = new Date().toISOString();
    current = current.parentId ? localMap.get(current.parentId) : null;
  }

  swarm = {
    ...swarm,
    treeReady: true,
  };
  agents = nextAgents;
  agentsById = localMap;
  return { agents, contextEntries, swarm };
}

function bindObjectiveForm() {
  const form = detailEl.querySelector("#objective-form");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const action = event.submitter?.value;

    if (!window.agentTreeDesktop?.startSwarm) {
      flashMessage = "Run control is available in Electron only.";
      renderInspector();
      return;
    }

    try {
      if (action === "stop-swarm") {
        const nextState = await window.agentTreeDesktop.stopSwarm();
        flashMessage = "Swarm run stopped.";
        hydrateState(nextState);
        renderAll();
        return;
      }

      const formData = new FormData(form);
      const objective = String(formData.get("objective") || "").trim();
      const provider = String(formData.get("provider") || swarm.provider || runtimeInfo.defaultProvider).trim();
      if (!objective) {
        flashMessage = "Enter an objective for the master agent.";
        renderInspector();
        return;
      }

      const nextState = await window.agentTreeDesktop.startSwarm({ objective, provider });
      flashMessage = `Master run started with ${providerLabel(provider)}.`;
      hydrateState(nextState);
      selectedAgentId = "master";
      renderAll();
    } catch (error) {
      flashMessage = error.message || "Unable to control swarm.";
      renderInspector();
    }
  });
}

function bindSessionControls() {
  document.querySelectorAll("[data-session-action='select'], [data-session-action='activate']").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.sessionAction;
      const agentId = button.dataset.agentId;
      if (action === "select") {
        selectedAgentId = agentId;
        flashMessage = "";
        renderAll();
        return;
      }

      try {
        const nextState = window.agentTreeDesktop?.startSession
          ? await window.agentTreeDesktop.startSession({ agentId })
          : activateAgentLocally(agentId);
        hydrateState(nextState);
        selectedAgentId = agentId;
        flashMessage = agentId === "master" ? "Master agent added." : `${agentsById.get(agentId)?.name || agentId} added.`;
        renderAll();
      } catch (error) {
        flashMessage = error.message || "Unable to add agent.";
        renderInspector();
      }
    });
  });
}

function initFilters() {
  document.querySelectorAll(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".filter-chip").forEach((chip) => {
        chip.classList.toggle("is-active", chip === button);
      });
      renderTree();
    });
  });
}

function renderAll() {
  renderTree();
  renderInspector();
}

window.addEventListener("resize", () => {
  drawTreeLinks();
});

initFilters();
if (window.agentTreeDesktop?.onStateChanged) {
  window.agentTreeDesktop.onStateChanged((state) => {
    hydrateState(state);
    renderAll();
  });
}
Promise.all([loadRuntimeInfo(), loadInitialState()]).then(renderAll);
