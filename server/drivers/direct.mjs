import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "direct_worker.mjs");

export const id = "direct";
export const label = "Direct API (无注入直连)";

export function detect({ customProfiles = [] } = {}) {
  const directProfiles = customProfiles.filter((p) => !p.driver || p.driver === "direct");
  return {
    id,
    label,
    installed: true,
    command: "node (built-in SSE worker)",
    detail: directProfiles.length
      ? `${directProfiles.length} 个直连模型 · 零外部 CLI / 零第三方注入`
      : "内置纯净直连引擎（填 URL + 环境变量 Key + 协议即可用）",
    models: directProfiles.map((p) => ({
      id: p.id,
      name: p.name || p.model,
      model: p.model,
      api: p.api || "openai-completions",
      baseURL: p.baseURL,
      apiKeyEnv: p.apiKeyEnv,
      contextWindow: p.contextWindow || 200_000,
      maxTokens: p.maxTokens || 64_000,
      inputs: Array.isArray(p.inputs) && p.inputs.length ? p.inputs : ["text"],
      efforts: ["off", "low", "medium", "high"],
    })),
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
  dataDir,
}) {
  if (!profile?.baseURL || !(profile?.model || model)) {
    throw new Error("直连 API 引擎需要配置完整的自定义模型预设（Base URL 与模型 ID）");
  }
  const sid = sessionId || `direct-${crypto.randomUUID().slice(0, 12)}`;
  const historyPath = path.join(dataDir, "direct_sessions", `${sid}.json`);
  const payload = {
    sessionId: sid,
    cwd,
    task,
    baseURL: profile.baseURL,
    apiKeyEnv: profile.apiKeyEnv || "",
    api: profile.api || "openai-completions",
    model: profile.model || model,
    effort: effort || profile.effort || "high",
    maxTokens: Number(profile.maxTokens) || 64_000,
    inputs: Array.isArray(profile.inputs) && profile.inputs.length ? profile.inputs : ["text"],
    permissionMode,
    historyPath,
  };

  return {
    cmd: process.execPath,
    args: [WORKER_PATH],
    cwd,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdinText: JSON.stringify(payload),
    shell: false,
    cleanupPaths: [],
  };
}

export function createParser(emit) {
  return {
    onStdoutLine(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev && typeof ev === "object" && ev.type) {
        emit(ev);
      }
    },
    onStderrLine(line) {
      if (line.trim()) emit({ type: "stderr", text: line });
    },
    flush() {},
  };
}
