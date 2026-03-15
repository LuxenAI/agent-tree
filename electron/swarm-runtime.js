const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const DEFAULT_PROVIDER = "codex";
const PROVIDER_LABELS = {
  codex: "Codex",
  claude: "Claude",
};

const AUTORESEARCH_BRIEF = [
  "Autoresearch operating brief:",
  "- Read the repo directly when needed, but keep shared context packets compact.",
  "- program.md is the operating loop: baseline first, then iterative experiments.",
  "- train.py is the only file agents should modify when making experiments.",
  "- prepare.py is read-only and owns data prep, evaluation, and time-budget constants.",
  "- Core commands: `uv run train.py > run.log 2>&1`, `grep \"^val_bpb:\\|^peak_vram_mb:\" run.log`, inspect `results.tsv`.",
  "- Shared DB entries should carry only decisive findings, command outcomes, symbols, constraints, commit ids, and reference ids.",
].join("\n");

function trimText(value = "", limit = 240) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 3).trimEnd()}...` : cleaned;
}

function commandExists(command) {
  const pathValue = process.env.PATH || "";
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      const candidate = path.join(dir, command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function commandAvailable(command) {
  if (!command) return false;
  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return commandExists(command);
}

function listRuntimeProviders(commandOverrides = {}) {
  return [
    {
      id: "codex",
      label: PROVIDER_LABELS.codex,
      command: commandOverrides.codex || "codex",
      available: commandAvailable(commandOverrides.codex || "codex"),
    },
    {
      id: "claude",
      label: PROVIDER_LABELS.claude,
      command: commandOverrides.claude || "claude",
      available: commandAvailable(commandOverrides.claude || "claude"),
    },
  ];
}

function normalizeProviderId(value) {
  const providerId = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  return providerId === "claude" ? "claude" : "codex";
}

function providerLabel(providerId) {
  return PROVIDER_LABELS[normalizeProviderId(providerId)] || "AI";
}

function buildRuntimeMarker(runId, agentId, mode, providerId) {
  return `AGENT_TREE_PROVIDER=${normalizeProviderId(providerId)};AGENT_TREE_AGENT=${agentId};AGENT_TREE_MODE=${mode};AGENT_TREE_RUN=${runId}`;
}

function parseRuntimeMarker(command = "") {
  const currentMatch = String(command).match(
    /AGENT_TREE_PROVIDER=([a-z0-9-]+);AGENT_TREE_AGENT=([a-z0-9-]+);AGENT_TREE_MODE=([a-z-]+);AGENT_TREE_RUN=(\d+)/i
  );
  if (currentMatch) {
    return {
      provider: normalizeProviderId(currentMatch[1]),
      agentId: currentMatch[2],
      mode: currentMatch[3],
      runId: Number(currentMatch[4]),
    };
  }

  return null;
}

function readRuntimeProcesses() {
  try {
    const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        const pid = Number(match[1]);
        const command = match[2];
        const marker = parseRuntimeMarker(command);
        if (!Number.isFinite(pid) || !marker) return null;
        return {
          pid,
          ...marker,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function compactLines(values = []) {
  return values
    .map((value) => trimText(value, 120))
    .filter(Boolean)
    .slice(0, 4);
}

function extractJsonBlock(text = "") {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function parseStructuredMessage(text) {
  const candidate = extractJsonBlock(text);
  if (!candidate) return null;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function buildClaudeEnvelopeSchema(mode) {
  if (mode === "master-plan") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["summary", "current", "next", "tasks"],
      properties: {
        summary: { type: "string" },
        current: { type: "string" },
        next: { type: "string" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["agentId", "goal", "contextSummary", "symbols", "references"],
            properties: {
              agentId: { type: "string" },
              goal: { type: "string" },
              contextSummary: { type: "string" },
              symbols: { type: "array", items: { type: "string" } },
              references: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "current", "next", "recent", "completed", "context"],
    properties: {
      summary: { type: "string" },
      current: { type: "string" },
      next: { type: "string" },
      recent: { type: "array", items: { type: "string" } },
      completed: { type: "array", items: { type: "string" } },
      context: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "summary", "symbols", "references"],
        properties: {
          kind: { type: "string" },
          summary: { type: "string" },
          symbols: { type: "array", items: { type: "string" } },
          references: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
}

function buildProviderCommand(providerId, mode, workdir, prompt) {
  const provider = normalizeProviderId(providerId);
  if (provider === "claude") {
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "--dangerously-skip-permissions",
        "--max-turns",
        "12",
        "--json-schema",
        JSON.stringify(buildClaudeEnvelopeSchema(mode)),
        prompt,
      ],
      label: providerLabel(provider),
    };
  }

  return {
    command: "codex",
    args: [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--full-auto",
      "-C",
      workdir,
      "-c",
      'model_reasoning_effort="high"',
      prompt,
    ],
    label: providerLabel(provider),
  };
}

function formatContextEntries(state, preferredReferences = []) {
  const byId = new Map((state.agents || []).map((agent) => [agent.id, agent]));
  const preferred = new Set(preferredReferences || []);
  const ordered = [...(state.contextEntries || [])].sort((a, b) => {
    if (preferred.has(a.id) && !preferred.has(b.id)) return -1;
    if (!preferred.has(a.id) && preferred.has(b.id)) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return ordered.slice(0, 6).map((entry) => {
    const owner = byId.get(entry.agentId);
    const symbols = (entry.symbols || []).slice(0, 3).join(", ");
    return `- ${entry.id} | ${owner?.name || entry.agentId} | ${entry.kind} | ${
      trimText(entry.summary, 120)
    }${symbols ? ` | symbols: ${symbols}` : ""}`;
  });
}

function formatAgentCatalog(state) {
  return (state.agents || [])
    .filter((agent) => agent.id !== "master")
    .map(
      (agent) =>
        `- ${agent.id}: ${agent.name} (${agent.role}) lane=${agent.lane} parent=${
          agent.parentId || "master"
        }`
    )
    .join("\n");
}

function fallbackTasks(state) {
  return (state.agents || [])
    .filter((agent) => ["planner", "evidence-lead", "synthesis-lead", "audit-lead"].includes(agent.id))
    .map((agent) => ({
      agentId: agent.id,
      goal: `Investigate the objective from the perspective of ${agent.role.toLowerCase()}.`,
      contextSummary: `Produce a compact packet for ${agent.name} and keep symbols/reference ids concise.`,
      symbols: [],
      references: [],
    }));
}

function normalizeTaskPackets(state, tasks) {
  const knownIds = new Set((state.agents || []).map((agent) => agent.id));
  const seen = new Set();
  const packets = [];

  for (const task of tasks || []) {
    const agentId = String(task.agentId || "").trim();
    if (!knownIds.has(agentId) || agentId === "master" || seen.has(agentId)) continue;
    const goal = trimText(task.goal || task.task || task.summary || "", 220);
    if (!goal) continue;

    packets.push({
      agentId,
      goal,
      contextSummary: trimText(task.contextSummary || task.summary || "", 220),
      symbols: Array.isArray(task.symbols) ? task.symbols.map(String).slice(0, 6) : [],
      references: Array.isArray(task.references) ? task.references.map(String).slice(0, 6) : [],
    });
    seen.add(agentId);
  }

  return packets;
}

function buildMasterPlanningPrompt(objective, state, runtimeMarker, providerId) {
  const contextLines = formatContextEntries(state);
  return `
