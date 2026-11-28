import fs from "node:fs";
import os from "node:os";
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
  if (!pluginRoot) return "";
  const local = path.join(pluginRoot, "config", "mode_a_patch.yml");
  return fs.existsSync(local) ? local : "";
}

export function resolveDesktopPatch() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const fp = path.join(dshHome, "profiles", "desktop", "cordis.patch.yml");
  return fs.existsSync(fp) ? fp : "";
}

function unquoteYaml(val) {
  const s = String(val || "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Zero-dependency indentation-aware parser for DSH `llm-pi-ai` `providers:` blocks.
 * Strictly reads provider metadata (`apiKeyEnv` name only, never secret values).
 */
export function parseProvidersFromYaml(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const providers = [];

  let inLlm = false;
  let inProviders = false;
  let providersIndent = -1;
  let curProv = null;
  let provIndent = -1;
  let inModels = false;
  let modelsIndent = -1;
  let curModel = null;
  let inEfforts = false;
  let effortsIndent = -1;
  let inInputs = false;
  let inputsIndent = -1;

  for (const rawLine of lines) {
    const clean = stripInlineComment(rawLine).replace(/\s+$/, "");
    if (!clean.trim()) continue;
    const indent = clean.match(/^(\s*)/)[1].length;
    const trimmed = clean.trim();

    // Detect top-level YAML list entry (`- id: ...`)
    if (indent === 0 && trimmed.startsWith("- ")) {
      inLlm = /^-+\s*id:\s*['"]?llm-pi-ai['"]?\s*$/.test(trimmed);
      inProviders = false;
      curProv = null;
      inModels = false;
      curModel = null;
      inEfforts = false;
      inInputs = false;
      continue;
    }

    if (!inLlm) continue;

    if (!inProviders) {
      if (trimmed === "providers:") {
        inProviders = true;
        providersIndent = indent;
      }
      continue;
    }

    if (indent <= providersIndent) {
      inProviders = false;
      curProv = null;
      inModels = false;
      curModel = null;
      inEfforts = false;
      inInputs = false;
      continue;
    }

    // Provider key line (direct child of `providers:`)
    if (curProv === null || indent === provIndent) {
      const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*$/);
      if (m) {
        provIndent = indent;
        curProv = {
          key: m[1],
          displayName: m[1],
          apiKeyEnv: "",
          api: "openai-responses",
          baseURL: "",
          models: [],
        };
        providers.push(curProv);
        inModels = false;
        curModel = null;
        inEfforts = false;
        inInputs = false;
        continue;
      }
    }

    if (!curProv) continue;

    // Inside a provider
    if (inEfforts && indent <= effortsIndent) {
      inEfforts = false;
    }
    if (inInputs && indent <= inputsIndent) {
      inInputs = false;
    }
    if (inModels && indent <= modelsIndent) {
      inModels = false;
      curModel = null;
    }

    if (!inModels) {
      const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) {
        const [, k, v] = kv;
        if (k === "models") {
          inModels = true;
          modelsIndent = indent;
          curModel = null;
        } else if (k === "displayName") curProv.displayName = unquoteYaml(v) || curProv.key;
        else if (k === "apiKeyEnv") curProv.apiKeyEnv = unquoteYaml(v);
        else if (k === "api") curProv.api = unquoteYaml(v);
        else if (k === "baseURL") curProv.baseURL = unquoteYaml(v);
      }
      continue;
    }

    // Inside `input:` list under a model (`- text` / `- image`)
    if (inInputs && curModel) {
      const im = trimmed.match(/^-\s+(.+)$/);
      if (im) {
        const val = unquoteYaml(im[1]).toLowerCase();
        if (val && !curModel._parsedInputs.includes(val)) {
          curModel._parsedInputs.push(val);
        }
      }
      continue;
    }

    // Inside `models:`
    if (trimmed.startsWith("- ")) {
      inEfforts = false;
      inInputs = false;
      const m = trimmed.match(/^-\s+id:\s*(.+)$/);
      if (m) {
        const modelId = unquoteYaml(m[1]);
        curModel = {
          id: modelId,
          name: modelId,
          provider: curProv.key,
          providerLabel: curProv.displayName || curProv.key,
          contextWindow: inferContextWindow(modelId, 200_000),
          maxTokens: 64_000,
          inputs: ["text", "image"],
          efforts: ["low", "medium", "high"],
          effortMap: null,
        };
        curProv.models.push(curModel);
      }
      continue;
    }

    if (!curModel) continue;

    if (inEfforts) {
      const ekv = trimmed.match(/^(off|low|medium|high|xhigh|max):\s*(.*)$/i);
      if (ekv) {
        const ek = ekv[1].toLowerCase();
        const rawEv = ekv[2].trim();
        const lowerEv = rawEv.toLowerCase();
        if (!curModel._parsedEffortMap) curModel._parsedEffortMap = {};
        curModel._parsedEffortMap[ek] =
          lowerEv === "null" || lowerEv === "~" || rawEv === ""
            ? null
            : rawEv === "{}"
              ? ek
              : unquoteYaml(rawEv);
        if (ek !== "off" && lowerEv !== "null" && !curModel._parsedEfforts.includes(ek)) {
          curModel._parsedEfforts.push(ek);
        }
      }
      continue;
    }

    const mkv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mkv) {
      const [, k, v] = mkv;
      if (k === "name" && v) curModel.name = unquoteYaml(v);
      else if (k === "contextWindow" && v) curModel.contextWindow = Number(v) || curModel.contextWindow;
      else if (k === "maxTokens" && v) curModel.maxTokens = Number(v) || curModel.maxTokens;
      else if (k === "input") {
        const inlineArr = v.match(/^\[(.*)\]$/);
        if (inlineArr) {
          curModel._parsedInputs = inlineArr[1]
            .split(",")
            .map((s) => unquoteYaml(s).toLowerCase())
            .filter(Boolean);
        } else {
          inInputs = true;
          inputsIndent = indent;
          curModel._parsedInputs = [];
        }
      } else if (k === "reasoningEfforts") {
        inEfforts = true;
        effortsIndent = indent;
        curModel._parsedEfforts = [];
        curModel._parsedEffortMap = {};
      }
    }
  }

  for (const p of providers) {
    for (const m of p.models) {
      m.providerLabel = p.displayName || p.key;
      if (Array.isArray(m._parsedEfforts) && m._parsedEfforts.length > 0) {
        m.efforts = m._parsedEfforts;
      }
      if (m._parsedEffortMap && Object.keys(m._parsedEffortMap).length > 0) {
        m.effortMap = m._parsedEffortMap;
      }
      if (Array.isArray(m._parsedInputs) && m._parsedInputs.length > 0) {
        m.inputs = m._parsedInputs;
      }
      delete m._parsedEfforts;
      delete m._parsedEffortMap;
      delete m._parsedInputs;
    }
  }
  return providers.filter((p) => p.models.length > 0);
}

