import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;
const DEFAULT_SESSIONS_ROOT =
  process.env.ALILAS_DSH_SESSIONS_DIR ||
  process.env.LILAS_DSH_SESSIONS_DIR ||
  path.join(os.homedir(), ".dsh", "sessions");
const DEFAULT_WORKSPACE_SLUG = "";

// Unified cache keyed strictly by filePath -> { mtimeMs, size, lastValidOffset, state }
const parseCache = new Map();

/**
 * Derive DSH-style workspace slug from a cwd path.
 */
export function cwdToWorkspaceSlug(cwd) {
  if (!cwd) return DEFAULT_WORKSPACE_SLUG;
  const cleaned = String(cwd)
    .replace(/[:\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned ? `--${cleaned}--` : DEFAULT_WORKSPACE_SLUG;
}

/**
 * Tolerant zstd concatenated-frame scanner starting from byte offset 0 of `buf`.
 * Returns decoded UTF-8 string, number of complete frames, bytes consumed, and tornTail flag.
 */
export function decodeZstdFramesTolerant(buf) {
  const texts = [];
  let off = 0;
  let tornTail = false;

  while (off < buf.length) {
    const start = off;
    if (buf.length - off < 5) {
      tornTail = true;
      break;
    }
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) {
      tornTail = true;
      break;
    }
    const d = buf.readUInt8(off + 4);
    const cs = (d & 4) !== 0;
    const ss = (d & 32) !== 0;
    const csf = d >>> 6;
    const dict = d & 3;
    const db = dict === 3 ? 4 : dict;
    const cb = csf === 0 ? (ss ? 1 : 0) : 1 << csf;
    off += 5 + (ss ? 0 : 1) + db + cb;
    if (off > buf.length) {
      off = start;
      tornTail = true;
      break;
    }

    let ok = true;
    for (;;) {
      if (buf.length - off < 3) {
        ok = false;
        break;
      }
      const bh = buf.readUIntLE(off, 3);
      off += 3;
      const last = bh & 1;
      const bt = (bh >>> 1) & 3;
      const bs = bh >>> 3;
      if (bt === 3) {
        ok = false;
        break;
      }
      const payload = bt === 1 ? 1 : bs;
      if (buf.length - off < payload) {
        ok = false;
        break;
      }
      off += payload;
      if (last) break;
    }
    if (!ok) {
      off = start;
      tornTail = true;
      break;
    }
    if (cs) {
      if (buf.length - off < 4) {
        off = start;
        tornTail = true;
        break;
      }
      off += 4;
    }

    try {
      const chunk = zlib.zstdDecompressSync(buf.subarray(start, off)).toString("utf8");
      texts.push(chunk);
    } catch {
      off = start;
      tornTail = true;
      break;
    }
  }

  return {
    plain: texts.join(""),
    frameCount: texts.length,
    consumedBytes: off,
    tornTail,
  };
}

function truncate(str, maxLen) {
  if (typeof str !== "string") return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n…（已截断，原文共 ${str.length} 字）`;
}

function stringifyCompact(val, maxLen = 900) {
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return truncate(val, maxLen);
  try {
    return truncate(JSON.stringify(val, null, 2), maxLen);
  } catch {
    return truncate(String(val), maxLen);
  }
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c.text === "string") return c.text;
      if (c && c.type === "image") return "[图片]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isNoiseUserPrompt(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("Time sampled")) return true;
  if (t.startsWith("Current runtime context")) return true;
  if (t.startsWith("<runtime-context")) return true;
  return false;
}

function parseArgsObject(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function summarizeToolArgs(toolName, rawArgs) {
  const obj = parseArgsObject(rawArgs);
  if (!obj) {
    return typeof rawArgs === "string" ? rawArgs.replace(/\s+/g, " ").slice(0, 88) : "";
  }
  const priorityKeys = [
    "command",
    "cmd",
    "script",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "pattern",
    "query",
    "url",
    "description",
    "old_str",
    "cwd",
  ];
  for (const k of priorityKeys) {
    if (typeof obj[k] === "string" && obj[k].trim()) {
      const v = obj[k].replace(/\s+/g, " ").trim();
      return v.length > 92 ? v.slice(0, 92) + "…" : v;
    }
  }
  const firstStr = Object.entries(obj).find(
    ([, v]) => typeof v === "string" && v.trim(),
  );
  if (firstStr) {
    const v = `${firstStr[0]}: ${firstStr[1].replace(/\s+/g, " ").trim()}`;
    return v.length > 92 ? v.slice(0, 92) + "…" : v;
  }
  try {
    const s = JSON.stringify(obj);
    return s.length > 92 ? s.slice(0, 92) + "…" : s;
  } catch {
    return "";
  }
}

function extractFilePaths(rawArgs, sessionCwd) {
  const obj = parseArgsObject(rawArgs);
  if (!obj) return [];
  const pathKeys = ["path", "file_path", "filePath", "target_file", "file", "filename"];
  const found = [];
  for (const k of pathKeys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim() && !val.includes("\n")) {
      const trimmed = val.trim();
      const resolved =
        path.isAbsolute(trimmed)
          ? trimmed
          : sessionCwd
            ? path.resolve(sessionCwd, trimmed)
            : "";
      if (resolved && !found.includes(resolved)) {
        found.push(resolved);
      }
    }
  }
  return found.slice(0, 3);
}

function createParserState(filePath) {
  return {
    sessionId: path.basename(path.dirname(filePath)),
    filePath,
    cwd: "",
    createdAt: null,
    title: "",
    agentPreset: null,
    origin: null,
    parentSession: null,
    currentTurn: 0,
    currentStep: 0,
    totalEvents: 0,
    reasoningCount: 0,
    toolCallCount: 0,
    textCount: 0,
    frameCount: 0,
    tornTail: false,
    lastTurnEnd: null,
    lastAssistantText: "",
    latestUsage: null,
    stepStartTime: null,
    lastStepDurationSec: 0,
    lastTps: 0,
    cumulativeTokens: 0,
    cumulativeInputTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeOutputTokens: 0,
    recentSteps: [],
    dailyUsage: {},
    allItems: [],
    toolItemByCallId: new Map(),
    lineRemainder: "",
  };
}

function parseEventLine(state, line, { maxToolResultLen, maxReasoningLen }) {
  if (!line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }

  state.totalEvents++;
  const type = ev.type;
  const seq = ev.seq ?? state.totalEvents;
  const time = typeof ev.time === "number" ? ev.time : null;
  const d = ev.data || {};

  if (type === "session") {
    if (ev.id) state.sessionId = ev.id;
    if (ev.cwd) state.cwd = ev.cwd;
    if (ev.createdAt) state.createdAt = ev.createdAt;
    if (ev.agentPreset) state.agentPreset = ev.agentPreset;
    if (ev.origin) state.origin = ev.origin;
    if (ev.parentSession) state.parentSession = ev.parentSession;
  } else if (type === "agent-preset/selected") {
    if (d.agentPreset) state.agentPreset = d.agentPreset;
  } else if (type === "session/title") {
    if (typeof d.title === "string" && d.title.trim()) {
      state.title = d.title.trim();
    }
  } else if (type === "turn/start") {
    state.currentTurn = d.turn ?? state.currentTurn + 1;
  } else if (type === "step/start") {
    state.currentStep = d.step ?? state.currentStep + 1;
    state.stepStartTime = time;
  } else if (type === "turn/end") {
    state.lastTurnEnd = { turn: d.turn ?? state.currentTurn, reason: d.reason || null };
    if (d.reason?.kind === "error") {
      state.allItems.push({
        kind: "error",
        seq,
        turn: state.currentTurn,
        step: state.currentStep,
        time,
        text: stringifyCompact(d.reason.error || d.reason, 1200),
      });
    }
  } else if (type === "user/message") {
    const msg = d.message || d;
    const text = extractTextFromContent(msg.content);
    if (!isNoiseUserPrompt(text)) {
      if (!state.title) state.title = text.replace(/\s+/g, " ").slice(0, 48);
      state.allItems.push({
        kind: "user",
        seq,
        turn: state.currentTurn,
        step: state.currentStep,
        time,
        text: truncate(text, 4000),
        charCount: text.length,
      });
    }
  } else if (type === "assistant/message") {
    if (d.usage && typeof d.usage === "object") {
      const inputTokens = d.usage.inputTokens ?? 0;
      const outputTokens = d.usage.outputTokens ?? 0;
      const cacheReadTokens = d.usage.cacheReadTokens ?? 0;
      const cacheWriteTokens = d.usage.cacheWriteTokens ?? 0;
      const reasoningTokens = d.usage.reasoningTokens ?? 0;
      const totalTokens =
        d.usage.totalTokens ?? inputTokens + cacheReadTokens + outputTokens;
      state.latestUsage = {
        inputTokens,
        outputTokens,
        totalTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
      };
      state.cumulativeTokens += totalTokens;
      state.cumulativeInputTokens += inputTokens;
      state.cumulativeCacheReadTokens += cacheReadTokens;
      state.cumulativeOutputTokens += outputTokens;
      let stepDur = 0;
      let stepTps = 0;
      if (time && state.stepStartTime && time > state.stepStartTime && outputTokens > 0) {
        const durSec = (time - state.stepStartTime) / 1000;
        stepDur = Math.round(durSec * 10) / 10;
        state.lastStepDurationSec = stepDur;
        if (durSec >= 0.15) {
          stepTps = Math.round(((outputTokens + reasoningTokens) / durSec) * 10) / 10;
          state.lastTps = stepTps;
        }
      }
      state.recentSteps.push({
        time: time || state.createdAt || 0,
        turn: state.currentTurn,
        step: state.currentStep,
        inputTokens,
        cacheReadTokens,
        outputTokens: outputTokens + reasoningTokens,
        totalTokens,
        durationSec: stepDur,
        tps: stepTps,
      });
      if (state.recentSteps.length > 15) state.recentSteps.shift();
      const tsForDay = time || state.createdAt || 0;
      if (tsForDay > 0 && totalTokens > 0) {
        const dt = new Date(tsForDay);
        const dayKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
        const prevD = state.dailyUsage[dayKey] || {
          tokens: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          steps: 0,
        };
        prevD.tokens += totalTokens;
        prevD.inputTokens += inputTokens;
        prevD.cacheReadTokens += cacheReadTokens;
        prevD.outputTokens += outputTokens + reasoningTokens;
        prevD.steps += 1;
        state.dailyUsage[dayKey] = prevD;
      }
    }

    const msg = d.message || d;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (!b || typeof b !== "object") continue;
      if (b.type === "reasoning" && typeof b.text === "string" && b.text.trim()) {
        const trimmed = b.text.trim();
        state.reasoningCount++;
        state.allItems.push({
          kind: "reasoning",
          seq: `${seq}.r${bi}`,
          turn: state.currentTurn,
          step: state.currentStep,
          time,
          text: truncate(trimmed, maxReasoningLen),
          charCount: trimmed.length,
        });
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const trimmed = b.text.trim();
        state.textCount++;
        state.lastAssistantText = trimmed;
        state.allItems.push({
          kind: "text",
          seq: `${seq}.t${bi}`,
          turn: state.currentTurn,
          step: state.currentStep,
          time,
          text: truncate(trimmed, 12000),
          charCount: trimmed.length,
        });
      } else if (b.type === "tool-call") {
        const callId = b.toolCallId || b.id || `${seq}.c${bi}`;
        if (!state.toolItemByCallId.has(callId)) {
          const toolName = b.toolName || b.name || "tool";
          const rawArgs = b.input ?? b.args ?? b.arguments;
          state.toolCallCount++;
          const item = {
            kind: "tool",
            seq: `${seq}.c${bi}`,
            callId,
            turn: state.currentTurn,
            step: state.currentStep,
            toolName,
            argsSummary: summarizeToolArgs(toolName, rawArgs),
            argsPreview: stringifyCompact(rawArgs, 900),
            filePaths: extractFilePaths(rawArgs, state.cwd),
            status: "running",
            isError: false,
            startTime: time,
            endTime: null,
            durationMs: null,
            resultText: "",
          };
          state.toolItemByCallId.set(callId, item);
          state.allItems.push(item);
        }
      }
    }
  } else if (type === "tool/call") {
    const callId = d.callId || d.toolCallId || d.id || `tc.${seq}`;
    const existing = state.toolItemByCallId.get(callId);
    const toolName = d.name || d.toolName || "tool";
    const rawArgs = d.arguments ?? d.input ?? d.args;
    if (existing) {
      // Enrich timestamp / args if assistant/message lacked exact call time
      if (!existing.startTime && time) existing.startTime = time;
      if (!existing.argsSummary) existing.argsSummary = summarizeToolArgs(toolName, rawArgs);
      if (!existing.argsPreview) existing.argsPreview = stringifyCompact(rawArgs, 900);
      if (!existing.filePaths?.length) existing.filePaths = extractFilePaths(rawArgs, state.cwd);
    } else {
      state.toolCallCount++;
      const item = {
        kind: "tool",
        seq: `tc.${seq}`,
        callId,
        turn: d.turn ?? state.currentTurn,
        step: d.step ?? state.currentStep,
        toolName,
        argsSummary: summarizeToolArgs(toolName, rawArgs),
        argsPreview: stringifyCompact(rawArgs, 900),
        filePaths: extractFilePaths(rawArgs, state.cwd),
        status: "running",
        isError: false,
        startTime: time,
        endTime: null,
        durationMs: null,
        resultText: "",
      };
      state.toolItemByCallId.set(callId, item);
      state.allItems.push(item);
    }
  } else if (type === "tool/result") {
    if (ev.surfaceOp && ev.surfaceOp !== "append") return;
    const msg = d.message && typeof d.message === "object" ? d.message : d;
    const callId = msg.toolCallId || d.toolCallId || d.callId || d.id || null;
    const isError = Boolean(msg.isError || d.isError || d.error);
    const rawContent = msg.content ?? d.result ?? d.output ?? d;
    let preview = "";
    if (typeof rawContent === "string") {
      preview = truncate(rawContent, maxToolResultLen);
    } else if (Array.isArray(rawContent)) {
      const extracted = extractTextFromContent(rawContent);
      preview = truncate(
        extracted || stringifyCompact(rawContent, maxToolResultLen),
        maxToolResultLen,
      );
    } else {
      preview = stringifyCompact(rawContent, maxToolResultLen);
    }

    const existing = callId ? state.toolItemByCallId.get(callId) : null;
    if (existing) {
      existing.status = isError ? "error" : "done";
      existing.isError = isError;
      existing.resultText = preview;
      existing.endTime = time;
      if (time && existing.startTime && time >= existing.startTime) {
        existing.durationMs = time - existing.startTime;
      }
    } else {
      const toolName = msg.toolName || d.toolName || "tool";
      state.allItems.push({
        kind: "tool",
        seq: `tr.${seq}`,
        callId: callId || `tr.${seq}`,
        turn: d.turn ?? state.currentTurn,
        step: d.step ?? state.currentStep,
        toolName,
        argsSummary: "",
        argsPreview: "",
        filePaths: [],
        status: isError ? "error" : "done",
        isError,
        startTime: null,
        endTime: time,
        durationMs: null,
        resultText: preview,
      });
    }
  }
}

function readBufferSlice(filePath, startOffset, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const n = fs.readSync(fd, buf, totalRead, length - totalRead, startOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    return totalRead === length ? buf : buf.subarray(0, totalRead);
  } finally {
    fs.closeSync(fd);
  }
}

function loadOrUpdateState(filePath, { maxToolResultLen = 2000, maxReasoningLen = 10000 } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return { error: `无法读取会话文件: ${e.message}` };
  }

  let entry = parseCache.get(filePath);
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    return { entry, stat };
  }

  // Incremental path: file grew and we have a valid previous offset
  if (entry && stat.size >= entry.lastValidOffset && entry.lastValidOffset > 0) {
    const deltaLen = stat.size - entry.lastValidOffset;
    if (deltaLen === 0) {
      entry.mtimeMs = stat.mtimeMs;
      entry.size = stat.size;
      return { entry, stat };
    }
    const deltaBuf = readBufferSlice(filePath, entry.lastValidOffset, deltaLen);
    const { plain, frameCount, consumedBytes, tornTail } = decodeZstdFramesTolerant(deltaBuf);
    entry.state.frameCount += frameCount;
    entry.state.tornTail = tornTail;
    entry.lastValidOffset += consumedBytes;
    entry.mtimeMs = stat.mtimeMs;
    entry.size = stat.size;

    if (plain) {
      const combined = entry.state.lineRemainder + plain;
      const lines = combined.split("\n");
      entry.state.lineRemainder = lines.pop() ?? "";
      for (const line of lines) {
        parseEventLine(entry.state, line, { maxToolResultLen, maxReasoningLen });
      }
      if (!tornTail && entry.state.lineRemainder.trim()) {
        parseEventLine(entry.state, entry.state.lineRemainder, {
          maxToolResultLen,
          maxReasoningLen,
        });
        entry.state.lineRemainder = "";
      }
    }
    return { entry, stat };
  }

  // Full decode path (first load or file shrunk/rewritten)
  const buf = fs.readFileSync(filePath);
  const { plain, frameCount, consumedBytes, tornTail } = decodeZstdFramesTolerant(buf);
  const state = createParserState(filePath);
  state.frameCount = frameCount;
  state.tornTail = tornTail;

  const lines = plain.split("\n");
  state.lineRemainder = lines.pop() ?? "";
  for (const line of lines) {
    parseEventLine(state, line, { maxToolResultLen, maxReasoningLen });
  }
  if (!tornTail && state.lineRemainder.trim()) {
    parseEventLine(state, state.lineRemainder, { maxToolResultLen, maxReasoningLen });
    state.lineRemainder = "";
  }

  entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    lastValidOffset: consumedBytes,
    state,
  };

  if (parseCache.size > 60) {
    const firstKey = parseCache.keys().next().value;
    parseCache.delete(firstKey);
  }
  parseCache.set(filePath, entry);
  return { entry, stat };
}

export function parseSessionFile(filePath, opts = {}) {
  const maxItems = opts.maxItems ?? 180;
  const loaded = loadOrUpdateState(filePath, opts);
  if (loaded.error) {
    return { error: loaded.error, items: [] };
  }
  const { entry, stat } = loaded;
  const st = entry.state;
  const isHeadless = !st.agentPreset || st.agentPreset !== "standard";
  const truncatedItems = st.allItems.length > maxItems;
  const items = truncatedItems ? st.allItems.slice(-maxItems) : st.allItems;

  return {
    sessionId: st.sessionId,
    filePath,
    cwd: st.cwd,
    title: st.title || st.sessionId,
    createdAt: st.createdAt,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    isHeadless,
    agentPreset: st.agentPreset || "headless",
    origin: st.origin,
    parentSession: st.parentSession,
    frameCount: st.frameCount,
    tornTail: st.tornTail,
    usage: st.latestUsage,
    lastTps: st.lastTps,
    lastStepDurationSec: st.lastStepDurationSec,
    cumulativeTokens: st.cumulativeTokens,
    cumulativeInputTokens: st.cumulativeInputTokens,
    cumulativeCacheReadTokens: st.cumulativeCacheReadTokens,
    cumulativeOutputTokens: st.cumulativeOutputTokens,
    recentSteps: st.recentSteps.slice().reverse(),
    dailyUsage: st.dailyUsage,
    stats: {
      totalEvents: st.totalEvents,
      turns: st.currentTurn,
      steps: st.currentStep,
      reasoningCount: st.reasoningCount,
      toolCallCount: st.toolCallCount,
      textCount: st.textCount,
      totalTimelineItems: st.allItems.length,
      truncatedItems,
    },
    lastTurnEnd: st.lastTurnEnd,
    lastAssistantText: truncate(st.lastAssistantText, 32000),
    items,
  };
}

export function findSessionFileById(sessionId, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  if (!sessionId || !fs.existsSync(sessionsRoot)) return null;
  const dirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  for (const ws of dirs) {
    if (!ws.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, ws.name, sessionId, "session.v4.jsonl.zstd");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Fast preflight inspection for an existing session before launching dsh --session-id.
 */
export function inspectSessionForResume(sessionId, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  const fp = findSessionFileById(sessionId, sessionsRoot);
  if (!fp) {
    return { exists: false, adoptable: false, reason: `未找到持久化会话 ${sessionId}（新建会话请留空 session_id）` };
  }
  const parsed = parseSessionFile(fp, { maxItems: 1 });
  if (parsed.error) {
    return { exists: true, adoptable: false, reason: parsed.error };
  }
  if (!parsed.isHeadless) {
    return {
      exists: true,
      adoptable: false,
      reason: `会话 ${sessionId} 属于桌面端 "${parsed.agentPreset}" preset，严禁以 Mode A 接入；请留空 session_id 新建独立会话`,
      parsed,
    };
  }
  if (parsed.origin === "subagent" || parsed.parentSession) {
    return {
      exists: true,
      adoptable: false,
      reason: `会话 ${sessionId} 是子代理/分叉会话，DSH 不允许直接复用`,
      parsed,
    };
  }
  if (!parsed.cwd) {
    return {
      exists: true,
      adoptable: false,
      reason: `会话 ${sessionId} 未记录工作目录 cwd，DSH 无法复用`,
      parsed,
    };
  }
  return {
    exists: true,
    adoptable: true,
    cwd: parsed.cwd,
    filePath: fp,
    parsed,
  };
}

export function listSessions({
  sessionsRoot = DEFAULT_SESSIONS_ROOT,
  workspaceSlug = DEFAULT_WORKSPACE_SLUG,
  allWorkspaces = false,
  headlessOnly = false,
  allowedSessionIds = null,
  hiddenSessionIds = null,
  limit = 30,
  activeSessionIds = new Set(),
} = {}) {
  if (!fs.existsSync(sessionsRoot)) return [];

  const wsDirs = allWorkspaces
    ? fs
        .readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [workspaceSlug].filter((w) => fs.existsSync(path.join(sessionsRoot, w)));

  const rawEntries = [];
  for (const ws of wsDirs) {
    const wsPath = path.join(sessionsRoot, ws);
    let children;
    try {
      children = fs.readdirSync(wsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith("session-")) continue;
      if (hiddenSessionIds?.has(child.name) && !activeSessionIds.has(child.name)) {
        continue;
      }
      if (
        allowedSessionIds &&
        !allowedSessionIds.has(child.name) &&
        !activeSessionIds.has(child.name)
      ) {
        continue;
      }
      const fp = path.join(wsPath, child.name, "session.v4.jsonl.zstd");
      try {
        const st = fs.statSync(fp);
        rawEntries.push({
          sessionId: child.name,
          workspaceSlug: ws,
          filePath: fp,
          mtimeMs: st.mtimeMs,
          sizeBytes: st.size,
        });
      } catch {
        // skip
      }
    }
  }

  rawEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results = [];

  for (const entry of rawEntries) {
    if (results.length >= limit) break;
    const parsed = parseSessionFile(entry.filePath, { maxItems: 1 });
    if (parsed.error) continue;
    const isRunning = activeSessionIds.has(entry.sessionId);
    if (headlessOnly && !parsed.isHeadless && !isRunning) continue;
    if (
      !isRunning &&
      parsed.stats.reasoningCount === 0 &&
      parsed.stats.textCount === 0
    ) {
      continue;
    }
    results.push({
      sessionId: entry.sessionId,
      workspaceSlug: entry.workspaceSlug,
      title: parsed.title,
      cwd: parsed.cwd,
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      isHeadless: parsed.isHeadless,
      isRunning,
      reasoningCount: parsed.stats.reasoningCount,
      toolCallCount: parsed.stats.toolCallCount,
      textCount: parsed.stats.textCount,
      turns: parsed.stats.turns,
      usage: parsed.usage,
    });
  }

  return results;
}