Runtime marker for the UI only: ${runtimeMarker}

You are the master ${providerLabel(providerId)} agent for the local autoresearch repository.
Objective: ${objective}

${AUTORESEARCH_BRIEF}

Available agent templates:
${formatAgentCatalog(state)}

Current shared context packets:
${contextLines.length > 0 ? contextLines.join("\n") : "- none"}

Return strict JSON only:
{
  "summary": "one sentence run summary",
  "current": "what master is doing right now",
  "next": "what master expects after delegation",
  "tasks": [
    {
      "agentId": "planner",
      "goal": "clear concrete task",
      "contextSummary": "what context to pass compactly",
      "symbols": ["symbol_name"],
      "references": ["ctx-001"]
    }
  ]
}

Choose only the agents that are useful for this objective. Keep tasks compact and non-overlapping.
  `.trim();
}

function buildSubagentPrompt(objective, task, state, runtimeMarker, providerId) {
  const agent = (state.agents || []).find((item) => item.id === task.agentId);
  const contextLines = formatContextEntries(state, task.references);

  return `
Runtime marker for the UI only: ${runtimeMarker}

You are ${agent?.name || task.agentId}, a ${providerLabel(providerId)} subagent inside the local autoresearch repository.
Global objective: ${objective}
Assigned task: ${task.goal}
Compact handoff: ${task.contextSummary || "No extra handoff provided."}
Symbols to care about: ${(task.symbols || []).join(", ") || "none"}

