/**
 * ALilaS Direct API Headless Worker (zero external CLI, zero third-party agent injection).
 *
 * Reads a single JSON invocation payload from stdin, runs a clean streaming tool loop over
 * native Node 22 `fetch` supporting three protocols:
 *   - openai-completions  (/chat/completions)
 *   - openai-responses    (/responses)
 *   - anthropic-messages  (/v1/messages)
 *
 * Emits normalized NDJSON events on stdout for ALilaS MCP Server.
 * Never prints or persists raw API keys (resolved strictly from process.env[apiKeyEnv]).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_STEPS = 40;
const MAX_TOOL_OUTPUT = 16_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function emit(ev) {
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}

function resolveSafePath(cwd, inputPath) {
  if (!inputPath || typeof inputPath !== "string") return cwd;
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
}

function guessMime(fp) {
  const ext = path.extname(fp).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "";
}

function buildToolDefs({ readonly, supportsImage }) {
  const tools = [
    {
      name: "read_file",
      description: "Read a UTF-8 text file with optional 1-based line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path" },
          start_line: { type: "integer", description: "Optional 1-based start line" },
          end_line: { type: "integer", description: "Optional 1-based inclusive end line" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_dir",
      description: "List files and subdirectories inside a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (defaults to workspace root)" },
        },
      },
    },
    {
      name: "grep_search",
      description: "Search for a case-insensitive substring or regex pattern across files in a directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or plain text pattern" },
          path: { type: "string", description: "Target file or directory (defaults to workspace root)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "run_command",
      description: readonly
        ? "Run a read-only shell command (inspection/search/status only; mutations forbidden)."
        : "Execute a shell command inside the working directory and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command string to execute" },
        },
        required: ["command"],
      },
    },
  ];

  if (!readonly) {
    tools.push(
      {
        name: "edit_file",
        description: "Replace an exact text target in an existing file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            target: { type: "string", description: "Exact existing substring to replace" },
            replacement: { type: "string", description: "Replacement text" },
          },
          required: ["path", "target", "replacement"],
        },
      },
      {
        name: "write_file",
        description: "Create or overwrite a UTF-8 text file (creates parent directories automatically).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "Full file content" },
          },
          required: ["path", "content"],
        },
      },
    );
  }

  if (supportsImage) {
    tools.push({
      name: "read_image",
      description: "Inspect a local PNG/JPEG/WebP/GIF image file visually.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to image file" },
        },
        required: ["path"],
      },
    });
  }

  return tools;
}

function executeTool(name, args, { cwd, readonly, supportsImage }) {
  try {
    if (name === "read_file") {
      const fp = resolveSafePath(cwd, args.path);
      const raw = fs.readFileSync(fp, "utf8");
      const lines = raw.split(/\r?\n/);
      const s = Math.max(1, Number(args.start_line) || 1);
      const e = Math.min(lines.length, Number(args.end_line) || Math.min(lines.length, s + 399));
      const numbered = lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join("\n");
      return { text: numbered.slice(0, MAX_TOOL_OUTPUT), isError: false };
    }

    if (name === "list_dir") {
      const dir = resolveSafePath(cwd, args.path || ".");
      const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
      const out = entries.map((d) => `${d.isDirectory() ? "[DIR] " : "      "}${d.name}`).join("\n");
      return { text: out || "(empty directory)", isError: false };
    }

    if (name === "grep_search") {
      const target = resolveSafePath(cwd, args.path || ".");
      const re = new RegExp(args.pattern, "i");
      const hits = [];
      const walk = (p, depth) => {
        if (hits.length >= 80 || depth > 6) return;
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          return;
        }
        if (st.isDirectory()) {
          const base = path.basename(p);
          if (["node_modules", ".git", "dist", ".next", "build", "__pycache__"].includes(base)) return;
          for (const child of fs.readdirSync(p)) {
            walk(path.join(p, child), depth + 1);
            if (hits.length >= 80) break;
          }
        } else if (st.size < 512 * 1024) {
          try {
            const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                hits.push(`${path.relative(cwd, p)}:${i + 1}: ${lines[i].trim().slice(0, 180)}`);
                if (hits.length >= 80) break;
              }
            }
          } catch {
            // ignore binary/unreadable files
          }
        }
      };
      walk(target, 0);
      return { text: hits.length ? hits.join("\n") : "(no matches)", isError: false };
    }

    if (name === "edit_file") {
      if (readonly) return { text: "Error: edit_file is disabled in readonly mode.", isError: true };
      const fp = resolveSafePath(cwd, args.path);
      const raw = fs.readFileSync(fp, "utf8");
      if (!raw.includes(args.target)) {
        return { text: `Error: target text not found in ${fp}`, isError: true };
      }
      const next = raw.split(args.target).join(args.replacement ?? "");
      fs.writeFileSync(fp, next, "utf8");
      return { text: `Edited ${fp} successfully.`, isError: false };
    }

    if (name === "write_file") {
      if (readonly) return { text: "Error: write_file is disabled in readonly mode.", isError: true };
      const fp = resolveSafePath(cwd, args.path);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, String(args.content ?? ""), "utf8");
      return { text: `Wrote ${fp} (${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes).`, isError: false };
    }

    if (name === "read_image") {
      if (!supportsImage) {
        return { text: "Error: image input is disabled for this model profile.", isError: true };
      }
      const fp = resolveSafePath(cwd, args.path);
      const st = fs.statSync(fp);
      if (st.size > MAX_IMAGE_BYTES) {
        return { text: `Error: image exceeds 6MB limit (${st.size} bytes).`, isError: true };
      }
      const mime = guessMime(fp);
      if (!mime) return { text: `Error: unsupported image extension for ${fp}`, isError: true };
      const b64 = fs.readFileSync(fp).toString("base64");
      return {
        text: `Loaded image ${path.basename(fp)} (${mime}, ${st.size} bytes).`,
        image: { mime, base64: b64 },
        isError: false,
      };
    }

    if (name === "run_command") {
      const cmdStr = String(args.command || "").trim();
      if (!cmdStr) return { text: "Error: empty command", isError: true };
      if (readonly && /\b(rm|del|rmdir|remove-item|move-item|mv|cp|copy-item|set-content|out-file|git\s+(commit|push|reset|checkout|clean)|npm\s+install)\b/i.test(cmdStr)) {
        return { text: "Error: mutating command blocked in readonly mode.", isError: true };
      }
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const out = execSync(cmdStr, {
        cwd,
        shell,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { text: (out || "(no output)").slice(0, MAX_TOOL_OUTPUT), isError: false };
    }

    return { text: `Error: unknown tool '${name}'`, isError: true };
  } catch (e) {
    const out = [e.message, e.stdout, e.stderr].filter(Boolean).join("\n").slice(0, MAX_TOOL_OUTPUT);
    return { text: out || String(e), isError: true };
  }
}

async function* iterateSseEvents(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let eventName = "";
  let dataLines = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") {
        if (dataLines.length > 0) {
          yield { event: eventName, data: dataLines.join("\n") };
        }
        eventName = "";
        dataLines = [];
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  if (dataLines.length > 0) {
    yield { event: eventName, data: dataLines.join("\n") };
  }
}

function buildUrl(baseURL, suffix) {
  const clean = String(baseURL || "").trim().replace(/\/+$/, "");
  if (suffix === "/v1/messages") {
    if (clean.endsWith("/v1")) return `${clean}/messages`;
    if (clean.endsWith("/messages")) return clean;
    return `${clean}/v1/messages`;
  }
  if (clean.endsWith(suffix)) return clean;
  return `${clean}${suffix}`;
}

// ---------------------------------------------------------------- Protocol 1: OpenAI Chat Completions

async function callOpenAICompletions({ baseURL, apiKey, model, effort, maxTokens, systemPrompt, history, tools, step }) {
  const messages = [{ role: "system", content: systemPrompt }];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.text || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
      messages.push(msg);
    } else if (m.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: m.callId,
        content: m.text || "",
      });
      if (m.image) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: `[Image from read_image tool for call ${m.callId}]` },
            { type: "image_url", image_url: { url: `data:${m.image.mime};base64,${m.image.base64}` } },
          ],
        });
      }
    }
  }

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (effort && ["low", "medium", "high"].includes(effort)) {
    body.reasoning_effort = effort;
  }

  const res = await fetch(buildUrl(baseURL, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  let reasoning = "";
  let text = "";
  let usage = null;
  const tcMap = new Map();

  for await (const sse of iterateSseEvents(res)) {
    if (sse.data === "[DONE]") break;
    let obj;
    try {
      obj = JSON.parse(sse.data);
    } catch {
      continue;
    }
    if (obj.usage) {
      const cached = obj.usage.prompt_tokens_details?.cached_tokens ?? obj.usage.prompt_cache_hit_tokens ?? 0;
      const rawPrompt = obj.usage.prompt_tokens ?? 0;
      const out = obj.usage.completion_tokens ?? 0;
      const rTok = obj.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      usage = {
        inputTokens: Math.max(0, rawPrompt - cached),
        cacheReadTokens: cached,
        outputTokens: out,
        thinkingTokens: rTok,
        totalTokens: obj.usage.total_tokens ?? rawPrompt + out,
      };
    }
    const delta = obj.choices?.[0]?.delta;
    if (!delta) continue;
    const rDelta = delta.reasoning_content || delta.reasoning || "";
    if (rDelta) {
      reasoning += rDelta;
      emit({ type: "reasoning_delta", step, text: rDelta });
    }
    if (delta.content) {
      text += delta.content;
      emit({ type: "text_delta", step, text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!tcMap.has(idx)) {
          tcMap.set(idx, { id: tc.id || `call_${step}_${idx}`, name: "", argsStr: "" });
        }
        const slot = tcMap.get(idx);
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.argsStr += tc.function.arguments;
      }
    }
  }

  const toolCalls = Array.from(tcMap.values()).map((tc) => {
    let args = {};
    try {
      args = tc.argsStr ? JSON.parse(tc.argsStr) : {};
    } catch {
      args = { raw: tc.argsStr };
    }
    return { id: tc.id, name: tc.name, args };
  });

  return { reasoning, text, toolCalls, usage };
}

// ---------------------------------------------------------------- Protocol 2: OpenAI Responses

async function callOpenAIResponses({ baseURL, apiKey, model, effort, maxTokens, systemPrompt, history, tools, step }) {
  const input = [];
  for (const m of history) {
    if (m.role === "user") {
      input.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      if (m.text) {
        input.push({ role: "assistant", content: m.text });
      }
      for (const tc of m.toolCalls || []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.args ?? {}),
        });
      }
    } else if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.callId,
        output: m.text || "",
      });
      if (m.image) {
        input.push({
          role: "user",
          content: [
            { type: "input_text", text: `[Image from read_image tool for call ${m.callId}]` },
            { type: "input_image", image_url: `data:${m.image.mime};base64,${m.image.base64}` },
          ],
        });
      }
    }
  }

  const body = {
    model,
    instructions: systemPrompt,
    input,
    stream: true,
    tools: tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
  if (maxTokens) body.max_output_tokens = maxTokens;
  if (effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
    body.reasoning = { effort };
  }

  const res = await fetch(buildUrl(baseURL, "/responses"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  let reasoning = "";
  let text = "";
  let usage = null;
  const fcByItemId = new Map();

  for await (const sse of iterateSseEvents(res)) {
    if (sse.data === "[DONE]") break;
    let obj;
    try {
      obj = JSON.parse(sse.data);
    } catch {
      continue;
    }
    const evType = obj.type || sse.event;
    if (
      (evType === "response.reasoning_summary_text.delta" || evType === "response.reasoning_text.delta") &&
      typeof obj.delta === "string"
    ) {
      reasoning += obj.delta;
      emit({ type: "reasoning_delta", step, text: obj.delta });
    } else if (evType === "response.output_text.delta" && typeof obj.delta === "string") {
      text += obj.delta;
      emit({ type: "text_delta", step, text: obj.delta });
    } else if (evType === "response.output_item.added" && obj.item?.type === "function_call") {
      fcByItemId.set(obj.item.id || obj.item.call_id, {
        id: obj.item.call_id || obj.item.id || `call_${step}_${fcByItemId.size}`,
        name: obj.item.name || "",
        argsStr: obj.item.arguments || "",
      });
    } else if (evType === "response.function_call_arguments.delta" && typeof obj.delta === "string") {
      const slot = fcByItemId.get(obj.item_id);
      if (slot) slot.argsStr += obj.delta;
    } else if (evType === "response.output_item.done" && obj.item?.type === "function_call") {
      const key = obj.item.id || obj.item.call_id;
      fcByItemId.set(key, {
        id: obj.item.call_id || obj.item.id || `call_${step}_${fcByItemId.size}`,
        name: obj.item.name || "",
        argsStr: obj.item.arguments || fcByItemId.get(key)?.argsStr || "",
      });
    } else if (evType === "response.completed" && obj.response?.usage) {
      const u = obj.response.usage;
      const rawIn = u.input_tokens ?? 0;
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      const out = u.output_tokens ?? 0;
      const rTok = u.output_tokens_details?.reasoning_tokens ?? 0;
      usage = {
        inputTokens: Math.max(0, rawIn - cached),
        cacheReadTokens: cached,
        outputTokens: out,
        thinkingTokens: rTok,
        totalTokens: u.total_tokens ?? rawIn + out,
      };
    }
  }

  const toolCalls = Array.from(fcByItemId.values()).map((tc) => {
    let args = {};
    try {
      args = tc.argsStr ? JSON.parse(tc.argsStr) : {};
    } catch {
      args = { raw: tc.argsStr };
    }
    return { id: tc.id, name: tc.name, args };
  });

  return { reasoning, text, toolCalls, usage };
}

// ---------------------------------------------------------------- Protocol 3: Anthropic Messages

async function callAnthropicMessages({ baseURL, apiKey, model, effort, maxTokens, systemPrompt, history, tools, step }) {
  const messages = [];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls || []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const blockContent = [{ type: "text", text: m.text || "" }];
      if (m.image) {
        blockContent.push({
          type: "image",
          source: { type: "base64", media_type: m.image.mime, data: m.image.base64 },
        });
      }
      const prev = messages[messages.length - 1];
      const trBlock = {
        type: "tool_result",
        tool_use_id: m.callId,
        content: blockContent,
        ...(m.isError ? { is_error: true } : {}),
      };
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content[0]?.type === "tool_result") {
        prev.content.push(trBlock);
      } else {
        messages.push({ role: "user", content: [trBlock] });
      }
    }
  }

  const budgetMap = { low: 2048, medium: 6144, high: 12288, max: 24576 };
  const body = {
    model,
    system: systemPrompt,
    messages,
    max_tokens: maxTokens || 8192,
    stream: true,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
  };
  if (effort && budgetMap[effort] && body.max_tokens > budgetMap[effort]) {
    body.thinking = { type: "enabled", budget_tokens: budgetMap[effort] };
  }

  const res = await fetch(buildUrl(baseURL, "/v1/messages"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  let reasoning = "";
  let text = "";
  const rawUsage = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
  const blocks = new Map();

  for await (const sse of iterateSseEvents(res)) {
    let obj;
    try {
      obj = JSON.parse(sse.data);
    } catch {
      continue;
    }
    const evType = obj.type || sse.event;
    if (evType === "message_start" && obj.message?.usage) {
      const u = obj.message.usage;
      rawUsage.input = u.input_tokens ?? 0;
      rawUsage.cacheRead = u.cache_read_input_tokens ?? 0;
      rawUsage.cacheCreate = u.cache_creation_input_tokens ?? 0;
      rawUsage.output = u.output_tokens ?? 0;
    } else if (evType === "message_delta" && obj.usage) {
      if (typeof obj.usage.output_tokens === "number") rawUsage.output = obj.usage.output_tokens;
    } else if (evType === "content_block_start" && obj.content_block) {
      if (obj.content_block.type === "tool_use") {
        blocks.set(obj.index, {
          id: obj.content_block.id || `tu_${step}_${obj.index}`,
          name: obj.content_block.name || "",
          argsStr: "",
        });
      }
    } else if (evType === "content_block_delta" && obj.delta) {
      if (obj.delta.type === "thinking_delta" && obj.delta.thinking) {
        reasoning += obj.delta.thinking;
        emit({ type: "reasoning_delta", step, text: obj.delta.thinking });
      } else if (obj.delta.type === "text_delta" && obj.delta.text) {
        text += obj.delta.text;
        emit({ type: "text_delta", step, text: obj.delta.text });
      } else if (obj.delta.type === "input_json_delta" && obj.delta.partial_json) {
        const slot = blocks.get(obj.index);
        if (slot) slot.argsStr += obj.delta.partial_json;
      }
    }
  }

  const toolCalls = Array.from(blocks.values()).map((tc) => {
    let args = {};
    try {
      args = tc.argsStr ? JSON.parse(tc.argsStr) : {};
    } catch {
      args = { raw: tc.argsStr };
    }
    return { id: tc.id, name: tc.name, args };
  });

  const totalTokens = rawUsage.input + rawUsage.cacheRead + rawUsage.cacheCreate + rawUsage.output;
  const usage =
    totalTokens > 0
      ? {
          inputTokens: rawUsage.input + rawUsage.cacheCreate,
          cacheReadTokens: rawUsage.cacheRead,
          outputTokens: rawUsage.output,
          thinkingTokens: 0,
          totalTokens,
        }
      : null;

  return { reasoning, text, toolCalls, usage };
}

// ---------------------------------------------------------------- Main Runner

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const cfg = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  const sessionId = cfg.sessionId || `direct-${Date.now().toString(36)}`;
  const cwd = cfg.cwd || process.cwd();
  const readonly = cfg.permissionMode === "readonly";
  const supportsImage = Array.isArray(cfg.inputs) ? cfg.inputs.includes("image") : false;
  const api = cfg.api || "openai-completions";
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] || "" : "";

  emit({ type: "session", sessionId, cwd, model: cfg.model });
  emit({ type: "status", phase: "session_ready", turn: 1, step: 0 });

  if (!cfg.baseURL || !cfg.model) {
    emit({ type: "error", message: "直连 API 预设缺少 Base URL 或模型 ID" });
    process.exit(1);
  }
  if (cfg.apiKeyEnv && !apiKey) {
    emit({
      type: "error",
      message: `未在环境变量中找到 ${cfg.apiKeyEnv}，请先在系统环境或 mcp_config.json 中设置该变量`,
    });
    process.exit(1);
  }

  // Load persisted direct conversation history if resuming
  let history = [];
  if (cfg.historyPath && fs.existsSync(cfg.historyPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(cfg.historyPath, "utf8"));
      if (Array.isArray(saved?.messages)) history = saved.messages;
    } catch {
      // start fresh
    }
  }
  history.push({ role: "user", text: cfg.task });

  const systemPrompt = [
    `You are a clean, focused headless subagent operating inside working directory: ${cwd}.`,
    `Platform: ${process.platform}. Follow the coordinator's task instructions directly without pausing for interactive confirmation.`,
    readonly
      ? `PERMISSION MODE: READ-ONLY AUDIT. Do NOT modify files or run mutating commands.`
      : `Use the provided tools concisely, verify your edits, and return a clear factual summary.`,
  ].join("\n");

  const tools = buildToolDefs({ readonly, supportsImage });
  const caller =
    api === "anthropic-messages"
      ? callAnthropicMessages
      : api === "openai-responses"
        ? callOpenAIResponses
        : callOpenAICompletions;

  let finalText = "";
  let lastUsage = null;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const stepStart = Date.now();
    emit({ type: "status", phase: "step_start", step });
    emit({ type: "stream_start", step });

    let result;
    try {
      result = await caller({
        baseURL: cfg.baseURL,
        apiKey,
        model: cfg.model,
        effort: cfg.effort,
        maxTokens: cfg.maxTokens,
        systemPrompt,
        history,
        tools,
        step,
      });
    } catch (e) {
      emit({ type: "error", message: `直连请求失败 (${api}): ${e.message}` });
      process.exit(1);
    }

    const durSec = Math.max(0.1, (Date.now() - stepStart) / 1000);
    if (result.reasoning?.trim()) {
      emit({ type: "reasoning_commit", step, text: result.reasoning.trim() });
    }
    if (result.text?.trim()) {
      finalText = result.text.trim();
      emit({ type: "text_commit", step, text: finalText });
    }
    if (result.usage) {
      lastUsage = result.usage;
      emit({ type: "usage", usage: result.usage, durationSec: durSec });
    }

    history.push({
      role: "assistant",
      text: result.text || "",
      toolCalls: result.toolCalls || [],
    });

    if (!result.toolCalls || result.toolCalls.length === 0) {
      break;
    }

    for (const tc of result.toolCalls) {
      const tStart = Date.now();
      emit({
        type: "tool_start",
        callId: tc.id,
        toolName: tc.name,
        args: tc.args,
        step,
        time: tStart,
      });
      const out = executeTool(tc.name, tc.args || {}, { cwd, readonly, supportsImage });
      const tEnd = Date.now();
      emit({
        type: "tool_end",
        callId: tc.id,
        toolName: tc.name,
        isError: out.isError,
        resultText: out.text,
        durationMs: Math.max(0, tEnd - tStart),
        step,
        time: tEnd,
      });
      history.push({
        role: "tool",
        callId: tc.id,
        text: out.text,
        isError: out.isError,
        ...(out.image ? { image: out.image } : {}),
      });
    }
  }

  // Persist compact conversation history (strip large base64 images to keep disk light)
  if (cfg.historyPath) {
    try {
      fs.mkdirSync(path.dirname(cfg.historyPath), { recursive: true });
      const slim = history.slice(-80).map((m) => (m.image ? { ...m, image: undefined } : m));
      fs.writeFileSync(cfg.historyPath, JSON.stringify({ sessionId, messages: slim }), "utf8");
    } catch {
      // ignore disk errors
    }
  }

  emit({ type: "status", phase: "turn_end" });
  emit({ type: "final", text: finalText || "(已完成)", usage: lastUsage });
}

main().catch((e) => {
  emit({ type: "error", message: e?.message || String(e) });
  process.exit(1);
});
