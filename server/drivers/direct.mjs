import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inferContextWindow } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "direct_worker.mjs");

export const id = "direct";
export const label = "Direct API (无注入直连)";

const KNOWN_EFFORT_ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

function normalizeBaseUrl(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

function buildEndpointUrl(baseURL, suffix) {
  const clean = normalizeBaseUrl(baseURL);
  if (suffix === "/v1/messages") {
    if (clean.endsWith("/v1")) return `${clean}/messages`;
    if (clean.endsWith("/messages")) return clean;
    return `${clean}/v1/messages`;
  }
  if (suffix === "/models") {
    if (clean.endsWith("/models")) return clean;
    return `${clean}/models`;
  }
  if (clean.endsWith(suffix)) return clean;
  return `${clean}${suffix}`;
}

/**
 * Infer sensible default reasoning effort mappings for well-known model families
 * when an upstream `/models` endpoint does not explicitly advertise `supported_reasoning_efforts`.
 */
export function knownEffortsForModel(modelId, api = "openai-completions") {
  const raw = String(modelId || "").trim().toLowerCase();
  const base = raw
    .replace(/^[^/:]+[/:]/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");

  const anthropicBudgets = { off: "", low: "2048", medium: "6144", high: "12288", max: "24576" };
  const makeMap = (keys) => {
    const map = {};
    for (const k of keys) {
      map[k] = k === "off" || k === "none" ? (k === "none" ? "none" : "") : k;
    }
    return map;
  };

  if (/^gpt-6(?:\.\d+)?-(?:astra|sol)$/.test(base)) {
    return { reasoningEnabled: true, effortMap: makeMap(["low", "medium", "high", "xhigh", "max"]), defaultEffort: "high" };
  }
  if (/^(?:gpt-6(?:\.\d+)?-(?:terra|luna)|gpt-5\.6(?:-(?:sol|terra|luna))?)$/.test(base)) {
    return { reasoningEnabled: true, effortMap: makeMap(["none", "low", "medium", "high", "xhigh", "max"]), defaultEffort: "high" };
  }
  if (/^gpt-5\.[245]/.test(base)) {
    return { reasoningEnabled: true, effortMap: makeMap(["none", "low", "medium", "high", "xhigh"]), defaultEffort: "high" };
  }
  if (/^gpt-5(?:-(?:mini|nano))?$/.test(base)) {
    return { reasoningEnabled: true, effortMap: makeMap(["minimal", "low", "medium", "high"]), defaultEffort: "high" };
  }
  if (/^o[134](?:-mini|-pro)?/.test(base)) {
    return { reasoningEnabled: true, effortMap: makeMap(["low", "medium", "high"]), defaultEffort: "high" };
  }
  if (/claude/.test(base)) {
    if (api === "anthropic-messages") {
      return { reasoningEnabled: true, effortMap: anthropicBudgets, defaultEffort: "high" };
    }
    return { reasoningEnabled: true, effortMap: makeMap(["off", "low", "medium", "high", "max"]), defaultEffort: "high" };
  }
  if (/deepseek|qwq|r1|thinking|reasoner|kimi-k2|gemini-2\.5|gemini-3|gemini-4/.test(base)) {
    if (api === "anthropic-messages") {
      return { reasoningEnabled: true, effortMap: anthropicBudgets, defaultEffort: "high" };
    }
    return { reasoningEnabled: true, effortMap: makeMap(["off", "low", "medium", "high"]), defaultEffort: "high" };
  }
  // Plain non-reasoning models (e.g., gpt-4o, llama-3, mistral): default reasoning OFF so we never send unsupported fields
  if (/gpt-4|gpt-3\.5|llama|mistral|mixtral|embed|whisper|tts|dall-e|image|moderation/.test(base)) {
    return { reasoningEnabled: false, effortMap: {}, defaultEffort: "" };
  }
  return {
    reasoningEnabled: true,
    effortMap: api === "anthropic-messages" ? anthropicBudgets : makeMap(["off", "low", "medium", "high"]),
    defaultEffort: "high",
  };
}

function buildEffortMapFromUpstream(rawList, api) {
  if (!Array.isArray(rawList) || rawList.length === 0) return null;
  const clean = [];
  for (const item of rawList) {
    const s = String(item || "").trim();
    if (s && !clean.includes(s)) clean.push(s);
  }
  if (!clean.length) return null;
  clean.sort((a, b) => {
    const ia = KNOWN_EFFORT_ORDER.indexOf(a.toLowerCase());
    const ib = KNOWN_EFFORT_ORDER.indexOf(b.toLowerCase());
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
  const anthropicDefaults = { off: "", none: "", minimal: "1024", low: "2048", medium: "6144", high: "12288", xhigh: "16384", max: "24576" };
  const map = {};
  for (const k of clean) {
    const lower = k.toLowerCase();
    if (api === "anthropic-messages") {
      map[k] = anthropicDefaults[lower] ?? k;
    } else {
      map[k] = lower === "off" ? "" : k;
    }
  }
  return map;
}

function resolveApiKey(apiKeyEnv) {
  const envName = String(apiKeyEnv || "").trim();
  if (!envName) return { envName: "", apiKey: "" };
  return { envName, apiKey: process.env[envName] || "" };
}

/**
 * Query upstream `GET /models` using server-side env credential (never receives plaintext key from UI).
 * Extracts real context window & supported reasoning efforts where advertised.
 */
export async function discoverDirectModels({ baseURL, apiKeyEnv = "", api = "openai-completions" }) {
  const cleanBase = normalizeBaseUrl(baseURL);
  if (!cleanBase) throw new Error("请先填写 Base URL");
  const { envName, apiKey } = resolveApiKey(apiKeyEnv);
  if (envName && !apiKey) {
    throw new Error(`未在环境变量中找到 ${envName}，请先在系统环境或 mcp_config.json 中配置`);
  }

  const url =
    api === "anthropic-messages" && !cleanBase.endsWith("/v1") && !cleanBase.endsWith("/models")
      ? `${cleanBase}/v1/models`
      : buildEndpointUrl(cleanBase, "/models");

  const headers = { accept: "application/json" };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`获取模型失败 (HTTP ${res.status}): ${errBody.slice(0, 220)}`);
  }
  const json = await res.json().catch(() => null);
  const rawList = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
  if (!rawList) {
    throw new Error("上游返回的 /models 响应格式不受支持（缺少 data 数组）");
  }

  const seen = new Map();
  for (const m of rawList) {
    const mid = String(m?.id || m?.slug || "").trim();
    if (!mid || mid.length > 200 || seen.has(mid)) continue;
    const cwRaw = m.context_window ?? m.context_length ?? m.max_context_length;
    const contextWindow =
      Number.isInteger(cwRaw) && cwRaw > 0 ? cwRaw : inferContextWindow(mid, 200_000);
    const maxRaw = m.max_output_tokens ?? m.max_tokens;
    const maxTokens = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : 64_000;
    const upstreamEfforts = m.supported_reasoning_efforts ?? m.reasoning_efforts;
    const upMap = buildEffortMapFromUpstream(upstreamEfforts, api);
    const fallback = knownEffortsForModel(mid, api);
    const reasoningEnabled = upMap ? true : fallback.reasoningEnabled;
    const effortMap = upMap || fallback.effortMap;
    const effortKeys = Object.keys(effortMap);
    const defaultEffort = !reasoningEnabled
      ? ""
      : effortKeys.includes("high")
        ? "high"
        : effortKeys.find((k) => k !== "off" && k !== "none") || effortKeys[0] || "";

    seen.set(mid, {
      id: mid,
      name: String(m.display_name || m.name || mid).trim().slice(0, 80),
      contextWindow,
      maxTokens,
      reasoningEnabled,
      effortMap,
      efforts: reasoningEnabled ? effortKeys : [],
      defaultEffort,
    });
  }

  const models = Array.from(seen.values()).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  return { ok: true, count: models.length, models };
}

/**
 * Lightweight 2-turn tool-calling round-trip probe across all 3 Direct API protocols.
 * Verifies the target model actually emits a tool call AND faithfully reads back the tool result.
 */
export async function probeDirectTools({
  baseURL,
  apiKeyEnv = "",
  api = "openai-completions",
  model,
  maxTokens = 1024,
  reasoningEnabled = false,
  effort = "",
  effortMap = null,
}) {
  const cleanBase = normalizeBaseUrl(baseURL);
  if (!cleanBase || !model) {
    return { ok: false, durationMs: 0, message: "请先填写 Base URL 和模型 ID" };
  }
  const { envName, apiKey } = resolveApiKey(apiKeyEnv);
  if (envName && !apiKey) {
    return { ok: false, durationMs: 0, message: `未找到环境变量 ${envName}` };
  }

  const startedAt = Date.now();
  const sample = `alilas-probe-${crypto.randomBytes(5).toString("hex")}`;
  const prompt = "Call the read_sample tool with empty arguments, then reply with ONLY the exact token returned by read_sample.";

  try {
    if (api === "anthropic-messages") {
      const url = buildEndpointUrl(cleanBase, "/v1/messages");
      const headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      };
      const toolDef = {
        name: "read_sample",
        description: "Return the probe verification token.",
        input_schema: { type: "object", properties: {} },
      };
      const res1 = await fetch(url, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          model,
          max_tokens: Math.min(Math.max(Number(maxTokens) || 1024, 512), 2048),
          messages: [{ role: "user", content: prompt }],
          tools: [toolDef],
          tool_choice: { type: "tool", name: "read_sample" },
        }),
      });
      if (!res1.ok) {
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          message: `第 1 轮请求失败 (HTTP ${res1.status}): ${(await res1.text()).slice(0, 200)}`,
        };
      }
      const d1 = await res1.json();
      const blocks1 = Array.isArray(d1?.content) ? d1.content : [];
      const tu = blocks1.find((b) => b.type === "tool_use" && b.name === "read_sample");
      if (!tu) {
        return { ok: false, durationMs: Date.now() - startedAt, message: "模型未正确触发 read_sample 工具调用" };
      }

      const res2 = await fetch(url, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          model,
          max_tokens: Math.min(Math.max(Number(maxTokens) || 1024, 512), 2048),
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: blocks1 },
            { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: sample }] },
          ],
          tools: [toolDef],
        }),
      });
      if (!res2.ok) {
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          message: `第 2 轮工具回传失败 (HTTP ${res2.status}): ${(await res2.text()).slice(0, 200)}`,
        };
      }
      const d2 = await res2.json();
      const reply = (d2?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const dur = Date.now() - startedAt;
      return reply.includes(sample)
        ? { ok: true, durationMs: dur, message: `工具调用与结果回传正常 (${(dur / 1000).toFixed(1)}s)` }
        : { ok: false, durationMs: dur, message: `模型未正确读取工具返回值（回复: ${reply.slice(0, 80)}）` };
    }

    if (api === "openai-responses") {
      const url = buildEndpointUrl(cleanBase, "/responses");
      const headers = {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      const toolDef = {
        type: "function",
        name: "read_sample",
        description: "Return the probe verification token.",
        parameters: { type: "object", properties: {} },
      };
      const baseReq = { model, tools: [toolDef] };
      if (reasoningEnabled && effort) {
        const mapped = effortMap && Object.prototype.hasOwnProperty.call(effortMap, effort) ? effortMap[effort] : effort;
        if (mapped && mapped !== "off") baseReq.reasoning = { effort: mapped };
      }

      const res1 = await fetch(url, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          ...baseReq,
          input: [{ role: "user", content: prompt }],
          tool_choice: { type: "function", name: "read_sample" },
        }),
      });
      if (!res1.ok) {
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          message: `第 1 轮请求失败 (HTTP ${res1.status}): ${(await res1.text()).slice(0, 200)}`,
        };
      }
      const d1 = await res1.json();
      const outItems = Array.isArray(d1?.output) ? d1.output : [];
      const fc = outItems.find((it) => it.type === "function_call" && it.name === "read_sample");
      if (!fc) {
        return { ok: false, durationMs: Date.now() - startedAt, message: "模型未正确触发 read_sample 工具调用" };
      }

      const res2 = await fetch(url, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          ...baseReq,
          input: [
            { role: "user", content: prompt },
            ...outItems.filter((it) => it.type === "reasoning" || it.type === "function_call" || it.type === "message"),
            { type: "function_call_output", call_id: fc.call_id || fc.id, output: sample },
          ],
          tool_choice: "none",
        }),
      });
      if (!res2.ok) {
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          message: `第 2 轮工具回传失败 (HTTP ${res2.status}): ${(await res2.text()).slice(0, 200)}`,
        };
      }
      const d2 = await res2.json();
      const reply =
        d2?.output_text ||
        (d2?.output || [])
          .flatMap((it) => (it.type === "message" ? it.content || [] : []))
          .map((c) => c.text || "")
          .join("");
      const dur = Date.now() - startedAt;
      return reply.includes(sample)
        ? { ok: true, durationMs: dur, message: `工具调用与结果回传正常 (${(dur / 1000).toFixed(1)}s)` }
        : { ok: false, durationMs: dur, message: `模型未正确读取工具返回值（回复: ${reply.slice(0, 80)}）` };
    }

    // Default: OpenAI Chat Completions
    const url = buildEndpointUrl(cleanBase, "/chat/completions");
    const headers = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const toolDef = {
      type: "function",
      function: {
        name: "read_sample",
        description: "Return the probe verification token.",
        parameters: { type: "object", properties: {} },
      },
    };
    const extraEffort = {};
    if (reasoningEnabled && effort) {
      const mapped = effortMap && Object.prototype.hasOwnProperty.call(effortMap, effort) ? effortMap[effort] : effort;
      if (mapped && mapped !== "off") extraEffort.reasoning_effort = mapped;
    }

    const res1 = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        tools: [toolDef],
        tool_choice: { type: "function", function: { name: "read_sample" } },
        ...extraEffort,
      }),
    });
    if (!res1.ok) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        message: `第 1 轮请求失败 (HTTP ${res1.status}): ${(await res1.text()).slice(0, 200)}`,
      };
    }
    const d1 = await res1.json();
    const msg1 = d1?.choices?.[0]?.message;
    const tc = msg1?.tool_calls?.find((t) => t.function?.name === "read_sample");
    if (!tc) {
      return { ok: false, durationMs: Date.now() - startedAt, message: "模型未正确触发 read_sample 工具调用" };
    }

    const assistantTurn = {
      role: "assistant",
      content: msg1.content ?? null,
      tool_calls: msg1.tool_calls,
      ...(msg1.reasoning_content ? { reasoning_content: msg1.reasoning_content } : {}),
    };
    const res2 = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: prompt },
          assistantTurn,
          { role: "tool", tool_call_id: tc.id, content: sample },
        ],
        tools: [toolDef],
        tool_choice: "none",
        ...extraEffort,
      }),
    });
    if (!res2.ok) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        message: `第 2 轮工具回传失败 (HTTP ${res2.status}): ${(await res2.text()).slice(0, 200)}`,
      };
    }
    const d2 = await res2.json();
    const reply = d2?.choices?.[0]?.message?.content || "";
    const dur = Date.now() - startedAt;
    return reply.includes(sample)
      ? { ok: true, durationMs: dur, message: `工具调用与结果回传正常 (${(dur / 1000).toFixed(1)}s)` }
      : { ok: false, durationMs: dur, message: `模型未正确读取工具返回值（回复: ${String(reply).slice(0, 80)}）` };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      message: `探针异常: ${e?.message || String(e)}`,
    };
  }
}

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
    models: directProfiles.map((p) => {
      const reasoningEnabled = p.reasoningEnabled !== false;
      const effortMap =
        p.effortMap && typeof p.effortMap === "object" && Object.keys(p.effortMap).length
          ? p.effortMap
          : reasoningEnabled
            ? { off: "", low: "low", medium: "medium", high: "high" }
            : {};
      return {
        id: p.id,
        name: p.name || p.model,
        model: p.model,
        api: p.api || "openai-completions",
        baseURL: p.baseURL,
        apiKeyEnv: p.apiKeyEnv,
        contextWindow: p.contextWindow || 200_000,
        maxTokens: p.maxTokens || 64_000,
        inputs: Array.isArray(p.inputs) && p.inputs.length ? p.inputs : ["text"],
        reasoningEnabled,
        effortMap,
        efforts: reasoningEnabled ? Object.keys(effortMap) : [],
      };
    }),
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
  const reasoningEnabled = profile.reasoningEnabled !== false;
  const effortMap =
    profile.effortMap && typeof profile.effortMap === "object" && Object.keys(profile.effortMap).length
      ? profile.effortMap
      : reasoningEnabled
        ? { off: "", low: "low", medium: "medium", high: "high" }
        : {};
  const payload = {
    sessionId: sid,
    cwd,
    task,
    baseURL: profile.baseURL,
    apiKeyEnv: profile.apiKeyEnv || "",
    api: profile.api || "openai-completions",
    model: profile.model || model,
    reasoningEnabled,
    effortMap,
    effort: reasoningEnabled ? (effort ?? profile.effort ?? "") : "",
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
