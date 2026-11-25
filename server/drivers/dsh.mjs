import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { findExecutableOnPath, inferContextWindow } from "./utils.mjs";

export const id = "dsh";
export const label = "DeepSeek Harness (dsh)";

const STREAM_PREFIX = "__LILAS_STREAM__";

export function resolveCommand() {
  const configured = (process.env.ALILAS_DSH_BIN || process.env.LILAS_DSH_BIN || "").trim();
  if (configured) {
    if (/\.(?:c|m)?js$/i.test(configured)) {
      return { cmd: process.execPath, prefixArgs: [configured], display: configured };
    }
    return { cmd: configured, prefixArgs: [], display: configured };
  }
  const onPath = findExecutableOnPath(process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh"] : ["dsh"]);
  if (onPath) {
    return { cmd: onPath, prefixArgs: [], display: onPath };
  }
  return null;
}

export function resolveBasePatch(pluginRoot) {
  const fromEnv = (process.env.ALILAS_PATCH_FILE || process.env.LILAS_PATCH_FILE || "").trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(pluginRoot, "config", "mode_a_patch.yml");
  return fs.existsSync(local) ? local : "";
}

/**
 * Lightweight parser to surface models declared in user's config/mode_a_patch.yml (no external yaml dep).
 */
export function readPatchModels(pluginRoot) {
  const fp = resolveBasePatch(pluginRoot);
  if (!fp) return [];
  try {
    const text = fs.readFileSync(fp, "utf8");
    const provMatch = text.match(/^\s*provider:\s*([^\s#]+)/m);
    const defaultProvider = provMatch ? provMatch[1].replace(/^['"]|['"]$/g, "") : "default";
    const models = [];
    const seen = new Set();
    // Match `models:` items with `- id: ...`
    const re = /-\s+id:\s*([^\s#\r\n]+)[\s\S]{0,220}?(?:name:\s*([^\r\n#]+))?/g;
    const modelsBlockIdx = text.indexOf("models:");
    if (modelsBlockIdx !== -1) {
      const sub = text.slice(modelsBlockIdx);
      let m;
      while ((m = re.exec(sub)) !== null) {
        const modelId = m[1].replace(/^['"]|['"]$/g, "").trim();
        if (!modelId || seen.has(modelId)) continue;
        seen.add(modelId);
        const name = m[2] ? m[2].replace(/^['"]|['"]$/g, "").trim() : modelId;
        const cwMatch = sub.slice(m.index, m.index + 320).match(/contextWindow:\s*(\d+)/);
        models.push({
          id: modelId,
          name,
          provider: defaultProvider,
          contextWindow: cwMatch ? Number(cwMatch[1]) : inferContextWindow(modelId, 1_000_000),
        });
      }
    }
    if (models.length === 0) {
      const modMatch = text.match(/^\s*model:\s*([^\s#]+)/m);
      if (modMatch) {
        const modelId = modMatch[1].replace(/^['"]|['"]$/g, "").trim();
        models.push({
          id: modelId,
          name: modelId,
          provider: defaultProvider,
          contextWindow: inferContextWindow(modelId, 1_000_000),
        });
      }
    }
    return models;
  } catch {
    return [];
  }
}

export function detect({ pluginRoot } = {}) {
  const spec = resolveCommand();
  if (!spec) {
    return {
      id,
      label,
      installed: false,
      command: null,
      detail: "dsh not found on PATH (set ALILAS_DSH_BIN to override)",
      models: [],
    };
  }
  const models = pluginRoot ? readPatchModels(pluginRoot) : [];
  return {
    id,
    label,
    installed: true,
    command: spec.display,
    detail: models.length ? `${models.length} configured DSH model(s)` : "Ready (Mode A headless)",
    models,
  };
}

function ensureStreamProbePatch(dataDir, pluginRoot) {
  const probePath = path.join(pluginRoot, "server", "stream_probe.mjs");
  if (!fs.existsSync(probePath)) return "";
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const patchPath = path.join(dataDir, "stream_probe_patch.yml");
    const probeUrl = pathToFileURL(probePath).href;
    const content = `- insert:\n    - id: lilas-stream-probe\n      name: ${JSON.stringify(probeUrl)}\n`;
    if (!fs.existsSync(patchPath) || fs.readFileSync(patchPath, "utf8") !== content) {
      fs.writeFileSync(patchPath, content, "utf8");
    }
    return patchPath;
  } catch {
    return "";
  }
}

/**
 * Per-run temporary YAML patch overlay so concurrent sessions can freely run different models
 * or custom OpenAI-compatible upstream endpoints with ZERO conflict on shared config files.
 */
function writePerRunModelPatch({ dataDir, runId, model, effort, profile }) {
  if (!model && !effort && !profile) return "";
  const entries = [];

  if (profile?.baseURL && profile?.provider && profile?.model) {
    entries.push(
      `- id: credentials\n  disabled: false`,
      `- id: tool-result-pruner\n  disabled: true`,
      [
        `- id: llm-pi-ai`,
        `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
        `  config:`,
        `    providers:`,
        `      ${profile.provider}:`,
        `        apiKeyEnv: ${profile.apiKeyEnv || "OPENAI_API_KEY"}`,
        `        api: ${profile.api || "openai-responses"}`,
        `        baseURL: ${JSON.stringify(profile.baseURL)}`,
        `        displayName: ${JSON.stringify(profile.name || profile.provider)}`,
        `        models:`,
        `          - id: ${JSON.stringify(profile.model)}`,
        `            name: ${JSON.stringify(profile.name || profile.model)}`,
        `            contextWindow: ${Number(profile.contextWindow) || 200000}`,
        `            maxTokens: ${Number(profile.maxTokens) || 64000}`,
        `            input:`,
        `              - text`,
        `              - image`,
        `            reasoningEfforts:`,
        `              off: null`,
        `              low: low`,
        `              medium: medium`,
        `              high: high`,
      ].join("\n"),
    );
  }

  const targetProvider = profile?.provider || undefined;
  const targetModel = profile?.model || model || undefined;
  const targetEffort = effort || profile?.effort || undefined;

  if (targetModel || targetProvider || targetEffort) {
    const cfgLines = [
      `- id: agent-default-model`,
      `  name: "@deepseek-ai/dsh-agent-default-model"`,
      `  config:`,
    ];
    if (targetProvider) cfgLines.push(`    provider: ${JSON.stringify(targetProvider)}`);
    if (targetModel) cfgLines.push(`    model: ${JSON.stringify(targetModel)}`);
    if (targetEffort && ["low", "medium", "high"].includes(targetEffort)) {
      cfgLines.push(`    reasoningEffort: ${targetEffort}`);
    }
    entries.push(cfgLines.join("\n"));
  }

  if (entries.length === 0) return "";
  const tmpDir = path.join(dataDir, "tmp_patches");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${runId}.yml`);
  fs.writeFileSync(tmpFile, entries.join("\n") + "\n", "utf8");
  return tmpFile;
}

export function buildInvocation({
  runId,
  task,
  sessionId,
  cwd,
  model,
  effort,
  profile,
  dataDir,
  pluginRoot,
}) {
  const spec = resolveCommand();
  if (!spec) {
    throw new Error("未检测到 dsh（DeepSeek Harness），请配置 ALILAS_DSH_BIN 或安装 dsh");
  }

  const args = [...spec.prefixArgs, "--profile", "headless"];
  const cleanupPaths = [];

  const basePatch = resolveBasePatch(pluginRoot);
  if (basePatch) args.push("--patch", basePatch);

  const perRunPatch = writePerRunModelPatch({ dataDir, runId, model, effort, profile });
  if (perRunPatch) {
    args.push("--patch", perRunPatch);
    cleanupPaths.push(perRunPatch);
  }

  const probePatch = ensureStreamProbePatch(dataDir, pluginRoot);
  if (probePatch) args.push("--patch", probePatch);

  args.push("--json");
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  args.push("-");

  return {
    cmd: spec.cmd,
    args,
    cwd,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdinText: task,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(spec.cmd),
    cleanupPaths,
  };
}

export function createParser(emit) {
  let rootSessionId = null;
  let currentStep = 0;
  let stepStartAt = null;
  const openToolStarts = new Map();

  function normUsage(u) {
    if (!u || typeof u !== "object") return null;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const thinkingTokens = u.reasoningTokens ?? 0;
    const cacheReadTokens = u.cacheReadTokens ?? 0;
    const totalTokens = u.totalTokens ?? inputTokens + cacheReadTokens + outputTokens;
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

      if (ev.type === "session" && ev.sessionId) {
        rootSessionId = ev.sessionId;
        emit({ type: "session", sessionId: ev.sessionId, cwd: ev.cwd || null });
        emit({ type: "status", phase: "session_ready", turn: 1, step: 0 });
      } else if (ev.type === "status") {
        if (typeof ev.step === "number") currentStep = ev.step;
        if (ev.phase === "step_start") stepStartAt = Date.now();
        const usage = normUsage(ev.usage);
        if (usage) {
          const durSec = stepStartAt ? Math.max(0.1, (Date.now() - stepStartAt) / 1000) : null;
          emit({ type: "usage", usage, durationSec: durSec });
        }
        emit({
          type: "status",
          phase: ev.phase || "running",
          turn: ev.turn,
          step: ev.step,
        });
        if (ev.reason?.kind === "error") {
          emit({
            type: "error",
            message: ev.reason?.error?.message || JSON.stringify(ev.reason),
          });
        }
      } else if (ev.type === "thinking" && typeof ev.text === "string" && ev.text.trim()) {
        emit({ type: "reasoning_commit", step: currentStep, text: ev.text.trim() });
      } else if (ev.type === "text" && typeof ev.text === "string" && ev.text.trim()) {
        emit({ type: "text_commit", step: currentStep, text: ev.text.trim() });
      } else if (ev.type === "tool_call") {
        const callId = ev.callId || `dsh-tc-${Date.now()}`;
        const now = Date.now();
        openToolStarts.set(callId, now);
        emit({
          type: "tool_start",
          callId,
          toolName: ev.tool || "tool",
          args: ev.input ?? {},
          step: currentStep,
          time: now,
        });
      } else if (ev.type === "tool_result") {
        const callId = ev.callId || "";
        const started = openToolStarts.get(callId);
        const now = Date.now();
        if (callId) openToolStarts.delete(callId);
        emit({
          type: "tool_end",
          callId,
          toolName: ev.tool || "tool",
          isError: ev.status === "error",
          resultText: typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? ""),
          durationMs: started ? Math.max(0, now - started) : null,
          step: currentStep,
          time: now,
        });
      } else if (ev.type === "final") {
        if (typeof ev.text === "string" && ev.text.trim()) {
          emit({ type: "final", text: ev.text.trim() });
        }
      } else if (ev.type === "error") {
        emit({ type: "error", message: ev.message || JSON.stringify(ev) });
      }
    },

    onStderrLine(rawLine) {
      if (rawLine.startsWith(STREAM_PREFIX)) {
        try {
          const ev = JSON.parse(rawLine.slice(STREAM_PREFIX.length));
          if (ev.sessionId && rootSessionId && ev.sessionId !== rootSessionId) return;
          if (ev.type === "stream_start") {
            stepStartAt = Date.now();
            emit({ type: "stream_start", step: currentStep || 1 });
          } else if (ev.type === "reasoning_delta" && ev.text) {
            emit({ type: "reasoning_delta", text: ev.text, step: currentStep || 1 });
          } else if (ev.type === "text_delta" && ev.text) {
            emit({ type: "text_delta", text: ev.text, step: currentStep || 1 });
          } else if (ev.type === "tool_delta" && ev.toolName) {
            emit({ type: "tool_delta", toolName: ev.toolName, step: currentStep || 1 });
          } else if (ev.type === "usage" && ev.usage) {
            const usage = normUsage(ev.usage);
            const durSec = stepStartAt ? Math.max(0.1, (Date.now() - stepStartAt) / 1000) : null;
            if (usage) emit({ type: "usage", usage, durationSec: durSec });
          }
        } catch {
          // ignore malformed probe line
        }
      } else if (rawLine.trim()) {
        emit({ type: "stderr", text: rawLine });
      }
    },

    flush() {},
  };
}
