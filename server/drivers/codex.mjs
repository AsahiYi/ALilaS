import { findExecutableOnPath, inferContextWindow } from "./utils.mjs";

export const id = "codex";
export const label = "Codex CLI";

export const DEFAULT_MODELS = [
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 400_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 400_000 },
  { id: "o3", name: "o3", contextWindow: 200_000 },
  { id: "o4-mini", name: "o4-mini", contextWindow: 200_000 },
];

export function resolveCommand() {
  const envBin = (process.env.ALILAS_CODEX_BIN || "").trim();
  if (envBin) return envBin;
  return findExecutableOnPath(
    process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"],
  );
}

export function detect() {
  const cmd = resolveCommand();
  return {
    id,
    label,
    installed: Boolean(cmd),
    command: cmd,
    detail: cmd
      ? "Ready (inherits ~/.codex/config.toml & ccswitch relays)"
      : "codex CLI not installed (npm i -g @openai/codex)",
    models: DEFAULT_MODELS,
  };
}

export function buildInvocation({
  task,
  sessionId,
  cwd,
  model,
  effort,
  permissionMode = "auto",
  profile,
}) {
  const cmd = resolveCommand();
  if (!cmd) {
    throw new Error("未检测到 codex CLI，请安装 @openai/codex 或配置 ALILAS_CODEX_BIN");
  }
  const args = ["exec"];
  if (sessionId) {
    args.push("resume", sessionId);
  }
  args.push("--json");
  if (permissionMode === "readonly") {
    args.push("--sandbox", "read-only");
  } else {
    args.push("--full-auto");
  }
  const targetModel = profile?.model || model;
  if (targetModel) args.push("--model", targetModel);
  const targetEffort = effort || profile?.effort;
  if (targetEffort && ["low", "medium", "high", "xhigh"].includes(targetEffort)) {
    args.push("-c", `model_reasoning_effort=${targetEffort}`);
  }
  args.push("-");

  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  if (profile?.baseURL) env.OPENAI_BASE_URL = profile.baseURL;
  if (profile?.apiKeyEnv && process.env[profile.apiKeyEnv]) {
    env.OPENAI_API_KEY = process.env[profile.apiKeyEnv];
  }

  return {
    cmd,
    args,
    cwd,
    env,
    stdinText: task,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd),
    cleanupPaths: [],
  };
}

/**
 * Parse `codex exec --json` NDJSON event stream into normalized ALilaS events.
 */
export function createParser(emit) {
  let step = 0;
  let turnStartAt = Date.now();
  let lastAgentText = "";
  const openItems = new Map();

  function normUsage(u) {
    if (!u || typeof u !== "object") return null;
    const rawInput = u.input_tokens ?? 0;
    const cached = u.cached_input_tokens ?? 0;
    const inputTokens = Math.max(0, rawInput - cached);
    const outputTokens = u.output_tokens ?? 0;
    const totalTokens = rawInput + outputTokens;
    return { inputTokens, outputTokens, thinkingTokens: 0, cacheReadTokens: cached, totalTokens };
  }

  return {
    onStdoutLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }

      if (ev.type === "thread.started" && ev.thread_id) {
        emit({ type: "session", sessionId: ev.thread_id });
        emit({ type: "status", phase: "session_ready", turn: 1, step: 0 });
        return;
      }

      if (ev.type === "turn.started") {
        turnStartAt = Date.now();
        step++;
        emit({ type: "status", phase: "step_start", step });
        return;
      }

      if (ev.type === "item.started" && ev.item) {
        const it = ev.item;
        const callId = it.id || `codex-${Date.now()}`;
        if (it.type === "command_execution" || it.type === "mcp_tool_call" || it.type === "file_change") {
          const toolName =
            it.type === "command_execution"
              ? "shell"
              : it.type === "file_change"
                ? "file_change"
                : it.tool || "mcp_tool";
          const now = Date.now();
          openItems.set(callId, { toolName, startedAt: now });
          emit({
            type: "tool_start",
            callId,
            toolName,
            args: it.command ? { command: it.command } : it.arguments ?? it.changes ?? {},
            step: step || 1,
            time: now,
          });
        }
        return;
      }

      if (ev.type === "item.updated" && ev.item) {
        const it = ev.item;
        if (it.type === "reasoning" && typeof it.delta === "string" && it.delta) {
          emit({ type: "reasoning_delta", text: it.delta, step: step || 1 });
        } else if (it.type === "agent_message" && typeof it.delta === "string" && it.delta) {
          emit({ type: "text_delta", text: it.delta, step: step || 1 });
        }
        return;
      }

      if (ev.type === "item.completed" && ev.item) {
        const it = ev.item;
        const curStep = step || 1;
        if (it.type === "reasoning" && typeof it.text === "string" && it.text.trim()) {
          emit({ type: "reasoning_commit", step: curStep, text: it.text.trim() });
        } else if (it.type === "agent_message" && typeof it.text === "string" && it.text.trim()) {
          lastAgentText = it.text.trim();
          emit({ type: "text_commit", step: curStep, text: lastAgentText });
        } else if (
          it.type === "command_execution" ||
          it.type === "mcp_tool_call" ||
          it.type === "file_change"
        ) {
          const callId = it.id || `codex-${Date.now()}`;
          const meta = openItems.get(callId);
          const now = Date.now();
          const toolName =
            meta?.toolName ||
            (it.type === "command_execution"
              ? "shell"
              : it.type === "file_change"
                ? "file_change"
                : it.tool || "mcp_tool");
          if (!meta) {
            emit({
              type: "tool_start",
              callId,
              toolName,
              args: it.command ? { command: it.command } : it.arguments ?? it.changes ?? {},
              step: curStep,
              time: now,
            });
          }
          openItems.delete(callId);
          const isError =
            it.status === "failed" ||
            (typeof it.exit_code === "number" && it.exit_code !== 0) ||
            Boolean(it.error);
          const resultText =
            typeof it.aggregated_output === "string"
              ? it.aggregated_output
              : typeof it.output === "string"
                ? it.output
                : it.changes
                  ? JSON.stringify(it.changes, null, 2)
                  : it.error
                    ? String(it.error)
                    : "";
          emit({
            type: "tool_end",
            callId,
            toolName,
            isError,
            resultText,
            durationMs: meta ? Math.max(0, now - meta.startedAt) : null,
            step: curStep,
            time: now,
          });
        }
        return;
      }

      if (ev.type === "turn.completed") {
        const usage = normUsage(ev.usage);
        const durSec = Math.max(0.1, (Date.now() - turnStartAt) / 1000);
        if (usage) emit({ type: "usage", usage, durationSec: durSec });
        emit({ type: "status", phase: "turn_end", step });
        if (lastAgentText) {
          emit({ type: "final", text: lastAgentText, usage, durationSec: durSec });
        }
        return;
      }

      if (ev.type === "turn.failed" || ev.type === "error") {
        emit({ type: "error", message: ev.error?.message || ev.message || JSON.stringify(ev) });
      }
    },

    onStderrLine(line) {
      if (line.trim()) emit({ type: "stderr", text: line });
    },

    flush() {},
  };
}

export { inferContextWindow };
