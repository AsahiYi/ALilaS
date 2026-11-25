import { findExecutableOnPath, inferContextWindow, runQuickCommand } from "./utils.mjs";

export const id = "agy";
export const label = "Antigravity (agy)";

let cachedModels = null;
let cachedAt = 0;

export function resolveCommand() {
  const envBin = (process.env.ALILAS_AGY_BIN || "").trim();
  if (envBin) return envBin;
  return findExecutableOnPath(process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"]);
}

export function discoverModels(force = false) {
  const now = Date.now();
  if (!force && cachedModels && now - cachedAt < 120_000) {
    return cachedModels;
  }
  const cmd = resolveCommand();
  if (!cmd) return [];
  const res = runQuickCommand(cmd, ["models"], 8000);
  if (!res.ok) return cachedModels || [];
  const list = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Fetching")) continue;
    const parts = trimmed.split(/\t+/);
    const modelId = (parts[0] || "").trim();
    const displayName = (parts[1] || modelId).trim();
    if (!modelId || /\s/.test(modelId)) continue;
    list.push({
      id: modelId,
      name: displayName,
      contextWindow: inferContextWindow(modelId, 1_000_000),
    });
  }
  cachedModels = list;
  cachedAt = now;
  return list;
}

export function detect() {
  const cmd = resolveCommand();
  if (!cmd) {
    return {
      id,
      label,
      installed: false,
      command: null,
      detail: "agy CLI not found on PATH (set ALILAS_AGY_BIN to override)",
      models: [],
    };
  }
  const models = discoverModels(false);
  return {
    id,
    label,
    installed: true,
    command: cmd,
    detail: models.length ? `${models.length} native Antigravity models` : "Ready",
    models,
  };
}

export function buildInvocation({
  task,
  sessionId,
  cwd,
  model,
  effort,
  permissionMode = "auto",
}) {
  const cmd = resolveCommand();
  if (!cmd) {
    throw new Error("未检测到 agy CLI，请先安装 Antigravity CLI 或配置 ALILAS_AGY_BIN");
  }
  const args = [
    "-p",
    task,
    "--output-format",
    "stream-json",
    "--print-timeout",
    "0s",
    "--mode",
    permissionMode === "readonly" ? "plan" : "auto",
  ];
  if (model) args.push("--model", model);
  // agy model IDs like `gemini-3.8-flash-low` or `claude-opus-5-5-high` already encode effort;
  // passing a conflicting `--effort` flag makes agy reject the invocation.
  const modelHasEffortSuffix = /-(?:low|medium|high|xhigh|max)$/i.test(model || "");
  if (
    !modelHasEffortSuffix &&
    effort &&
    ["low", "medium", "high", "xhigh", "max"].includes(effort)
  ) {
    args.push("--effort", effort);
  }
  if (sessionId) {
    args.push("--conversation", sessionId);
  }

  return {
    cmd,
    args,
    cwd,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdinText: null,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd),
    cleanupPaths: [],
  };
}

/**
 * Parse `agy --output-format stream-json` NDJSON lines into normalized ALilaS events.
 */
