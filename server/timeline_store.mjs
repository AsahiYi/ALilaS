import fs from "node:fs";
import path from "node:path";

/**
 * Unified normalized timeline storage for all ALilaS drivers (agy / dsh / claude / codex).
 * Each session stores compact normalized events in `${DATA_DIR}/timelines/<safeId>.json`.
 * DSH historical sessions without a normalized timeline seamlessly fall back to `dsh_reader.mjs`.
 */
export function createTimelineStore(dataDir) {
  const dir = path.join(dataDir, "timelines");
  const mem = new Map();

  function safeFile(sessionId) {
    const safe = String(sessionId || "").replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(dir, `${safe}.json`);
  }

  function load(sessionId) {
    if (!sessionId) return null;
    if (mem.has(sessionId)) return mem.get(sessionId);
    const fp = safeFile(sessionId);
    try {
      if (fs.existsSync(fp)) {
        const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (parsed && typeof parsed === "object") {
          mem.set(sessionId, parsed);
          return parsed;
        }
      }
    } catch {
      // ignore corrupt cache
    }
    return null;
  }

  function save(doc) {
    if (!doc?.sessionId) return;
    doc.mtimeMs = Date.now();
    mem.set(doc.sessionId, doc);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fp = safeFile(doc.sessionId);
      const tmp = `${fp}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc), "utf8");
      fs.renameSync(tmp, fp);
    } catch {
      // ignore disk write error
    }
  }

  function ensure({ sessionId, driver, model, effort, cwd, contextWindow, title }) {
    let doc = load(sessionId);
    if (!doc) {
      doc = {
        version: 1,
        sessionId,
        driver: driver || "agy",
        model: model || "",
        effort: effort || "",
        cwd: cwd || "",
        contextWindow: contextWindow || 200_000,
        title: title || sessionId,
        createdAt: Date.now(),
        mtimeMs: Date.now(),
        turns: 0,
        steps: 0,
        reasoningCount: 0,
        toolCallCount: 0,
        textCount: 0,
        usage: null,
        lastTps: 0,
        lastStepDurationSec: 0,
        lastTtftSec: 0,
        cumulativeTokens: 0,
        cumulativeInputTokens: 0,
        cumulativeCacheReadTokens: 0,
        cumulativeOutputTokens: 0,
        recentSteps: [],
        lastAssistantText: "",
        items: [],
      };
      mem.set(sessionId, doc);
    } else {
      if (driver && !doc.driver) doc.driver = driver;
      if (model) doc.model = model;
      if (effort) doc.effort = effort;
      if (cwd && !doc.cwd) doc.cwd = cwd;
      if (contextWindow) doc.contextWindow = contextWindow;
    }
    return doc;
  }

  function listAll() {
    const out = [];
    const seen = new Set();
    for (const doc of mem.values()) {
      seen.add(doc.sessionId);
      out.push(doc);
    }
    try {
      if (fs.existsSync(dir)) {
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith(".json")) continue;
          const sid = entry.slice(0, -5);
          if (seen.has(sid)) continue;
          const doc = load(sid);
          if (doc) out.push(doc);
        }
      }
    } catch {
      // ignore
    }
    return out;
  }

  function toView(doc, maxItems = 180) {
    if (!doc) return null;
    const allItems = Array.isArray(doc.items) ? doc.items : [];
    const truncatedItems = allItems.length > maxItems;
    const items = truncatedItems ? allItems.slice(-maxItems) : allItems;
    return {
      sessionId: doc.sessionId,
      driver: doc.driver || "agy",
      model: doc.model || "",
      effort: doc.effort || "",
      cwd: doc.cwd || "",
      contextWindow: doc.contextWindow || 200_000,
      title: doc.title || doc.sessionId,
      createdAt: doc.createdAt,
      mtimeMs: doc.mtimeMs,
      sizeBytes: 0,
      isHeadless: true,
      usage: doc.usage || null,
      lastTps: doc.lastTps || 0,
      lastStepDurationSec: doc.lastStepDurationSec || 0,
      lastTtftSec: doc.lastTtftSec || 0,
      cumulativeTokens: doc.cumulativeTokens || 0,
      cumulativeInputTokens: doc.cumulativeInputTokens || 0,
      cumulativeCacheReadTokens: doc.cumulativeCacheReadTokens || 0,
      cumulativeOutputTokens: doc.cumulativeOutputTokens || 0,
      recentSteps: Array.isArray(doc.recentSteps) ? doc.recentSteps : [],
      stats: {
        totalEvents: allItems.length,
        turns: doc.turns || 0,
        steps: doc.steps || 0,
        reasoningCount: doc.reasoningCount || 0,
        toolCallCount: doc.toolCallCount || 0,
        textCount: doc.textCount || 0,
        totalTimelineItems: allItems.length,
        truncatedItems,
      },
      lastAssistantText: doc.lastAssistantText || "",
      items,
    };
  }

  return { load, save, ensure, listAll, toView };
}