${AUTORESEARCH_BRIEF}

Rules:
- Work from the repo directly when necessary.
- Keep outputs compact. Do not include large code excerpts or whole-file summaries.
- If you publish context, include only decisive findings, symbols, and relevant reference ids.
- Focus on README.md, program.md, train.py, prepare.py, results.tsv, and run.log when relevant.

Current shared context packets:
${contextLines.length > 0 ? contextLines.join("\n") : "- none"}

Return strict JSON only:
{
  "summary": "one sentence outcome summary",
  "current": "what the agent ended up doing",
  "next": "best immediate next step",
  "recent": ["short notable action"],
  "completed": ["short completed result"],
  "context": {
    "kind": "finding",
    "summary": "compact shared-db packet",
    "symbols": ["var_name"],
    "references": ["ctx-001"]
  }
}
  `.trim();
}

function buildMasterFinalizePrompt(objective, state, runtimeMarker, providerId) {
  const contextLines = formatContextEntries(state);
  return `
Runtime marker for the UI only: ${runtimeMarker}

You are the master ${providerLabel(providerId)} agent finalizing an autoresearch swarm run.
Objective: ${objective}

${AUTORESEARCH_BRIEF}

Subagents have already produced compact shared context packets. Synthesize only from those packets and the repo if absolutely necessary.

Shared context packets:
${contextLines.length > 0 ? contextLines.join("\n") : "- none"}

