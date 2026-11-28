import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findExecutableOnPath, inferContextWindow } from "./utils.mjs";

export const id = "claude";
export const label = "Claude Code";

export const DEFAULT_MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
];

export function discoverUpstreamModels() {
  const models = DEFAULT_MODELS.map((m) => ({ ...m }));
  try {
    const cfgPath = path.join(os.homedir(), ".claude", "settings.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const active = (cfg?.model || cfg?.env?.ANTHROPIC_MODEL || "").trim();
      if (active && !models.some((m) => m.id === active)) {
        models.unshift({
          id: active,
          name: `${active} (上游配置)`,
          contextWindow: inferContextWindow(active, 200_000),
        });
      }
    }
  } catch {
    // ignore unreadable settings
  }
  return models;
}

export function resolveCommand() {
  const envBin = (process.env.ALILAS_CLAUDE_BIN || "").trim();
  if (envBin) return envBin;
  return findExecutableOnPath(
    process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"],
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
      ? "Ready (inherits ~/.claude/settings.json & CCSwitch relays)"
      : "claude CLI not installed (npm i -g @anthropic-ai/claude-code)",
    models: discoverUpstreamModels(),
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
    throw new Error("未检测到 claude CLI，请安装 @anthropic-ai/claude-code 或配置 ALILAS_CLAUDE_BIN");
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    permissionMode === "readonly" ? "plan" : "acceptEdits",
  ];
  const targetModel = profile?.model || model;
  if (targetModel) args.push("--model", targetModel);
  const targetEffort = effort || profile?.effort;
  if (targetEffort && ["low", "medium", "high", "max"].includes(targetEffort)) {
    args.push("--effort", targetEffort);
  }
  if (sessionId) args.push("--resume", sessionId);

  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  if (profile?.baseURL) env.ANTHROPIC_BASE_URL = profile.baseURL;
  if (profile?.apiKeyEnv && process.env[profile.apiKeyEnv]) {
    env.ANTHROPIC_AUTH_TOKEN = process.env[profile.apiKeyEnv];
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
 * Parse `claude -p --output-format stream-json --verbose --include-partial-messages` NDJSON.
 */
export function createParser(emit) {
  let step = 0;
  let stepStartAt = Date.now();
  let sawStepUsage = false;
  const toolStartMap = new Map();

  function normUsage(u) {
    if (!u || typeof u !== "object") return null;
    const inputTokens = u.input_tokens ?? 0;
    const outputTokens = u.output_tokens ?? 0;
    const cacheReadTokens = u.cache_read_input_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;
    const totalTokens = inputTokens + cacheReadTokens + cacheCreation + outputTokens;
    return { inputTokens, outputTokens, thinkingTokens: 0, cacheReadTokens, totalTokens };
  }

  function extractResultText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? "");
    return content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  }

  return {
    onStdoutLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }

      if (ev.session_id) {
        emit({ type: "session", sessionId: ev.session_id, cwd: ev.cwd || null, model: ev.model || null });
      }

      if (ev.type === "system" && ev.subtype === "init") {
        emit({ type: "status", phase: "session_ready", turn: 1, step: 0 });
        return;
      }

      // Partial streaming deltas (--include-partial-messages)
      if (ev.type === "stream_event" && ev.event) {
        const inner = ev.event;
        if (inner.type === "message_start") {
          step++;
          stepStartAt = Date.now();
          emit({ type: "stream_start", step });
          emit({ type: "status", phase: "step_start", step });
        } else if (inner.type === "content_block_delta" && inner.delta) {
          if (inner.delta.type === "thinking_delta" && inner.delta.thinking) {
            emit({ type: "reasoning_delta", text: inner.delta.thinking, step: step || 1 });
          } else if (inner.delta.type === "text_delta" && inner.delta.text) {
            emit({ type: "text_delta", text: inner.delta.text, step: step || 1 });
          }
        }
        return;
      }

      if (ev.type === "assistant" && ev.message) {
        if (!step) step = 1;
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        for (const b of blocks) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "thinking" && b.thinking) {
            emit({ type: "reasoning_commit", step, text: String(b.thinking).trim() });
          } else if (b.type === "text" && b.text) {
            emit({ type: "text_commit", step, text: String(b.text).trim() });
          } else if (b.type === "tool_use") {
            const callId = b.id || `claude-tu-${Date.now()}`;
            const now = Date.now();
            toolStartMap.set(callId, { name: b.name || "tool", startedAt: now });
            emit({
              type: "tool_start",
              callId,
              toolName: b.name || "tool",
              args: b.input ?? {},
              step,
              time: now,
            });
          }
        }
        const usage = normUsage(ev.message.usage);
        if (usage) {
          sawStepUsage = true;
          emit({
            type: "usage",
            usage,
            durationSec: Math.max(0.1, (Date.now() - stepStartAt) / 1000),
          });
        }
        return;
      }

      if (ev.type === "user" && ev.message) {
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        for (const b of blocks) {
          if (b && b.type === "tool_result") {
            const callId = b.tool_use_id || "";
            const meta = toolStartMap.get(callId);
            const now = Date.now();
            if (callId) toolStartMap.delete(callId);
            emit({
              type: "tool_end",
              callId,
              toolName: meta?.name || "tool",
              isError: Boolean(b.is_error),
              resultText: extractResultText(b.content),
              durationMs: meta ? Math.max(0, now - meta.startedAt) : null,
              step,
              time: now,
            });
          }
        }
        return;
      }

      if (ev.type === "result") {
        const usage = normUsage(ev.usage);
        const durSec = typeof ev.duration_ms === "number" ? ev.duration_ms / 1000 : null;
        if (usage && !sawStepUsage) emit({ type: "usage", usage, durationSec: durSec });
        if (ev.is_error) {
          emit({ type: "error", message: ev.result || "Claude Code exited with error" });
        } else if (typeof ev.result === "string" && ev.result.trim()) {
          emit({ type: "final", text: ev.result.trim(), usage, durationSec: durSec });
        }
      }
    },

    onStderrLine(line) {
      if (line.trim()) emit({ type: "stderr", text: line });
    },

    flush() {},
  };
}

export { inferContextWindow };