export function createParser(emit) {
  let stepCounter = 0;
  let currentThinking = "";
  let currentText = "";
  let activeStepIndex = null;
  let sawStepUsage = false;
  const openTools = new Map();

  function commitBuffers(stepIdx) {
    if (currentThinking.trim()) {
      emit({ type: "reasoning_commit", step: stepIdx, text: currentThinking.trim() });
      currentThinking = "";
    }
    if (currentText.trim()) {
      emit({ type: "text_commit", step: stepIdx, text: currentText.trim() });
      currentText = "";
    }
  }

  function normalizeUsage(u) {
    if (!u || typeof u !== "object") return null;
    const inputTokens = u.input_tokens ?? u.inputTokens ?? 0;
    const outputTokens = u.output_tokens ?? u.outputTokens ?? 0;
    const thinkingTokens = u.thinking_tokens ?? u.thinkingTokens ?? u.reasoning_tokens ?? 0;
    const cacheReadTokens = u.cache_read_tokens ?? u.cacheReadTokens ?? 0;
    const totalTokens =
      u.total_tokens ?? u.totalTokens ?? inputTokens + cacheReadTokens + outputTokens + thinkingTokens;
    return { inputTokens, outputTokens, thinkingTokens, cacheReadTokens, totalTokens };
  }

  return {
    onStdoutLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const evType = ev.event || ev.type;
      const cid =
        ev.conversation_id ||
        ev.step_update?.conversation_id ||
        ev.result?.conversation_id ||
        null;

      if (evType === "init") {
        emit({
          type: "session",
          sessionId: cid,
          model: ev.init?.model || null,
          cwd: ev.init?.cwd || null,
        });
        emit({ type: "status", phase: "session_ready", turn: 1, step: 0 });
        return;
      }

      if (evType === "step_update" && ev.step_update) {
        const su = ev.step_update;
        const idx = typeof su.step_index === "number" ? su.step_index : stepCounter;
        if (idx > stepCounter) stepCounter = idx;
        if (cid) emit({ type: "session", sessionId: cid });

        const stype = String(su.step_type || "").toLowerCase();
        const state = String(su.state || "").toUpperCase();

        // Reasoning / thinking deltas
        const thinkDelta =
          su.thinking_delta ?? su.thought_delta ?? su.reasoning_delta ?? "";
        if (typeof thinkDelta === "string" && thinkDelta) {
          activeStepIndex = idx;
          currentThinking += thinkDelta;
          emit({ type: "reasoning_delta", text: thinkDelta, step: idx });
        }

        // Text deltas
        const textDelta = su.text_delta ?? su.response_delta ?? "";
        if (typeof textDelta === "string" && textDelta) {
          activeStepIndex = idx;
          currentText += textDelta;
          emit({ type: "text_delta", text: textDelta, step: idx });
        }

        // Tool steps (when agy emits tool call / tool execution updates)
        const toolName = su.tool_name || su.toolName || (stype.includes("tool") || stype.includes("command") || stype.includes("file") ? stype : "");
        if (toolName && stype !== "agent_response" && stype !== "user_input") {
          const callId = su.call_id || su.tool_call_id || `agy-step-${idx}`;
          if (!openTools.has(callId)) {
            openTools.set(callId, { toolName, startedAt: Date.now() });
            emit({
              type: "tool_start",
              callId,
              toolName,
              args: su.tool_input ?? su.arguments ?? su.args ?? su.command ?? "",
              step: idx,
              time: Date.now(),
            });
          }
          if (state === "DONE" || state === "ERROR" || state === "FAILED") {
            const meta = openTools.get(callId);
            const durMs =
              typeof su.duration_seconds === "number"
                ? Math.round(su.duration_seconds * 1000)
                : meta
                  ? Date.now() - meta.startedAt
                  : null;
            emit({
              type: "tool_end",
              callId,
              toolName,
              isError: state === "ERROR" || state === "FAILED" || Boolean(su.is_error || su.error),
              resultText:
                typeof su.tool_output === "string"
                  ? su.tool_output
                  : typeof su.output === "string"
                    ? su.output
                    : su.error
                      ? String(su.error)
                      : "",
              durationMs: durMs,
              step: idx,
              time: Date.now(),
            });
            openTools.delete(callId);
          }
        }

        const usage = normalizeUsage(su.usage);
        if (usage) {
          sawStepUsage = true;
          emit({
            type: "usage",
            usage,
            durationSec: typeof su.duration_seconds === "number" ? su.duration_seconds : null,
          });
        }

        if (state === "DONE" && stype === "agent_response") {
          commitBuffers(idx);
          emit({ type: "status", phase: "step_end", step: idx });
        } else if (state === "ACTIVE") {
          emit({
            type: "status",
            phase: thinkDelta ? "thinking" : textDelta ? "writing" : toolName ? `tool:${toolName}` : "running",
            step: idx,
          });
        }
        return;
      }

      if (evType === "result" && ev.result) {
        const r = ev.result;
        commitBuffers(activeStepIndex ?? stepCounter);
        const usage = normalizeUsage(r.usage);
        if (usage && !sawStepUsage) {
          emit({
            type: "usage",
            usage,
            durationSec: typeof r.duration_seconds === "number" ? r.duration_seconds : null,
          });
        }
        const status = String(r.status || "").toUpperCase();
        if (status && status !== "SUCCESS" && status !== "OK" && status !== "DONE") {
          emit({ type: "error", message: r.error || `agy 退出状态: ${r.status}` });
        }
        if (typeof r.response === "string" && r.response.trim()) {
          emit({
            type: "final",
            text: r.response.trim(),
            usage,
            durationSec: typeof r.duration_seconds === "number" ? r.duration_seconds : null,
          });
        }
        return;
      }

      if (evType === "error") {
        emit({ type: "error", message: ev.message || ev.error || JSON.stringify(ev) });
      }
    },

    onStderrLine(line) {
      if (line.trim()) {
        emit({ type: "stderr", text: line });
      }
    },

    flush() {
      commitBuffers(activeStepIndex ?? stepCounter);
    },
  };
}