Return strict JSON only:
{
  "summary": "final master summary",
  "current": "what master concluded",
  "next": "best next user-facing step",
  "recent": ["short synthesis action"],
  "completed": ["short completed merge result"],
  "context": {
    "kind": "decision",
    "summary": "compact final decision packet",
    "symbols": ["experiment_axis"],
    "references": ["ctx-001"]
  }
}
  `.trim();
}

function parseAgentResult(message, fallbackSummary) {
  const parsed = parseStructuredMessage(message);
  if (!parsed) {
    return {
      summary: trimText(message || fallbackSummary, 220) || fallbackSummary,
      current: trimText(message || fallbackSummary, 220) || fallbackSummary,
      next: "Review the raw agent response.",
      recent: [],
      completed: [],
      context: null,
      tasks: [],
    };
  }

  return {
    summary: trimText(parsed.summary || fallbackSummary, 220) || fallbackSummary,
    current: trimText(parsed.current || parsed.summary || fallbackSummary, 220) || fallbackSummary,
    next: trimText(parsed.next || "Await the next orchestration step.", 220),
    recent: compactLines(parsed.recent || []),
    completed: compactLines(parsed.completed || []),
    context:
      parsed.context && typeof parsed.context === "object"
        ? {
            kind: trimText(parsed.context.kind || "finding", 40) || "finding",
            summary: trimText(parsed.context.summary || parsed.summary || "", 220),
            symbols: Array.isArray(parsed.context.symbols)
              ? parsed.context.symbols.map(String).slice(0, 6)
              : [],
            references: Array.isArray(parsed.context.references)
              ? parsed.context.references.map(String).slice(0, 6)
              : [],
          }
        : null,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
  };
}

function parseClaudeEnvelope(rawOutput = "") {
  const trimmed = String(rawOutput || "").trim();
  if (!trimmed) return null;

  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {}
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractClaudeMessage(rawOutput = "") {
  const envelope = parseClaudeEnvelope(rawOutput);
  if (!envelope) {
    return { message: trimText(rawOutput, 220), error: "" };
  }

  if (envelope.is_error || envelope.subtype === "error") {
    return {
      message: "",
      error: trimText(envelope.result || envelope.error || envelope.message || rawOutput, 220),
    };
  }

  const result = envelope.result ?? envelope.content ?? envelope.message ?? envelope;
  if (typeof result === "string") {
    return { message: result, error: "" };
  }
  if (result && typeof result === "object") {
    return { message: JSON.stringify(result), error: "" };
  }

  return { message: trimText(rawOutput, 220), error: "" };
}

class SwarmRuntime {
  constructor({
    contextStore,
    onStateChanged,
    workdir,
    codexCommand = "codex",
    claudeCommand = "claude",
    envOverrides = {},
  }) {
    this.contextStore = contextStore;
    this.onStateChanged = onStateChanged;
    this.workdir = workdir;
    this.commandOverrides = {
      codex: codexCommand,
      claude: claudeCommand,
    };
    this.envOverrides = envOverrides;
    this.sessions = new Map();
    this.runId = 0;
    this.isFinalizing = false;
  }

  getState() {
    return this.contextStore.getState();
  }

  getRuntimeInfo() {
    const providers = listRuntimeProviders(this.commandOverrides);
    return {
      defaultProvider: DEFAULT_PROVIDER,
      providers,
    };
  }

  getProvider(providerId) {
    const provider = listRuntimeProviders(this.commandOverrides).find(
      (candidate) => candidate.id === normalizeProviderId(providerId)
    );
    return provider || listRuntimeProviders(this.commandOverrides).find((candidate) => candidate.id === DEFAULT_PROVIDER);
  }

  startObjective(payload) {
    const objective = typeof payload === "string" ? payload : payload?.objective;
    const requestedProvider =
      typeof payload === "string" ? this.getState().swarm.provider || DEFAULT_PROVIDER : payload?.provider;
    const provider = this.getProvider(requestedProvider);
    if (!provider?.available) {
      throw new Error(`${provider?.label || "Selected provider"} CLI is not installed or not on PATH.`);
    }

    this.stopProcesses();
    this.runId += 1;
    this.isFinalizing = false;
    const nextState = this.contextStore.startSwarmRun({ objective, provider: provider.id });
    this.onStateChanged();
    this.launchMasterPlanning(this.runId, objective, provider.id);
    return nextState;
  }

  stopObjective() {
    this.stopProcesses();
    this.isFinalizing = false;
    const nextState = this.contextStore.stopSwarmRun();
    this.onStateChanged();
    return nextState;
  }

  stopProcesses() {
    for (const session of this.sessions.values()) {
      try {
        session.proc.kill("SIGINT");
      } catch {}
    }
    this.sessions.clear();
  }

  launchMasterPlanning(runId, objective, providerId) {
    const state = this.getState();
    this.launchAgent({
      runId,
      agentId: "master",
      providerId,
      mode: "master-plan",
      prompt: buildMasterPlanningPrompt(
        objective,
        state,
        buildRuntimeMarker(runId, "master", "master-plan", providerId),
        providerId
      ),
      task: null,
      initialCurrent: "Master agent is decomposing the objective into compact subagent packets.",
      initialNext: `Spawn the first wave of ${providerLabel(providerId)} subagents.`,
    });
  }

  launchMasterFinalize(runId, providerId) {
    const state = this.getState();
    this.launchAgent({
      runId,
      agentId: "master",
      providerId,
      mode: "master-finalize",
      prompt: buildMasterFinalizePrompt(
        state.swarm.objective,
        state,
        buildRuntimeMarker(runId, "master", "master-finalize", providerId),
        providerId
      ),
      task: null,
      initialCurrent: "Master agent is merging subagent outcomes from the shared DB.",
      initialNext: "Publish the final synthesis packet.",
    });
  }

  launchSubagent(runId, task, providerId) {
    const state = this.getState();
    this.launchAgent({
      runId,
      agentId: task.agentId,
      providerId,
      mode: "subagent",
      prompt: buildSubagentPrompt(
        state.swarm.objective,
        task,
        state,
        buildRuntimeMarker(runId, task.agentId, "subagent", providerId),
        providerId
      ),
      task,
      initialCurrent: task.goal,
      initialNext: "Read the repo and return a compact JSON result.",
    });
  }

  launchAgent({ runId, agentId, providerId, mode, prompt, task, initialCurrent, initialNext }) {
    if (runId !== this.runId || this.sessions.has(agentId)) {
      return;
    }

    const provider = this.getProvider(providerId);
    if (!provider?.available) {
      throw new Error(`${provider?.label || "Selected provider"} CLI is not installed or not on PATH.`);
    }

    const commandSpec = buildProviderCommand(provider.id, mode, this.workdir, prompt);

    const proc = spawn(provider.command, commandSpec.args, {
      cwd: this.workdir,
      env: { ...process.env, CODEX_CI: "1", ...this.envOverrides },
    });

    const session = {
      runId,
      agentId,
      providerId: provider.id,
      mode,
      task,
      proc,
      stdoutBuffer: "",
      rawStdout: "",
      lastMessage: "",
      stderr: "",
    };

    this.sessions.set(agentId, session);
    this.contextStore.startSession({ agentId });
    this.contextStore.saveSession({
      agentId,
      status: "live",
      current: initialCurrent,
      next: initialNext,
      recentItem:
        mode === "subagent"
          ? `Task packet received from master via ${provider.label}.`
          : `${provider.label} session started.`,
      runtime: {
        pid: proc.pid,
        mode,
        runId,
        source: provider.id,
        startedAt: new Date().toISOString(),
      },
    });
    this.onStateChanged();

    proc.stdout.on("data", (chunk) => this.handleStdout(agentId, chunk));
    proc.stderr.on("data", (chunk) => this.handleStderr(agentId, chunk));
    proc.on("exit", (code, signal) => this.handleExit(agentId, code, signal));
  }

  handleStdout(agentId, chunk) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    const text = chunk.toString();
    if (session.providerId === "claude") {
      session.rawStdout += text;
      return;
    }

    session.stdoutBuffer += text;
    let newlineIndex = session.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = session.stdoutBuffer.slice(0, newlineIndex).trim();
      session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleJsonLine(agentId, line);
      }
      newlineIndex = session.stdoutBuffer.indexOf("\n");
    }
  }

  handleStderr(agentId, chunk) {
    const session = this.sessions.get(agentId);
    if (!session) return;
    session.stderr += chunk.toString();
  }

  handleJsonLine(agentId, line) {
    const session = this.sessions.get(agentId);
    if (!session) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    const message = event.msg;
    if (!message?.type) return;

    if (message.type === "agent_message") {
      session.lastMessage = String(message.message || "");
      this.contextStore.saveSession({
        agentId,
        current: trimText(session.lastMessage, 220) || `${providerLabel(session.providerId)} returned a result message.`,
        next:
          session.mode === "master-plan"
            ? "Parse the task graph and launch subagents."
            : "Parse the result packet and publish shared context.",
      });
      this.onStateChanged();
      return;
    }

    if (message.type === "task_started") {
      this.contextStore.saveSession({
        agentId,
        current: `${providerLabel(session.providerId)} agent booted and is reading the task prompt.`,
        next: "Read the repo and emit a compact JSON packet.",
      });
      this.onStateChanged();
      return;
    }

    if (message.type === "exec_command_begin") {
      this.contextStore.saveSession({
        agentId,
        current: trimText(`Running command: ${message.command || "shell command"}`, 220),
        next: "Capture command output and continue the task.",
      });
      this.onStateChanged();
      return;
    }

    if (message.type === "exec_command_end") {
      this.contextStore.saveSession({
        agentId,
        recentItem: trimText(
          `Command finished${typeof message.exit_code === "number" ? ` with exit ${message.exit_code}` : ""}.`,
          120
        ),
      });
      this.onStateChanged();
    }
  }

  handleExit(agentId, code, signal) {
    const session = this.sessions.get(agentId);
    if (!session) return;
    this.sessions.delete(agentId);

    if (session.runId !== this.runId) {
      return;
    }

    const parsedClaude = session.providerId === "claude" ? extractClaudeMessage(session.rawStdout) : null;
    if (parsedClaude?.error) {
      this.handleFailure(agentId, parsedClaude.error);
      return;
    }

    if (code === 0) {
      this.handleSuccess(agentId, session);
      return;
    }

    const errorText = trimText(
      session.stderr || parsedClaude?.message || `Session exited with code ${code ?? "unknown"}.`,
      220
    );
    this.handleFailure(agentId, errorText);
  }

  handleFailure(agentId, errorText) {
    if (agentId === "master") {
      this.contextStore.saveSession({
        agentId,
        status: "review",
        current: "Master session failed.",
        next: "Review the captured error output.",
        recentItem: errorText,
        runtime: null,
      });
      this.contextStore.setSwarmState({
        status: "error",
        phase: "error",
        lastError: errorText,
      });
    } else {
      this.contextStore.addContextEntry({
        agentId,
        kind: "blocker",
        summary: errorText,
        symbols: ["agent_exit"],
        references: [],
      });
      this.contextStore.stopSession({ agentId });
    }

    this.onStateChanged();
    this.maybeFinalize();
  }

  handleSuccess(agentId, session) {
    const fallbackSummary =
      session.mode === "master-plan"
        ? "Master planning completed."
        : session.mode === "master-finalize"
          ? "Master synthesis completed."
          : `${agentId} completed its task.`;
    const message =
      session.providerId === "claude" ? extractClaudeMessage(session.rawStdout).message : session.lastMessage;
    const result = parseAgentResult(message, fallbackSummary);

    if (agentId === "master" && session.mode === "master-plan") {
      this.applyMasterPlan(result);
      return;
    }

    if (agentId === "master" && session.mode === "master-finalize") {
      this.applyMasterFinalize(result);
      return;
    }

    this.applySubagentResult(agentId, result);
    this.contextStore.stopSession({ agentId });
    this.onStateChanged();
    this.maybeFinalize();
  }

  applyMasterPlan(result) {
    const state = this.getState();
    const providerId = normalizeProviderId(state.swarm.provider);
    const tasks = normalizeTaskPackets(state, result.tasks);
    const selectedTasks = tasks.length > 0 ? tasks : fallbackTasks(state);

    this.contextStore.saveSession({
      agentId: "master",
      status: "live",
      current: result.current || "Master delegated the first wave of tasks.",
      next: result.next || "Wait for subagents to publish compact result packets.",
      summary: result.summary || "Master is coordinating subagent work.",
      recentItems: result.recent,
      completedItems: result.completed,
      runtime: null,
    });

    if (result.context?.summary) {
      this.contextStore.addContextEntry({
        agentId: "master",
        kind: result.context.kind || "decision",
        summary: result.context.summary,
        symbols: result.context.symbols || [],
        references: result.context.references || [],
      });
    }

    this.contextStore.setSwarmState({
      phase: "delegating",
      lastError: "",
    });
    this.onStateChanged();

    selectedTasks.forEach((task) => this.launchSubagent(this.runId, task, providerId));
    if (selectedTasks.length === 0) {
      this.maybeFinalize();
    }
  }

  applySubagentResult(agentId, result) {
    this.contextStore.saveSession({
      agentId,
      status: "review",
      current: result.current || `${agentId} completed its task.`,
      next: result.next || "Wait for master synthesis.",
      summary: result.summary,
      recentItems: result.recent,
      completedItems: result.completed,
      runtime: null,
    });

    if (result.context?.summary) {
      this.contextStore.addContextEntry({
        agentId,
        kind: result.context.kind || "finding",
        summary: result.context.summary,
        symbols: result.context.symbols || [],
        references: result.context.references || [],
      });
    }
  }

  applyMasterFinalize(result) {
    this.contextStore.saveSession({
      agentId: "master",
      status: "review",
      current: result.current || "Master finalized the run.",
      next: result.next || "Prompt the master again for the next research objective.",
      summary: result.summary || "Master finished synthesizing the run.",
      recentItems: result.recent,
      completedItems: result.completed,
      runtime: null,
    });

    if (result.context?.summary) {
      this.contextStore.addContextEntry({
        agentId: "master",
        kind: result.context.kind || "decision",
        summary: result.context.summary,
        symbols: result.context.symbols || [],
        references: result.context.references || [],
      });
    }

    this.contextStore.setSwarmState({
      status: "complete",
      phase: "complete",
      lastError: "",
    });
    this.isFinalizing = false;
    this.onStateChanged();
  }

  maybeFinalize() {
    const state = this.getState();
    if (this.isFinalizing) return;
    if (state.swarm.status !== "running") return;
    if (this.sessions.size > 0) return;

    this.isFinalizing = true;
    this.contextStore.setSwarmState({ phase: "finalizing" });
    this.onStateChanged();
    this.launchMasterFinalize(this.runId, normalizeProviderId(state.swarm.provider));
  }

  reconcileDetectedSessions() {
    const discovered = readRuntimeProcesses();
    const discoveredByAgent = new Map(discovered.map((session) => [session.agentId, session]));
    const liveIds = new Set([...this.sessions.keys(), ...discoveredByAgent.keys()]);
    const state = this.getState();
    let changed = false;

    discovered.forEach((session) => {
      const agent = (state.agents || []).find((item) => item.id === session.agentId);
      if (!agent) return;

      if (!agent.sessionActive && agent.id !== "master") {
        this.contextStore.startSession({ agentId: agent.id });
        changed = true;
      }

      const runtimeChanged =
        !agent.runtime ||
        agent.runtime.pid !== session.pid ||
        agent.runtime.mode !== session.mode ||
        agent.runtime.runId !== session.runId;

      if (runtimeChanged) {
        this.contextStore.saveSession({
          agentId: agent.id,
          status: "live",
          current: agent.current || `Detected a running ${providerLabel(session.provider)} session from the process table.`,
          next: agent.next || "Wait for the compact result packet to land.",
          runtime: {
            pid: session.pid,
            mode: session.mode,
            runId: session.runId,
            source: session.provider,
            startedAt: agent.runtime?.startedAt || new Date().toISOString(),
          },
        });
        changed = true;
      }
    });

    (state.agents || []).forEach((agent) => {
      if (agent.id === "master") {
        if (agent.runtime && !liveIds.has("master")) {
          this.contextStore.saveSession({
            agentId: "master",
            runtime: null,
          });
          changed = true;
        }
        return;
      }

      if (agent.sessionActive && !liveIds.has(agent.id)) {
        this.contextStore.stopSession({ agentId: agent.id });
        changed = true;
      }
    });

    if (changed) {
      const refreshedState = this.getState();
      const masterRuntime = (refreshedState.agents || []).find((agent) => agent.id === "master")?.runtime;
      const hasLiveSubagents = (refreshedState.agents || []).some(
        (agent) => agent.id !== "master" && agent.sessionActive
      );
      const hasLiveRuntime = Boolean(masterRuntime) || hasLiveSubagents;
      if (hasLiveRuntime && refreshedState.swarm.status === "idle") {
        this.contextStore.setSwarmState({
          status: "running",
          phase: "recovered",
          lastError: "",
        });
      } else if (!hasLiveRuntime && refreshedState.swarm.status === "running" && this.sessions.size === 0) {
        this.contextStore.setSwarmState({
          phase: refreshedState.swarm.phase === "recovered" ? "idle" : refreshedState.swarm.phase,
        });
      }
      this.onStateChanged();
    }
  }
}

module.exports = { SwarmRuntime };