/**
 * Collect all DSH providers & models from plugin `mode_a_patch.yml` and (optionally)
 * DSH desktop `cordis.patch.yml` (read-only). Plugin patch takes priority on duplicate provider keys.
 */
export function discoverProviders({ pluginRoot, scanDesktop = true } = {}) {
  const byKey = new Map();

  const mergeFile = (fp, source) => {
    if (!fp || !fs.existsSync(fp)) return;
    try {
      const parsed = parseProvidersFromYaml(fs.readFileSync(fp, "utf8"));
      for (const p of parsed) {
        if (!byKey.has(p.key)) {
          byKey.set(p.key, { ...p, source });
        } else {
          // Merge any missing models from desktop into existing provider
          const existing = byKey.get(p.key);
          const seenIds = new Set(existing.models.map((m) => m.id));
          for (const m of p.models) {
            if (!seenIds.has(m.id)) {
              existing.models.push({ ...m, providerLabel: existing.displayName });
            }
          }
        }
      }
    } catch {
      // ignore unreadable yaml
    }
  };

  mergeFile(resolveBasePatch(pluginRoot), "plugin");
  if (scanDesktop) {
    mergeFile(resolveDesktopPatch(), "desktop");
  }

  return Array.from(byKey.values());
}

export function detect({ pluginRoot, scanDesktop = true } = {}) {
  const spec = resolveCommand();
  if (!spec) {
    return {
      id,
      label,
      installed: false,
      command: null,
      detail: "dsh not found on PATH (set ALILAS_DSH_BIN to override)",
      providers: [],
      models: [],
    };
  }
  const providers = discoverProviders({ pluginRoot, scanDesktop });
  const models = [];
  for (const p of providers) {
    for (const m of p.models) {
      models.push({
        ...m,
        compositeId: `${p.key}/${m.id}`,
      });
    }
  }
  return {
    id,
    label,
    installed: true,
    command: spec.display,
    detail: providers.length
      ? `${providers.length} 上游 · ${models.length} 模型`
      : "Ready (Mode A headless)",
    providers,
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
 * Resolve composite DSH model reference (`providerKey/modelId` or bare `modelId`)
 * against discovered providers so selecting ANY desktop upstream model works seamlessly in Mode A.
 */
function resolveDiscoveredModel({ pluginRoot, model, provider }) {
  if (!model) return null;
  const providers = discoverProviders({ pluginRoot, scanDesktop: true });

  // Support `providerKey::modelId` or `providerKey/modelId` ONLY when prefix matches a known provider key
  let reqProv = provider || "";
  let reqModel = model;
  if (!reqProv && model.includes("/")) {
    const firstSlash = model.indexOf("/");
    const candidateProv = model.slice(0, firstSlash);
    if (providers.some((p) => p.key === candidateProv)) {
      reqProv = candidateProv;
      reqModel = model.slice(firstSlash + 1);
    }
  }

  for (const p of providers) {
    if (reqProv && p.key !== reqProv) continue;
    const found = p.models.find((m) => m.id === reqModel);
    if (found) {
      return {
        provider: p.key,
        name: found.name || found.id,
        apiKeyEnv: p.apiKeyEnv,
        api: p.api || "openai-responses",
        baseURL: p.baseURL,
        model: found.id,
        contextWindow: found.contextWindow || 200_000,
        maxTokens: found.maxTokens || 64_000,
        inputs: Array.isArray(found.inputs) && found.inputs.length ? found.inputs : ["text", "image"],
        effortMap: found.effortMap || null,
      };
    }
  }
  return null;
}

/**
 * Per-run temporary YAML patch overlay so concurrent sessions can freely run different models
 * or any discovered DSH desktop upstream with ZERO conflict on shared config files.
 */
function writePerRunModelPatch({ dataDir, pluginRoot, runId, model, effort, profile, permissionMode }) {
  const resolved = profile?.baseURL
    ? profile
    : resolveDiscoveredModel({ pluginRoot, model, provider: profile?.provider });

  const isReadonly = permissionMode === "readonly";
  if (!model && !effort && !resolved && !isReadonly) return "";
  const entries = [];

  if (resolved?.baseURL && resolved?.provider && resolved?.model) {
    const inputs =
      Array.isArray(resolved.inputs) && resolved.inputs.length ? resolved.inputs : ["text", "image"];
    const effortMap =
      resolved.effortMap && Object.keys(resolved.effortMap).length
        ? resolved.effortMap
        : { off: null, low: "low", medium: "medium", high: "high" };
    const effortLines = Object.entries(effortMap).map(([k, v]) =>
      v === null ? `              ${k}: null` : `              ${k}: ${JSON.stringify(v)}`,
    );
    entries.push(
      `- id: credentials\n  disabled: false`,
      `- id: tool-result-pruner\n  disabled: true`,
      [
        `- id: llm-pi-ai`,
        `  name: "@deepseek-ai/dsh-llm-pi-ai"`,
        `  config:`,
        `    providers:`,
        `      ${resolved.provider}:`,
        ...(resolved.apiKeyEnv ? [`        apiKeyEnv: ${resolved.apiKeyEnv}`] : []),
        `        api: ${resolved.api || "openai-responses"}`,
        `        baseURL: ${JSON.stringify(resolved.baseURL)}`,
        `        displayName: ${JSON.stringify(resolved.name || resolved.provider)}`,
        `        models:`,
        `          - id: ${JSON.stringify(resolved.model)}`,
        `            name: ${JSON.stringify(resolved.name || resolved.model)}`,
        `            contextWindow: ${Number(resolved.contextWindow) || 200_000}`,
        `            maxTokens: ${Number(resolved.maxTokens) || 64_000}`,
        `            input:`,
        ...inputs.map((inp) => `              - ${inp}`),
        `            reasoningEfforts:`,
        ...effortLines,
      ].join("\n"),
    );
  }

  const targetProvider = resolved?.provider || profile?.provider || undefined;
  const targetModel = resolved?.model || profile?.model || model || undefined;
  const targetEffort = effort || profile?.effort || undefined;

  if (targetModel || targetProvider || targetEffort) {
    const cfgLines = [
      `- id: agent-default-model`,
      `  name: "@deepseek-ai/dsh-agent-default-model"`,
      `  config:`,
    ];
    if (targetProvider) cfgLines.push(`    provider: ${JSON.stringify(targetProvider)}`);
    if (targetModel) cfgLines.push(`    model: ${JSON.stringify(targetModel)}`);
    if (targetEffort && ["off", "low", "medium", "high", "xhigh", "max"].includes(targetEffort)) {
      cfgLines.push(`    reasoningEffort: ${targetEffort === "off" ? "null" : targetEffort}`);
    }
    entries.push(cfgLines.join("\n"));
  }

  if (isReadonly) {
    entries.push(
      [
        `- id: sandbox-policy`,
        `  name: "@deepseek-ai/dsh-sandbox-policy"`,
        `  config:`,
        `    mode: "read-only"`,
      ].join("\n"),
      [
        `- id: approval`,
        `  name: "@deepseek-ai/dsh-user-approval"`,
        `  config:`,
        `    policy: "never"`,
      ].join("\n"),
    );
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
  permissionMode = "auto",
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

  const perRunPatch = writePerRunModelPatch({
    dataDir,
    pluginRoot,
    runId,
    model,
    effort,
    profile,
    permissionMode,
  });
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

  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  if (permissionMode === "readonly") {
    env.DSH_PERMISSION_MODE = "read-only";
  }

  return {
    cmd: spec.cmd,
    args,
    cwd,
    env,
    stdinText: task,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(spec.cmd),
    cleanupPaths,
  };
}

export function createParser(emit) {
  let rootSessionId = null;
  let currentStep = 0;
  let stepStartAt = null;
  const emittedUsageSteps = new Set();
  const openToolStarts = new Map();

  function emitUsageOnce(stepKey, usage, durSec) {
    if (!usage) return;
    if (emittedUsageSteps.has(stepKey)) return;
    emittedUsageSteps.add(stepKey);
    emit({ type: "usage", usage, durationSec: durSec });
  }

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
          emitUsageOnce(`${ev.turn || 1}:${currentStep}`, usage, durSec);
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
            emitUsageOnce(`${ev.turn || 1}:${currentStep}`, usage, durSec);
          }
        } catch {
          // ignore
        }
      } else if (rawLine.trim()) {
        emit({ type: "stderr", text: rawLine });
      }
    },

    flush() {},
  };
}
