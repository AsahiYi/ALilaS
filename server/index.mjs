import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import {
  cwdToWorkspaceSlug,
  findSessionFileById,
  inspectSessionForResume,
  listSessions as listDshSessions,
  parseSessionFile as parseDshSessionFile,
} from "./dsh_reader.mjs";
import { detectAllDrivers, getDriver } from "./drivers/index.mjs";
import { inferContextWindow } from "./drivers/utils.mjs";
import { createProfileStore } from "./profiles.mjs";
import { createTimelineStore } from "./timeline_store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.ALILAS_PLUGIN_ROOT || process.env.LILAS_PLUGIN_ROOT || path.resolve(__dirname, "..");
const DATA_DIR = process.env.ALILAS_DATA_DIR || process.env.LILAS_DATA_DIR || path.join(PLUGIN_ROOT, "data");
const REGISTRY_FILE = path.join(DATA_DIR, "plugin_sessions.json");
const APP_URI = "ui://alilas/app.html";
const APP_HTML_PATH =
  process.env.ALILAS_APP_HTML || path.join(PLUGIN_ROOT, "ui", "dist", "app.html");
const DEFAULT_CWD =
  process.env.ALILAS_DEFAULT_CWD || process.cwd() || os.homedir();

const REFUSAL_PATTERN =
  /(?:Sorry,\s*I\s*can(?:'|’)?t\s*(?:respond|assist|help)\s*to\s*this|I(?:'|’)?m\s*sorry,?\s*(?:but\s*)?I\s*can(?:'|’)?t\s*(?:assist|help|respond))/i;

const timelineStore = createTimelineStore(DATA_DIR);
const profileStore = createProfileStore(DATA_DIR);

function normalizeCwd(p) {
  if (!p || typeof p !== "string") return "";
  try {
    return path.resolve(p.trim()).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return p.trim().replace(/[\\/]+$/, "").toLowerCase();
  }
}

function extractTaskTitle(task, maxLen = 140) {
  const lines = String(task || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful =
    lines.find((l) => !/^you are an authorized headless execution subagent/i.test(l)) ||
    lines[0] ||
    "";
  return meaningful.length > maxLen ? meaningful.slice(0, maxLen) + "…" : meaningful;
}

function summarizeArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return "";
  if (typeof rawArgs === "string") return rawArgs.replace(/\s+/g, " ").slice(0, 92);
  if (typeof rawArgs === "object") {
    for (const k of ["command", "cmd", "path", "file_path", "filePath", "target_file", "pattern", "query", "url"]) {
      if (typeof rawArgs[k] === "string" && rawArgs[k].trim()) {
        const s = rawArgs[k].replace(/\s+/g, " ").trim();
        return s.length > 92 ? s.slice(0, 92) + "…" : s;
      }
    }
    try {
      const s = JSON.stringify(rawArgs);
      return s.length > 92 ? s.slice(0, 92) + "…" : s;
    } catch {
      return "";
    }
  }
  return "";
}

function extractFilePaths(rawArgs, sessionCwd) {
  if (!rawArgs || typeof rawArgs !== "object") return [];
  const out = [];
  for (const k of ["path", "file_path", "filePath", "target_file", "file", "filename"]) {
    const val = rawArgs[k];
    if (typeof val === "string" && val.trim() && !val.includes("\n")) {
      const resolved = path.isAbsolute(val.trim())
        ? val.trim()
        : sessionCwd
          ? path.resolve(sessionCwd, val.trim())
          : "";
      if (resolved && !out.includes(resolved)) out.push(resolved);
    }
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- Registry v3

let registryVersion = 1;

function createEmptyRegistry() {
  return {
    version: 3,
    recentCwds: [DEFAULT_CWD],
    sessions: {},
  };
}

function loadRegistry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
      if (Array.isArray(raw)) {
        const reg = createEmptyRegistry();
        for (const sid of raw) {
          if (typeof sid === "string" && sid.trim()) {
            reg.sessions[sid] = {
              driver: "dsh",
              model: "",
              effort: "",
              profileId: "",
              alias: "",
              pinned: false,
              hidden: false,
              cwd: "",
              createdAt: Date.now(),
            };
          }
        }
        saveRegistry(reg);
        return reg;
      }
      if (raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object") {
        // Normalize v2 -> v3 seamlessly (default driver: "dsh" for legacy session-* entries)
        for (const [sid, meta] of Object.entries(raw.sessions)) {
          if (!meta.driver) {
            meta.driver = sid.startsWith("session-") ? "dsh" : "agy";
          }
        }
        return {
          version: 3,
          recentCwds: Array.isArray(raw.recentCwds) ? raw.recentCwds.filter(Boolean) : [DEFAULT_CWD],
          sessions: raw.sessions,
        };
      }
    }
  } catch {
    // ignore
  }
  const seeded = createEmptyRegistry();
  saveRegistry(seeded);
  return seeded;
}

function saveRegistry(reg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2), "utf8");
    registryVersion++;
  } catch {
    // ignore
  }
}

const registry = loadRegistry();

function getPluginSessionIdSet() {
  return new Set(Object.keys(registry.sessions));
}

function getHiddenSessionIdSet() {
  const s = new Set();
  for (const [sid, meta] of Object.entries(registry.sessions)) {
    if (meta?.hidden) s.add(sid);
  }
  return s;
}

function recordRecentCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return;
  const trimmed = cwd.trim();
  if (!trimmed) return;
  const list = registry.recentCwds.filter(
    (c) => normalizeCwd(c) !== normalizeCwd(trimmed),
  );
  list.unshift(trimmed);
  registry.recentCwds = list.slice(0, 12);
}

function recordPluginSession(sessionId, { driver, model, effort, profileId, cwd } = {}) {
  if (!sessionId) return;
  let changed = false;
  if (!registry.sessions[sessionId]) {
    registry.sessions[sessionId] = {
      driver: driver || "agy",
      model: model || "",
      effort: effort || "",
      profileId: profileId || "",
      alias: "",
      pinned: false,
      hidden: false,
      cwd: cwd || "",
      createdAt: Date.now(),
    };
    changed = true;
  } else {
    const m = registry.sessions[sessionId];
    if (driver && !m.driver) { m.driver = driver; changed = true; }
    if (model && m.model !== model) { m.model = model; changed = true; }
    if (effort && m.effort !== effort) { m.effort = effort; changed = true; }
    if (profileId !== undefined && m.profileId !== profileId) { m.profileId = profileId; changed = true; }
    if (cwd && !m.cwd) { m.cwd = cwd; changed = true; }
  }
  if (cwd) {
    const before = registry.recentCwds[0];
    recordRecentCwd(cwd);
    if (registry.recentCwds[0] !== before) changed = true;
  }
  if (changed) saveRegistry(registry);
}

function killProcessTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === "win32" && pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try { child.kill(); } catch {}
      });
      return;
    } catch {
      // fallback
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- Driver Catalog Cache

let driversCache = null;
let driversCacheAt = 0;
let driversVersion = 1;

function getDetectedDrivers(force = false) {
  const now = Date.now();
  if (!force && driversCache && now - driversCacheAt < 60_000) {
    return driversCache;
  }
  const snap = profileStore.getSnapshot();
  const scanDesktop = snap.settings?.scanDshDesktop !== false;
  driversCache = detectAllDrivers({
    pluginRoot: PLUGIN_ROOT,
    scanDesktop,
    customProfiles: snap.customProfiles || [],
  });
  driversCacheAt = now;
  driversVersion++;
  return driversCache;
}

function resolveEffectiveSelection({ driver, model, effort, profileId, sessionId }) {
  const sessMeta = sessionId ? registry.sessions[sessionId] : null;
  const profSnap = profileStore.getSnapshot();
  const def = profSnap.defaultSelection;

  const chosenProfileId = profileId || (!driver && !model ? sessMeta?.profileId || def.profileId : "");
  let profile = chosenProfileId ? profileStore.findProfile(chosenProfileId) : null;
  if (!profile && driver === "direct") {
    profile =
      (model
        ? (profSnap.customProfiles || []).find(
            (p) => (p.driver || "direct") === "direct" && (p.id === model || p.model === model),
          )
        : null) ||
      (sessMeta?.profileId ? profileStore.findProfile(sessMeta.profileId) : null) ||
      (profSnap.customProfiles || []).find((p) => (p.driver || "direct") === "direct") ||
      null;
  }

  let effectiveDriver =
    driver ||
    profile?.driver ||
    sessMeta?.driver ||
    def.driver ||
    "";

  const detected = getDetectedDrivers(false);
  if (!effectiveDriver || effectiveDriver === "auto") {
    // Prefer native CLI drivers (dsh with models -> agy -> claude -> codex), fall back to direct API
    const dshInfo = detected.find((d) => d.id === "dsh" && d.installed && d.models?.length > 0);
    const agyInfo = detected.find((d) => d.id === "agy" && d.installed);
    const anyNative = detected.find((d) => d.id !== "direct" && d.installed);
    const directInfo = detected.find((d) => d.id === "direct" && d.models?.length > 0);
    effectiveDriver = dshInfo?.id || agyInfo?.id || anyNative?.id || directInfo?.id || "agy";
  }

  if (effectiveDriver === "direct" && !profile) {
    profile = (profSnap.customProfiles || []).find((p) => (p.driver || "direct") === "direct") || null;
  }

  let effectiveModel =
    model ||
    profile?.model ||
    (sessMeta?.driver === effectiveDriver ? sessMeta.model : "") ||
    (def.driver === effectiveDriver ? def.model : "") ||
    "";

  const dInfo = detected.find((d) => d.id === effectiveDriver);
  if (!effectiveModel && dInfo?.models?.length > 0) {
    effectiveModel = dInfo.models[0].compositeId || dInfo.models[0].id;
  }

  const effectiveEffort =
    effort ||
    profile?.effort ||
    (sessMeta?.driver === effectiveDriver ? sessMeta.effort : "") ||
    def.effort ||
    "high";

  const foundModel = dInfo?.models?.find(
    (m) => m.compositeId === effectiveModel || m.id === effectiveModel,
  );
  const contextWindow =
    profile?.contextWindow ||
    foundModel?.contextWindow ||
    inferContextWindow(effectiveModel, effectiveDriver === "dsh" || effectiveDriver === "agy" ? 1_000_000 : 200_000);

  return {
    driver: effectiveDriver,
    model: effectiveModel,
    effort: effectiveEffort,
    profileId: profile?.id || "",
    profile,
    contextWindow,
  };
}

// ---------------------------------------------------------------- MCP Metadata

const PANE_META = {
  ui: { resourceUri: APP_URI },
  "com.google.antigravity/ui": {
    entrypoints: [
      { type: "aux_pane", title: "ALilaS" },
      { type: "global", title: "ALilaS" },
    ],
  },
};

const INLINE_META = {
  ui: { resourceUri: APP_URI },
};

const APP_ONLY_META = {
  ui: { visibility: ["app"] },
};

// ---------------------------------------------------------------- Run Manager

const runs = new Map();

function isRunActive(run) {
  return Boolean(run && (run.status === "starting" || run.status === "running"));
}

function touchRunActivity(run) {
  if (!run) return;
  run.lastActivityAt = Date.now();
  if (run.stalled) {
    run.stalled = false;
    if (run.phase === "stalled") run.phase = "running";
    run.stallPromise = new Promise((res) => {
      run.resolveStall = res;
    });
  }
}

function computeLiveTps(run) {
  if (!run) return 0;
  if (run.live.active && run.live.firstDeltaAt && run.live.deltaChars > 12) {
    const elapsedSec = Math.max(0.25, (Date.now() - run.live.firstDeltaAt) / 1000);
    // Practical approximation (~3.1 chars/token for mixed CJK/code) during live stream
    return Math.round(((run.live.deltaChars / 3.1) / elapsedSec) * 10) / 10;
  }
  return run.tps || 0;
}

function serializeRun(run) {
  if (!run) return null;
  const now = Date.now();
  const elapsedMs = (run.endedAt || now) - run.startedAt;
  const idleMs = isRunActive(run) ? Math.max(0, now - run.lastActivityAt) : 0;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    driver: run.driver,
    model: run.model,
    effort: run.effort,
    permissionMode: run.permissionMode,
    contextWindow: run.contextWindow,
    taskPreview: run.task.slice(0, 180),
    cwd: run.cwd,
    status: run.status,
    phase: run.phase,
    turn: run.turn,
    step: run.step,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    elapsedSec: Math.round(elapsedMs / 100) / 10,
    idleSec: Math.round(idleMs / 100) / 10,
    idleTimeoutSec: run.idleTimeoutSec,
    stalled: Boolean(run.stalled && isRunActive(run)),
    exitCode: run.exitCode,
    error: run.error,
    finalText: run.finalText ? run.finalText.slice(0, 4000) : "",
    stderrTail: run.stderrTail,
    usage: run.latestUsage || null,
    tps: computeLiveTps(run),
    ttftSec: run.lastTtftSec || 0,
    lastStepDurationSec: run.lastStepDurationSec || 0,
    cumulativeTokens: run.cumulativeTokens || 0,
    cumulativeInputTokens: run.cumulativeInputTokens || 0,
    cumulativeCacheReadTokens: run.cumulativeCacheReadTokens || 0,
    cumulativeOutputTokens: run.cumulativeOutputTokens || 0,
    live: run.live.active
      ? {
          active: true,
          seq: run.live.seq,
          step: run.live.step,
          reasoning: run.live.reasoning,
          text: run.live.text,
          toolName: run.live.toolName,
        }
      : null,
  };
}

function getActiveSessionIds() {
  const s = new Set();
  for (const r of runs.values()) {
    if (r.sessionId && isRunActive(r)) s.add(r.sessionId);
  }
  return s;
}

function findRunForSession(sessionId) {
  let match = null;
  for (const r of runs.values()) {
    if (r.sessionId === sessionId) {
      if (!match || r.startedAt > match.startedAt) match = r;
    }
  }
  return match;
}

function resolveCwdForSessionId(sessionId) {
  if (!sessionId) return "";
  const activeRun = findRunForSession(sessionId);
  if (activeRun?.cwd) return activeRun.cwd;
  const regCwd = registry.sessions[sessionId]?.cwd;
  if (regCwd) return regCwd;
  const tl = timelineStore.load(sessionId);
  if (tl?.cwd) return tl.cwd;
  const fp = findSessionFileById(sessionId);
  if (fp) {
    const parsed = parseDshSessionFile(fp, { maxItems: 1 });
    if (parsed?.cwd) return parsed.cwd;
  }
  return "";
}

function stopRunById(runId, reason = "stopped_by_user") {
  const run = runs.get(runId);
  if (!run) return null;
  if (isRunActive(run)) {
    run.status = "stopped";
    run.phase = reason;
    run.stalled = false;
    run.live.active = false;
    run.endedAt = Date.now();
    clearTimeout(run.timer);
    clearInterval(run.watchdog);
    killProcessTree(run.child);
    run.resolveSession?.(run.sessionId);
    run.resolveStall?.(run);
    run.resolveDone?.(run);
  }
  return run;
}

function launchSubagentRun({
  task,
  sessionId,
  cwd,
  driver,
  model,
  effort,
  profileId,
  permissionMode = "auto",
  timeoutSec,
  idleTimeoutSec,
}) {
  const sel = resolveEffectiveSelection({ driver, model, effort, profileId, sessionId });
  const driverMod = getDriver(sel.driver);
  if (!driverMod) {
    throw new Error(`不支持的子代理驱动: ${sel.driver}（可选: agy | dsh | claude | codex | direct）`);
  }

  let workDir = (cwd || "").trim() || DEFAULT_CWD;

  if (sessionId) {
    const existing = findRunForSession(sessionId);
    if (existing && isRunActive(existing)) {
      throw new Error(
        `会话 ${sessionId} 正在运行中（${existing.runId}），禁止并发派活。如需中止旧任务请先调 alilas_stop_task("${existing.runId}")，如需并行请留空 session_id。`,
      );
    }
    if (sel.driver === "dsh") {
      const check = inspectSessionForResume(sessionId);
      if (!check.adoptable) throw new Error(check.reason);
      workDir = check.cwd;
    } else {
      const savedCwd = resolveCwdForSessionId(sessionId);
      if (savedCwd) workDir = savedCwd;
    }
  } else if (!fs.existsSync(workDir)) {
    throw new Error(`工作目录不存在: ${workDir}`);
  }

  const runId = `run-${crypto.randomBytes(4).toString("hex")}`;
  const timeoutMs =
    typeof timeoutSec === "number" && timeoutSec > 0
      ? Math.max(30, Math.min(timeoutSec, 86400)) * 1000
      : 0;
  const defaultIdleSec = profileStore.getSnapshot().settings?.idleTimeoutSec || 180;
  const clampedIdleSec = Math.max(60, Math.min(idleTimeoutSec || defaultIdleSec, 600));

  const inv = driverMod.buildInvocation({
    runId,
    task,
    sessionId,
    cwd: workDir,
    model: sel.model,
    effort: sel.effort,
    permissionMode,
    profile: sel.profile,
    dataDir: DATA_DIR,
    pluginRoot: PLUGIN_ROOT,
  });

  let resolveSession;
  const sessionReady = new Promise((res) => { resolveSession = res; });
  let resolveDone;
  const donePromise = new Promise((res) => { resolveDone = res; });
  let resolveStall;
  const stallPromise = new Promise((res) => { resolveStall = res; });

  const now = Date.now();
  const run = {
    runId,
    sessionId: sessionId || null,
    driver: sel.driver,
    model: sel.model,
    effort: sel.effort,
    profileId: sel.profileId,
    permissionMode,
    contextWindow: sel.contextWindow,
    task,
    cwd: workDir,
    status: "starting",
    phase: "booting",
    turn: 1,
    step: 0,
    startedAt: now,
    lastActivityAt: now,
    idleTimeoutSec: clampedIdleSec,
    stalled: false,
    lastFileSize: 0,
    toolCallsInRun: 0,
    endedAt: null,
    exitCode: null,
    error: null,
    finalText: "",
    stderrTail: "",
    latestUsage: null,
    tps: 0,
    stepStartAt: now,
    lastTtftSec: 0,
    lastStepDurationSec: 0,
    cumulativeTokens: 0,
    cumulativeInputTokens: 0,
    cumulativeCacheReadTokens: 0,
    cumulativeOutputTokens: 0,
    cleanupPaths: inv.cleanupPaths || [],
    live: {
      active: false,
      seq: 0,
      step: 0,
      reasoning: "",
      text: "",
      toolName: "",
      firstDeltaAt: 0,
      deltaChars: 0,
    },
    timelineDoc: null,
    toolMap: new Map(),
    child: null,
    timer: null,
    watchdog: null,
    donePromise,
    resolveDone,
    resolveSession,
    stallPromise,
    resolveStall,
  };

  function ensureTimelineDoc() {
    if (!run.sessionId) return null;
    if (!run.timelineDoc) {
      run.timelineDoc = timelineStore.ensure({
        sessionId: run.sessionId,
        driver: run.driver,
        model: run.model,
        effort: run.effort,
        cwd: run.cwd,
        contextWindow: run.contextWindow,
        title: extractTaskTitle(run.task, 140),
      });
      run.timelineDoc.turns = (run.timelineDoc.turns || 0) + 1;
      run.turn = run.timelineDoc.turns;
      run.timelineDoc.items.push({
        kind: "user",
        seq: `u.${Date.now()}`,
        turn: run.turn,
        step: 0,
        time: run.startedAt,
        text: run.task.slice(0, 4000),
        charCount: run.task.length,
      });
      timelineStore.save(run.timelineDoc);
    }
    return run.timelineDoc;
  }

  if (sessionId) {
    recordPluginSession(sessionId, {
      driver: sel.driver,
      model: sel.model,
      effort: sel.effort,
      profileId: sel.profileId,
      cwd: workDir,
    });
    if (sel.driver !== "dsh") ensureTimelineDoc();
  } else {
    recordRecentCwd(workDir);
    saveRegistry(registry);
  }

  runs.set(runId, run);
  profileStore.recordUsageDelta({ driver: sel.driver, model: sel.model, incrementRun: true });

  if (runs.size > 35) {
    for (const [k, v] of runs.entries()) {
      if (!isRunActive(v)) {
        runs.delete(k);
        if (runs.size <= 25) break;
      }
    }
  }

  const handleEvent = (ev) => {
    touchRunActivity(run);

    if (ev.type === "session" && ev.sessionId) {
      const firstBind = !run.sessionId;
      run.sessionId = ev.sessionId;
      if (ev.model && !run.model) run.model = ev.model;
      recordPluginSession(ev.sessionId, {
        driver: run.driver,
        model: run.model,
        effort: run.effort,
        profileId: run.profileId,
        cwd: run.cwd,
      });
      if (run.driver !== "dsh") ensureTimelineDoc();
      if (run.status === "starting") {
        run.status = "running";
        run.phase = "session_ready";
      }
      if (firstBind) resolveSession(ev.sessionId);
      return;
    }

    if (ev.type === "status") {
      if (run.status === "starting") run.status = "running";
      if (ev.phase) run.phase = ev.phase;
      if (ev.phase === "step_start") run.stepStartAt = Date.now();
      if (typeof ev.turn === "number") run.turn = ev.turn;
      if (typeof ev.step === "number") run.step = ev.step;
      if (ev.phase === "turn_end") {
        run.live.active = false;
        run.live.reasoning = "";
        run.live.text = "";
        run.live.toolName = "";
        run.live.firstDeltaAt = 0;
        run.live.deltaChars = 0;
        run.live.seq++;
      }
      return;
    }

    if (ev.type === "stream_start") {
      run.live.active = true;
      run.live.step = ev.step || run.step || 1;
      if (!run.stepStartAt) run.stepStartAt = Date.now();
      run.live.reasoning = "";
      run.live.text = "";
      run.live.toolName = "";
      run.live.firstDeltaAt = 0;
      run.live.deltaChars = 0;
      run.live.seq++;
      return;
    }

    if (ev.type === "reasoning_delta" && ev.text) {
      run.live.active = true;
      if (!run.live.firstDeltaAt) {
        const ts = Date.now();
        run.live.firstDeltaAt = ts;
        const baseTs = run.stepStartAt || run.startedAt;
        if (baseTs && ts > baseTs) {
          const ttft = (ts - baseTs) / 1000;
          if (ttft >= 0.05 && ttft < 600) run.lastTtftSec = Math.round(ttft * 100) / 100;
        }
      }
      run.live.deltaChars += ev.text.length;
      if (ev.step) run.live.step = ev.step;
      run.phase = "thinking";
      run.live.reasoning = (run.live.reasoning + ev.text).slice(-16000);
      run.live.seq++;
      return;
    }

    if (ev.type === "text_delta" && ev.text) {
      run.live.active = true;
      if (!run.live.firstDeltaAt) {
        const ts = Date.now();
        run.live.firstDeltaAt = ts;
        const baseTs = run.stepStartAt || run.startedAt;
        if (baseTs && ts > baseTs) {
          const ttft = (ts - baseTs) / 1000;
          if (ttft >= 0.05 && ttft < 600) run.lastTtftSec = Math.round(ttft * 100) / 100;
        }
      }
      run.live.deltaChars += ev.text.length;
      if (ev.step) run.live.step = ev.step;
      run.phase = "writing";
      run.live.text = (run.live.text + ev.text).slice(-16000);
      run.live.seq++;
      return;
    }

    if (ev.type === "tool_delta" && ev.toolName) {
      run.live.active = true;
      run.live.toolName = ev.toolName;
      run.phase = `tool:${ev.toolName}`;
      run.live.seq++;
      return;
    }

    if (ev.type === "reasoning_commit" && ev.text) {
      run.live.seq++;
      if (run.driver !== "dsh") {
        const doc = ensureTimelineDoc();
        if (doc) {
          doc.reasoningCount++;
          doc.steps = Math.max(doc.steps, ev.step || run.step || 1);
          doc.items.push({
            kind: "reasoning",
            seq: `r.${doc.items.length}`,
            turn: run.turn,
            step: ev.step || run.step || 1,
            time: Date.now(),
            text: ev.text.slice(0, 12000),
            charCount: ev.text.length,
          });
          timelineStore.save(doc);
        }
        run.live.reasoning = "";
      }
      return;
    }

    if (ev.type === "text_commit" && ev.text) {
      run.live.seq++;
      if (run.driver !== "dsh") {
        const doc = ensureTimelineDoc();
        if (doc) {
          doc.textCount++;
          doc.steps = Math.max(doc.steps, ev.step || run.step || 1);
          doc.lastAssistantText = ev.text.slice(0, 32000);
          doc.items.push({
            kind: "text",
            seq: `t.${doc.items.length}`,
            turn: run.turn,
            step: ev.step || run.step || 1,
            time: Date.now(),
            text: ev.text.slice(0, 16000),
            charCount: ev.text.length,
          });
          timelineStore.save(doc);
        }
        run.live.text = "";
      }
      return;
    }

    if (ev.type === "tool_start") {
      run.toolCallsInRun++;
      run.phase = `tool:${ev.toolName || "exec"}`;
      run.live.toolName = ev.toolName || "";
      run.live.seq++;
      if (run.driver !== "dsh") {
        const doc = ensureTimelineDoc();
        if (doc) {
          doc.toolCallCount++;
          const argsPreview =
            typeof ev.args === "string"
              ? ev.args.slice(0, 900)
              : JSON.stringify(ev.args ?? {}, null, 2).slice(0, 900);
          const item = {
            kind: "tool",
            seq: `tc.${doc.items.length}`,
            callId: ev.callId,
            turn: run.turn,
            step: ev.step || run.step || 1,
            toolName: ev.toolName || "tool",
            argsSummary: summarizeArgs(ev.args),
            argsPreview,
            filePaths: extractFilePaths(ev.args, run.cwd),
            status: "running",
            isError: false,
            startTime: ev.time || Date.now(),
            endTime: null,
            durationMs: null,
            resultText: "",
          };
          run.toolMap.set(ev.callId, item);
          doc.items.push(item);
          timelineStore.save(doc);
        }
      }
      return;
    }

    if (ev.type === "tool_end") {
      run.live.toolName = "";
      run.live.seq++;
      if (run.driver !== "dsh") {
        const doc = ensureTimelineDoc();
        if (doc) {
          const item = run.toolMap.get(ev.callId);
          if (item) {
            item.status = ev.isError ? "error" : "done";
            item.isError = Boolean(ev.isError);
            item.resultText = String(ev.resultText || "").slice(0, 2400);
            item.endTime = ev.time || Date.now();
            item.durationMs = ev.durationMs;
          } else {
            doc.items.push({
              kind: "tool",
              seq: `tr.${doc.items.length}`,
              callId: ev.callId || `tr.${Date.now()}`,
              turn: run.turn,
              step: ev.step || run.step || 1,
              toolName: ev.toolName || "tool",
              argsSummary: "",
              argsPreview: "",
              filePaths: [],
              status: ev.isError ? "error" : "done",
              isError: Boolean(ev.isError),
              startTime: null,
              endTime: ev.time || Date.now(),
              durationMs: ev.durationMs,
              resultText: String(ev.resultText || "").slice(0, 2400),
            });
          }
          timelineStore.save(doc);
        }
      }
      return;
    }

    if (ev.type === "usage" && ev.usage) {
      run.latestUsage = ev.usage;
      const nowTs = Date.now();
      const inputTokens = ev.usage.inputTokens || 0;
      const cacheReadTokens = ev.usage.cacheReadTokens || 0;
      const genTokens = (ev.usage.outputTokens || 0) + (ev.usage.thinkingTokens || 0) + (ev.usage.reasoningTokens || 0);
      const stepTotal = ev.usage.totalTokens || 0;
      const rawDur =
        ev.durationSec && ev.durationSec > 0.05
          ? ev.durationSec
          : run.stepStartAt && nowTs > run.stepStartAt
            ? (nowTs - run.stepStartAt) / 1000
            : 0;
      if (rawDur > 0) run.lastStepDurationSec = Math.round(rawDur * 10) / 10;

      // Prefer pure streaming throughput (firstDeltaAt -> now) if available, else step duration
      if (run.live.firstDeltaAt && genTokens > 0) {
        const streamDt = Math.max(0.2, (nowTs - run.live.firstDeltaAt) / 1000);
        run.tps = Math.round((genTokens / streamDt) * 10) / 10;
      } else if (rawDur > 0.1 && genTokens > 0) {
        run.tps = Math.round((genTokens / rawDur) * 10) / 10;
      }

      if (stepTotal > 0) {
        run.cumulativeTokens += stepTotal;
        run.cumulativeInputTokens += inputTokens;
        run.cumulativeCacheReadTokens += cacheReadTokens;
        run.cumulativeOutputTokens += genTokens;
        profileStore.recordUsageDelta({
          driver: run.driver,
          model: run.model,
          effort: run.effort,
          inputTokens,
          cacheReadTokens,
          outputTokens: genTokens,
          totalTokens: stepTotal,
          tps: run.tps,
          ttftSec: run.lastTtftSec,
          durationSec: run.lastStepDurationSec,
          status: run.error ? "error" : "ok",
        });
      }
      if (run.timelineDoc) {
        run.timelineDoc.usage = ev.usage;
        if (run.tps) run.timelineDoc.lastTps = run.tps;
        if (run.lastStepDurationSec) run.timelineDoc.lastStepDurationSec = run.lastStepDurationSec;
        if (run.lastTtftSec) run.timelineDoc.lastTtftSec = run.lastTtftSec;
        run.timelineDoc.cumulativeTokens = (run.timelineDoc.cumulativeTokens || 0) + stepTotal;
        run.timelineDoc.cumulativeInputTokens = (run.timelineDoc.cumulativeInputTokens || 0) + inputTokens;
        run.timelineDoc.cumulativeCacheReadTokens = (run.timelineDoc.cumulativeCacheReadTokens || 0) + cacheReadTokens;
        run.timelineDoc.cumulativeOutputTokens = (run.timelineDoc.cumulativeOutputTokens || 0) + genTokens;
        if (!Array.isArray(run.timelineDoc.recentSteps)) run.timelineDoc.recentSteps = [];
        run.timelineDoc.recentSteps.unshift({
          time: nowTs,
          turn: run.turn,
          step: run.step,
          inputTokens,
          cacheReadTokens,
          outputTokens: genTokens,
          totalTokens: stepTotal,
          durationSec: run.lastStepDurationSec || 0,
          tps: run.tps || 0,
          ttftSec: run.lastTtftSec || 0,
        });
        run.timelineDoc.recentSteps = run.timelineDoc.recentSteps.slice(0, 15);
        timelineStore.save(run.timelineDoc);
      }
      run.stepStartAt = 0;
      run.live.seq++;
      return;
    }

    if (ev.type === "final" && ev.text) {
      run.finalText = ev.text;
      if (run.timelineDoc) {
        run.timelineDoc.lastAssistantText = ev.text.slice(0, 32000);
        timelineStore.save(run.timelineDoc);
      }
      return;
    }

    if (ev.type === "error" && ev.message) {
      run.error = ev.message;
      if (run.timelineDoc) {
        run.timelineDoc.items.push({
          kind: "error",
          seq: `e.${run.timelineDoc.items.length}`,
          turn: run.turn,
          step: run.step,
          time: Date.now(),
          text: String(ev.message).slice(0, 1500),
        });
        timelineStore.save(run.timelineDoc);
      }
      return;
    }

    if (ev.type === "stderr" && ev.text) {
      run.stderrTail = (run.stderrTail + ev.text + "\n").slice(-2000);
    }
  };

  const parser = driverMod.createParser(handleEvent);

  const child = spawn(inv.cmd, inv.args, {
    cwd: inv.cwd,
    env: inv.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: Boolean(inv.shell),
  });
  run.child = child;

  if (typeof inv.stdinText === "string") {
    try {
      child.stdin.write(inv.stdinText, "utf8");
      child.stdin.end();
    } catch (e) {
      run.error = `stdin 写入失败: ${e.message}`;
    }
  } else {
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
  }

  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) parser.onStdoutLine(line);
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stderrBuf.indexOf("\n")) !== -1) {
      const rawLine = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      parser.onStderrLine(rawLine);
    }
  });

  // Idle watchdog
  run.watchdog = setInterval(() => {
    if (!isRunActive(run)) {
      clearInterval(run.watchdog);
      return;
    }
    if (run.driver === "dsh" && run.sessionId) {
      try {
        const fp = findSessionFileById(run.sessionId);
        if (fp) {
          const st = fs.statSync(fp);
          if (st.size > run.lastFileSize) {
            run.lastFileSize = st.size;
            touchRunActivity(run);
            return;
          }
        }
      } catch {
        // ignore
      }
    }
    const idleSec = (Date.now() - run.lastActivityAt) / 1000;
    if (!run.stalled && idleSec >= run.idleTimeoutSec) {
      run.stalled = true;
      run.phase = "stalled";
      run.resolveStall?.(run);
    }
  }, 10_000);

  if (timeoutMs > 0) {
    run.timer = setTimeout(() => {
      if (isRunActive(run)) {
        run.status = "timeout";
        run.phase = "timeout";
        run.stalled = false;
        run.live.active = false;
        run.error = `运行超过 ${Math.round(timeoutMs / 1000)} 秒已自动中止`;
        clearInterval(run.watchdog);
        killProcessTree(child);
      }
    }, timeoutMs);
  }

  function cleanupTmpPatches() {
    for (const p of run.cleanupPaths) {
      try {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  child.on("close", (code) => {
    clearTimeout(run.timer);
    clearInterval(run.watchdog);
    if (stdoutBuf.trim()) parser.onStdoutLine(stdoutBuf.trim());
    if (stderrBuf.trim()) parser.onStderrLine(stderrBuf);
    parser.flush();
    cleanupTmpPatches();

    run.exitCode = code;
    run.endedAt = Date.now();
    run.stalled = false;
    run.live.active = false;
    if (isRunActive(run)) {
      if (code === 0 && !run.error) {
        run.status = "done";
        run.phase = "completed";
      } else {
        run.status = "error";
        run.phase = "failed";
        if (!run.error && run.stderrTail.trim()) {
          run.error = run.stderrTail.trim().slice(-600);
        }
      }
    }
    resolveSession(run.sessionId);
    run.resolveStall?.(run);
    resolveDone(run);
  });

  child.on("error", (err) => {
    clearTimeout(run.timer);
    clearInterval(run.watchdog);
    cleanupTmpPatches();
    run.endedAt = Date.now();
    run.stalled = false;
    run.live.active = false;
    run.status = "error";
    run.phase = "spawn_error";
    run.error = err.message;
    resolveSession(run.sessionId);
    run.resolveStall?.(run);
    resolveDone(run);
  });

  return { run, sessionReady };
}

// ---------------------------------------------------------------- Unified Session Snapshot

function collectRecentCwds(sessions) {
  const seen = new Set();
  const out = [];
  const push = (c) => {
    if (!c || typeof c !== "string") return;
    const t = c.trim();
    if (!t) return;
    const key = normalizeCwd(t);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  };
  for (const c of registry.recentCwds) push(c);
  for (const s of sessions) push(s.cwd);
  for (const r of runs.values()) push(r.cwd);
  return out.slice(0, 12);
}

function loadSessionView(sessionId, maxItems = 180) {
  if (!sessionId) return null;
  const meta = registry.sessions[sessionId] || {};
  const run = findRunForSession(sessionId);

  // 1. Prefer normalized ALilaS timeline for non-DSH sessions
  const tl = timelineStore.load(sessionId);
  if (tl && (tl.driver !== "dsh" || !findSessionFileById(sessionId))) {
    const v = timelineStore.toView(tl, maxItems);
    v.alias = meta.alias || "";
    v.pinned = Boolean(meta.pinned);
    v.hidden = Boolean(meta.hidden);
    return v;
  }

  // 2. DSH session reader (with incremental zstd decoding)
  const fp = findSessionFileById(sessionId);
  if (fp) {
    const parsed = parseDshSessionFile(fp, { maxItems });
    parsed.driver = meta.driver || "dsh";
    parsed.model = meta.model || parsed.model || "";
    parsed.effort = meta.effort || parsed.effort || "";
    const dshInfo = getDetectedDrivers(false).find((d) => d.id === "dsh");
    const matchedM = dshInfo?.models?.find(
      (m) => m.compositeId === parsed.model || m.id === parsed.model,
    );
    parsed.contextWindow =
      parsed.contextWindow ||
      matchedM?.contextWindow ||
      inferContextWindow(parsed.model, 1_000_000);
    parsed.interrupted = Boolean(
      parsed.interrupted && !isRunActive(run) && run?.status !== "stopped" && run?.status !== "done",
    );
    parsed.lastTps = (run && run.tps > 0 ? run.tps : parsed.lastTps) || 0;
    parsed.lastStepDurationSec =
      (run && run.lastStepDurationSec > 0 ? run.lastStepDurationSec : parsed.lastStepDurationSec) || 0;
    parsed.lastTtftSec = run?.lastTtftSec || 0;
    parsed.cumulativeTokens = parsed.cumulativeTokens || parsed.usage?.totalTokens || 0;
    parsed.alias = meta.alias || "";
    parsed.pinned = Boolean(meta.pinned);
    parsed.hidden = Boolean(meta.hidden);
    return parsed;
  }

  // 3. In-memory placeholder for a freshly booted run before first flush
  if (run) {
    return {
      sessionId,
      driver: run.driver,
      model: run.model,
      effort: run.effort,
      contextWindow: run.contextWindow,
      title: extractTaskTitle(run.task, 140),
      alias: meta.alias || "",
      pinned: Boolean(meta.pinned),
      hidden: Boolean(meta.hidden),
      cwd: run.cwd,
      isHeadless: true,
      usage: run.latestUsage || null,
      lastTps: computeLiveTps(run),
      lastStepDurationSec: run.lastStepDurationSec || 0,
      lastTtftSec: run.lastTtftSec || 0,
      cumulativeTokens: run.cumulativeTokens || 0,
      cumulativeInputTokens: run.cumulativeInputTokens || 0,
      cumulativeCacheReadTokens: run.cumulativeCacheReadTokens || 0,
      cumulativeOutputTokens: run.cumulativeOutputTokens || 0,
      stats: {
        totalEvents: 0,
        turns: run.turn || 1,
        steps: run.step || 0,
        reasoningCount: 0,
        toolCallCount: 0,
        textCount: 0,
        totalTimelineItems: 1,
        truncatedItems: false,
      },
      items: [{ kind: "user", seq: 0, turn: 1, step: 0, text: run.task, charCount: run.task.length }],
    };
  }
  return null;
}

function listAllUnifiedSessions({
  headlessOnly = true,
  pluginOnly = true,
  includeHidden = false,
  activeIds = new Set(),
} = {}) {
  const hiddenSet = includeHidden ? null : getHiddenSessionIdSet();
  const allowedSet = pluginOnly ? getPluginSessionIdSet() : null;
  const map = new Map();

  // A) Normalized ALilaS timelines (agy / claude / codex / etc.)
  for (const doc of timelineStore.listAll()) {
    if (hiddenSet?.has(doc.sessionId) && !activeIds.has(doc.sessionId)) continue;
    if (allowedSet && !allowedSet.has(doc.sessionId) && !activeIds.has(doc.sessionId)) continue;
    const meta = registry.sessions[doc.sessionId] || {};
    map.set(doc.sessionId, {
      sessionId: doc.sessionId,
      driver: doc.driver || meta.driver || "agy",
      model: doc.model || meta.model || "",
      effort: doc.effort || meta.effort || "",
      contextWindow: doc.contextWindow || inferContextWindow(doc.model, 200_000),
      workspaceSlug: cwdToWorkspaceSlug(doc.cwd),
      title: doc.title || doc.sessionId,
      alias: meta.alias || "",
      pinned: Boolean(meta.pinned),
      hidden: Boolean(meta.hidden),
      cwd: doc.cwd || meta.cwd || "",
      mtimeMs: doc.mtimeMs || doc.createdAt || 0,
      sizeBytes: 0,
      isHeadless: true,
      isRunning: activeIds.has(doc.sessionId),
      reasoningCount: doc.reasoningCount || 0,
      toolCallCount: doc.toolCallCount || 0,
      textCount: doc.textCount || 0,
      turns: doc.turns || 0,
      usage: doc.usage || null,
    });
  }

  // B) DSH persisted .jsonl.zstd sessions
  const dshList = listDshSessions({
    headlessOnly,
    allWorkspaces: true,
    allowedSessionIds: allowedSet,
    hiddenSessionIds: hiddenSet,
    limit: 60,
    activeSessionIds: activeIds,
  });
  for (const s of dshList) {
    if (map.has(s.sessionId)) continue;
    const meta = registry.sessions[s.sessionId] || {};
    map.set(s.sessionId, {
      ...s,
      driver: meta.driver || "dsh",
      model: meta.model || "",
      effort: meta.effort || "",
      contextWindow: inferContextWindow(meta.model, 1_000_000),
      alias: meta.alias || "",
      pinned: Boolean(meta.pinned),
      hidden: Boolean(meta.hidden),
    });
  }

  // C) Active in-memory runs not yet flushed
  for (const r of runs.values()) {
    if (r.sessionId && !map.has(r.sessionId)) {
      const meta = registry.sessions[r.sessionId] || {};
      map.set(r.sessionId, {
        sessionId: r.sessionId,
        driver: r.driver,
        model: r.model,
        effort: r.effort,
        contextWindow: r.contextWindow,
        workspaceSlug: cwdToWorkspaceSlug(r.cwd),
        title: extractTaskTitle(r.task, 140),
        alias: meta.alias || "",
        pinned: Boolean(meta.pinned),
        hidden: Boolean(meta.hidden),
        cwd: r.cwd,
        mtimeMs: r.startedAt,
        sizeBytes: 0,
        isHeadless: true,
        isRunning: isRunActive(r),
        reasoningCount: 0,
        toolCallCount: 0,
        textCount: 0,
        turns: r.turn,
        usage: r.latestUsage || null,
      });
    }
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------- Unified Telemetry Aggregator

let unifiedTelemetryCache = null;
let unifiedTelemetryAt = 0;
let unifiedTelemetryVer = "";

function getUnifiedTelemetry(profSnap) {
  const now = Date.now();
  const verKey = `${registryVersion}:${profileStore.getVersion()}:${getActiveSessionIds().size}`;
  if (unifiedTelemetryCache && unifiedTelemetryVer === verKey && now - unifiedTelemetryAt < 20_000) {
    return unifiedTelemetryCache;
  }

  const base = profSnap.telemetry || {};
  let scanTokens = 0;
  let scanInput = 0;
  let scanCache = 0;
  let scanOutput = 0;
  let scanSessions = 0;
  const scanByDriver = {};
  const scanByModel = {};
  const scanDaily = {};

  const addDaily = (dayKey, tok, inp, cache, out, runsCnt) => {
    if (!dayKey || tok <= 0) return;
    const prev = scanDaily[dayKey] || { tokens: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, runs: 0 };
    prev.tokens += tok;
    prev.inputTokens += inp;
    prev.cacheReadTokens += cache;
    prev.outputTokens += out;
    prev.runs += runsCnt;
    scanDaily[dayKey] = prev;
  };

  const seenSids = new Set();

  // 1. Scan normalized timelines (agy / claude / codex)
  for (const doc of timelineStore.listAll()) {
    seenSids.add(doc.sessionId);
    const tok = doc.cumulativeTokens || doc.usage?.totalTokens || 0;
    if (tok <= 0) continue;
    scanSessions++;
    const inp = doc.cumulativeInputTokens || doc.usage?.inputTokens || 0;
    const cache = doc.cumulativeCacheReadTokens || doc.usage?.cacheReadTokens || 0;
    const out = doc.cumulativeOutputTokens || doc.usage?.outputTokens || 0;
    const drv = doc.driver || "agy";
    const mKey = doc.model ? `${drv}/${doc.model}` : drv;
    scanTokens += tok;
    scanInput += inp;
    scanCache += cache;
    scanOutput += out;
    scanByDriver[drv] = (scanByDriver[drv] || 0) + tok;
    const pm = scanByModel[mKey] || { tokens: 0, runs: 0, lastTps: 0 };
    pm.tokens += tok;
    pm.runs += Math.max(1, doc.turns || 1);
    if (doc.lastTps > 0) pm.lastTps = doc.lastTps;
    scanByModel[mKey] = pm;
    const ts = doc.mtimeMs || doc.createdAt || 0;
    if (ts > 0) {
      const d = new Date(ts);
      const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      addDaily(dk, tok, inp, cache, out, Math.max(1, doc.turns || 1));
    }
  }

  // 2. Scan registered DSH sessions (cached incrementally by dsh_reader)
  for (const [sid, meta] of Object.entries(registry.sessions)) {
    if (seenSids.has(sid)) continue;
    const fp = findSessionFileById(sid);
    if (!fp) continue;
    const parsed = parseDshSessionFile(fp, { maxItems: 1 });
    const tok = parsed?.cumulativeTokens || parsed?.usage?.totalTokens || 0;
    if (tok <= 0) continue;
    scanSessions++;
    const inp = parsed.cumulativeInputTokens || parsed.usage?.inputTokens || 0;
    const cache = parsed.cumulativeCacheReadTokens || parsed.usage?.cacheReadTokens || 0;
    const out = parsed.cumulativeOutputTokens || parsed.usage?.outputTokens || 0;
    const drv = meta.driver || "dsh";
    const mdl = meta.model || profSnap.defaultSelection?.model || "deepseek-v4.1-flash";
    const mKey = mdl.includes("/") ? `${drv}/${mdl.split("/").slice(1).join("/")}` : `${drv}/${mdl}`;
    scanTokens += tok;
    scanInput += inp;
    scanCache += cache;
    scanOutput += out;
    scanByDriver[drv] = (scanByDriver[drv] || 0) + tok;
    const pm = scanByModel[mKey] || { tokens: 0, runs: 0, lastTps: 0 };
    pm.tokens += tok;
    pm.runs += Math.max(1, parsed.stats?.turns || 1);
    if (parsed.lastTps > 0) pm.lastTps = parsed.lastTps;
    scanByModel[mKey] = pm;

    const dMap = parsed.dailyUsage || {};
    const dKeys = Object.keys(dMap);
    if (dKeys.length > 0) {
      for (const dk of dKeys) {
        const rec = dMap[dk];
        addDaily(dk, rec.tokens, rec.inputTokens, rec.cacheReadTokens, rec.outputTokens, Math.max(1, rec.steps || 1));
      }
    } else if (parsed.mtimeMs || parsed.createdAt) {
      const d = new Date(parsed.mtimeMs || parsed.createdAt);
      const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      addDaily(dk, tok, inp, cache, out, Math.max(1, parsed.stats?.turns || 1));
    }
  }

  // Merge scanned historical totals with live profileStore telemetry without double-counting
  const mergedDaily = { ...(base.daily || {}) };
  for (const [dk, rec] of Object.entries(scanDaily)) {
    const b = mergedDaily[dk];
    if (!b || rec.tokens > (b.tokens || 0)) {
      mergedDaily[dk] = {
        tokens: Math.max(rec.tokens, b?.tokens || 0),
        inputTokens: Math.max(rec.inputTokens, b?.inputTokens || 0),
        cacheReadTokens: Math.max(rec.cacheReadTokens, b?.cacheReadTokens || 0),
        outputTokens: Math.max(rec.outputTokens, b?.outputTokens || 0),
        runs: Math.max(rec.runs, b?.runs || 0),
      };
    }
  }

  const mergedByDriver = { ...(base.byDriver || {}) };
  for (const [k, v] of Object.entries(scanByDriver)) {
    mergedByDriver[k] = Math.max(v, mergedByDriver[k] || 0);
  }

  const mergedByModel = { ...(base.byModel || {}) };
  for (const [k, v] of Object.entries(scanByModel)) {
    const b = mergedByModel[k];
    mergedByModel[k] = {
      tokens: Math.max(v.tokens, b?.tokens || 0),
      runs: Math.max(v.runs, b?.runs || 0),
      lastTps: b?.lastTps || v.lastTps || 0,
    };
  }

  unifiedTelemetryCache = {
    ...base,
    allTimeTokens: Math.max(base.allTimeTokens || 0, scanTokens),
    allTimeInputTokens: Math.max(base.allTimeInputTokens || 0, scanInput),
    allTimeCacheReadTokens: Math.max(base.allTimeCacheReadTokens || 0, scanCache),
    allTimeOutputTokens: Math.max(base.allTimeOutputTokens || 0, scanOutput),
    totalRuns: Math.max(base.totalRuns || 0, scanSessions),
    totalSessions: scanSessions,
    byDriver: mergedByDriver,
    byModel: mergedByModel,
    daily: mergedDaily,
  };
  unifiedTelemetryAt = now;
  unifiedTelemetryVer = verKey;
  return unifiedTelemetryCache;
}

function buildStateSnapshot({
  sessionId,
  scopeCwd = "",
  allProjects = false,
  headlessOnly = true,
  pluginOnly = true,
  includeHidden = false,
  maxItems = 180,
  ifNoneMatch = "",
} = {}) {
  const normScope = !allProjects && scopeCwd ? normalizeCwd(scopeCwd) : "";
  const activeIds = getActiveSessionIds();

  let sessions = listAllUnifiedSessions({
    headlessOnly,
    pluginOnly,
    includeHidden,
    activeIds,
  });

  const recentCwds = collectRecentCwds(sessions);

  if (normScope) {
    sessions = sessions.filter((s) => normalizeCwd(s.cwd) === normScope);
  }

  sessions.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });
  sessions = sessions.slice(0, 40);

  const scopedRunObjs = Array.from(runs.values())
    .filter((r) => !normScope || normalizeCwd(r.cwd) === normScope)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 8);

  let selectedId = sessionId || null;
  if (selectedId) {
    const inList = sessions.some((s) => s.sessionId === selectedId);
    const inRuns = scopedRunObjs.some((r) => r.sessionId === selectedId);
    if (!inList && !inRuns) {
      if (normScope || getHiddenSessionIdSet().has(selectedId)) {
        selectedId = null;
      }
    }
  }
  if (!selectedId) {
    const latestScopedActive = scopedRunObjs.find(
      (r) => r.sessionId && isRunActive(r) && !getHiddenSessionIdSet().has(r.sessionId),
    );
    if (latestScopedActive?.sessionId) {
      selectedId = latestScopedActive.sessionId;
    } else if (sessions.length > 0) {
      selectedId = sessions[0].sessionId;
    }
  }

  const activeRunObj = selectedId ? findRunForSession(selectedId) : null;
  const activeRun = serializeRun(activeRunObj);
  const activeRuns = scopedRunObjs.map(serializeRun);
  const profSnap = profileStore.getSnapshot();

  const selectedEntry = sessions.find((s) => s.sessionId === selectedId);
  const etagParts = [
    selectedId || "",
    normScope,
    allProjects ? 1 : 0,
    selectedEntry?.mtimeMs || 0,
    selectedEntry?.sizeBytes || 0,
    sessions.length,
    sessions[0]?.mtimeMs || 0,
    registryVersion,
    profileStore.getVersion(),
    driversVersion,
    headlessOnly ? 1 : 0,
    pluginOnly ? 1 : 0,
    includeHidden ? 1 : 0,
    activeRunObj?.status || "",
    activeRunObj?.phase || "",
    activeRunObj?.step || 0,
    activeRunObj?.stalled ? 1 : 0,
    activeRunObj?.live?.seq || 0,
    activeRuns.map((r) => `${r.runId}:${r.status}:${r.step}:${r.stalled ? 1 : 0}:${r.live?.seq || 0}`).join(","),
  ];
  const etag = crypto
    .createHash("sha1")
    .update(etagParts.join("|"))
    .digest("hex")
    .slice(0, 16);

  if (ifNoneMatch && ifNoneMatch === etag) {
    return {
      unchanged: true,
      etag,
      scopeCwd: normScope ? scopeCwd : "",
      allProjects: !normScope,
      selectedSessionId: selectedId,
      activeRun,
      activeRuns,
      telemetry: getUnifiedTelemetry(profSnap),
      serverTime: Date.now(),
    };
  }

  const activeSession = loadSessionView(selectedId, maxItems);

  // Deduplicate live stream against already-flushed cards
  if (activeRun?.live?.active && activeSession?.items?.length) {
    const live = activeRun.live;
    const recentTail = activeSession.items.slice(-6);
    const liveStep = live.step || 0;
    const matchedReasoning =
      live.reasoning &&
      recentTail.some(
        (it) =>
          it.kind === "reasoning" &&
          (it.step || 0) >= liveStep &&
          it.text.startsWith(live.reasoning.trim().slice(0, 48)),
      );
    const matchedText =
      live.text &&
      recentTail.some(
        (it) =>
          it.kind === "text" &&
          (it.step || 0) >= liveStep &&
          it.text.startsWith(live.text.trim().slice(0, 48)),
      );
    if (matchedReasoning) live.reasoning = "";
    if (matchedText) live.text = "";
    if (!live.reasoning && !live.text && !live.toolName) {
      activeRun.live = null;
    }
  }

  return {
    unchanged: false,
    etag,
    scopeCwd: normScope ? scopeCwd : "",
    allProjects: !normScope,
    selectedSessionId: selectedId,
    headlessOnly,
    pluginOnly,
    recentCwds,
    drivers: getDetectedDrivers(false),
    defaultSelection: profSnap.defaultSelection,
    settings: profSnap.settings,
    customProfiles: profSnap.customProfiles,
    telemetry: getUnifiedTelemetry(profSnap),
    sessions,
    activeRun,
    activeRuns,
    session: activeSession,
    serverTime: Date.now(),
  };
}

// ---------------------------------------------------------------- MCP Server

const server = new McpServer({
  name: "alilas",
  version: "3.3.0",
});

registerAppResource(
  server,
  "ALilaS",
  APP_URI,
  {
    description: "ALilaS (better-subagent): 多引擎子代理实时思维链、模型切换与上下文/TPS 遥测面板",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
  },
  async () => {
    let html;
    try {
      html = fs.readFileSync(APP_HTML_PATH, "utf8");
    } catch (e) {
      html = `<!doctype html><html><body><h3>UI 尚未构建，请运行 node ui/build.mjs</h3><pre>${String(e.message)}</pre></body></html>`;
    }
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    };
  },
);

// 1) Open or focus side pane
registerAppTool(
  server,
  "alilas_open_pane",
  {
    title: "ALilaS",
    description:
      "在 Antigravity 侧边栏打开或刷新 ALilaS 增强子代理面板。传入 session_id 或 cwd 自动按当前项目隔离显示。",
    inputSchema: {
      session_id: z.string().optional().describe("可选：指定会话 ID；自动反推项目目录隔离"),
      cwd: z.string().optional().describe("可选：当前项目目录，用于默认项目隔离"),
      headless_only: z.boolean().optional().describe("可选：是否仅显示子代理会话（默认 true）"),
      all_projects: z.boolean().optional().describe("可选：设为 true 显示跨所有项目会话"),
    },
    _meta: PANE_META,
  },
  async (args = {}) => {
    const inferredCwd =
      args.all_projects === true
        ? ""
        : (args.cwd || "").trim() || resolveCwdForSessionId(args.session_id);
    const snap = buildStateSnapshot({
      sessionId: args.session_id,
      scopeCwd: inferredCwd,
      allProjects: args.all_projects === true || !inferredCwd,
      headlessOnly: args.headless_only ?? true,
      maxItems: 40,
    });
    const s = snap.session;
    const label = s ? s.alias || s.title : "";
    const scopeHint = snap.scopeCwd ? `（项目隔离: ${snap.scopeCwd}）` : "（全部项目）";
    const summary = s
      ? `已打开 ALilaS 面板${scopeHint}：会话 ${s.sessionId} [${s.driver}/${s.model || "default"}]（${label}），思考 ${s.stats.reasoningCount} · 工具 ${s.stats.toolCallCount} · 回复 ${s.stats.textCount}。`
      : `已打开 ALilaS 面板${scopeHint}，当前暂无会话记录。`;
    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        selectedSessionId: snap.selectedSessionId,
        scopeCwd: snap.scopeCwd,
        allProjects: snap.allProjects,
        headlessOnly: snap.headlessOnly,
        activeRun: snap.activeRun,
        sessionsCount: snap.sessions.length,
      },
    };
  },
);

// 2) Start a subagent task (multi-driver + per-run model override + inline project-isolated card)
registerAppTool(
  server,
  "alilas_start_task",
  {
    title: "派活给 ALilaS",
    description:
      "以无头子代理模式异步启动 ALilaS 执行任务，支持 agy（Antigravity 原生）/ dsh（DeepSeek Harness）/ claude / codex 以及独立无注入的 direct 直连 API 五大引擎，每次运行独立传参零冲突，默认不限总时长并启用 180s 静默异常自动检测。",
    inputSchema: {
      task: z.string().min(1).describe("任务说明书（背景、目标文件绝对路径、允许/禁止边界、验收标准）"),
      session_id: z.string().optional().describe("可选：复用已有会话 ID；新主题留空"),
      cwd: z.string().optional().describe("新建会话时的工作目录（务必传当前项目目录）"),
      driver: z
        .enum(["auto", "agy", "dsh", "claude", "codex", "direct"])
        .optional()
        .describe("可选：指定底层驱动（默认按用户配置的默认子代理模型自动选择）"),
      model: z.string().optional().describe("可选：本次运行指定的模型 ID（与并发其他会话零冲突）"),
      effort: z
        .enum(["off", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("可选：推理强度"),
      profile_id: z.string().optional().describe("可选：使用自定义上游模型预设 ID"),
      permission_mode: z
        .enum(["auto", "readonly"])
        .optional()
        .describe("可选：auto（默认自动执行）或 readonly（只读审计/规划）"),
      timeout_sec: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe("可选：总超时硬上限（秒），默认 0 不限总时长"),
      idle_timeout_sec: z
        .number()
        .int()
        .min(60)
        .max(600)
        .optional()
        .describe("可选：无活动卡死告警阈值（秒），默认 180"),
    },
    _meta: INLINE_META,
  },
  async (args) => {
    try {
      const { run, sessionReady } = launchSubagentRun({
        task: args.task,
        sessionId: args.session_id,
        cwd: args.cwd,
        driver: args.driver,
        model: args.model,
        effort: args.effort,
        profileId: args.profile_id,
        permissionMode: args.permission_mode || "auto",
        timeoutSec: args.timeout_sec,
        idleTimeoutSec: args.idle_timeout_sec,
      });

      await Promise.race([
        sessionReady,
        new Promise((r) => setTimeout(r, 10_000)),
      ]);

      const info = serializeRun(run);
      const text = [
        `已启动 ALilaS 任务（run_id: ${info.runId}）`,
        `引擎: ${info.driver} | 模型: ${info.model || "default"} (${info.effort}) | 模式: ${info.permissionMode}`,
        `session_id: ${info.sessionId || "初始化中..."} | cwd: ${info.cwd}`,
        `状态: ${info.status} (${info.phase}) | 无活动告警阈值: ${info.idleTimeoutSec}s`,
        info.error
          ? `错误: ${info.error}`
          : `建议调用 alilas_open_pane(session_id="${info.sessionId || ""}", cwd="${info.cwd}") 同步右侧大窗，再调用 alilas_wait_task(run_id="${info.runId}") 分段等待。`,
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          selectedSessionId: info.sessionId,
          scopeCwd: info.cwd,
          allProjects: false,
          headlessOnly: true,
          activeRun: info,
        },
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `启动 ALilaS 失败: ${e.message}` }],
      };
    }
  },
);

// 3) Heartbeat wait + stall & refusal alerts
server.registerTool(
  "alilas_wait_task",
  {
    title: "等待或查询 ALilaS 任务进度",
    description:
      "分段等待 ALilaS 任务完成（默认 90s；检测卡死自动提前唤醒），返回静默时长、上下文占用、TPS、思维链摘录与完整回复（最高 32K 字）。",
    inputSchema: {
      run_id: z.string().describe("alilas_start_task 返回的 run_id"),
      wait_sec: z.number().int().min(1).max(600).optional().describe("本次最多等待秒数，默认 90"),
      status_only: z.boolean().optional().describe("设为 true 立即返回当前实时进度"),
    },
  },
  async ({ run_id, wait_sec = 90, status_only = false }) => {
    const run = runs.get(run_id);
    if (!run) {
      return { isError: true, content: [{ type: "text", text: `未找到 run_id: ${run_id}` }] };
    }

    if (!status_only && isRunActive(run) && !run.stalled) {
      await Promise.race([
        run.donePromise,
        run.stallPromise,
        new Promise((r) => setTimeout(r, wait_sec * 1000)),
      ]);
    }

    const info = serializeRun(run);
    const parsed = run.sessionId ? loadSessionView(run.sessionId, 60) : null;

    const lines = [
      `run_id: ${info.runId} | session_id: ${info.sessionId || "N/A"} | [${info.driver}/${info.model || "default"}] | cwd: ${info.cwd}`,
      `状态: ${info.status}${info.stalled ? " [STALLED/疑似卡死]" : ""} (${info.phase}) | Turn ${info.turn} Step ${info.step} | 耗时: ${info.elapsedSec}s | 静默: ${info.idleSec}s | exitCode: ${info.exitCode}`,
    ];
    if (info.error) lines.push(`错误: ${info.error}`);

    const usage = info.usage || parsed?.usage;
    const cw = info.contextWindow || parsed?.contextWindow || 200_000;
    if (usage?.totalTokens) {
      const pct = ((usage.totalTokens / cw) * 100).toFixed(1);
      lines.push(
        `遥测: 上下文 ${(usage.totalTokens / 1000).toFixed(1)}K / ${(cw / 1000).toFixed(0)}K (${pct}%) | TPS: ${info.tps || parsed?.lastTps || 0} tok/s | cacheRead: ${((usage.cacheReadTokens || 0) / 1000).toFixed(1)}K`,
      );
    }

    if (parsed?.stats) {
      lines.push(
        `统计: 思考 ${parsed.stats.reasoningCount} 段 | 工具 ${parsed.stats.toolCallCount} 次（本轮 ${run.toolCallsInRun} 次） | 回复 ${parsed.stats.textCount} 条`,
      );
      const recentR = (parsed.items || []).filter((it) => it.kind === "reasoning").slice(-5);
      if (recentR.length) {
        lines.push("\n--- 最近思维链摘录 ---");
        for (const r of recentR) {
          lines.push(`[step ${r.step}] ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
        }
      }
    }

    if (run.live.active && (run.live.reasoning || run.live.text)) {
      lines.push("\n--- 当前实时流 ---");
      if (run.live.reasoning) lines.push(`[思考中] ${run.live.reasoning.slice(-400)}`);
      if (run.live.text) lines.push(`[回复中] ${run.live.text.slice(-400)}`);
    }

    const rawFinal = run.finalText || parsed?.lastAssistantText || "";
    const refusalMatch = rawFinal ? rawFinal.match(REFUSAL_PATTERN) : null;

    if (info.stalled) {
      lines.push(
        `\n⚠️ 疑似卡死告警：已连续 ${info.idleSec}s 无任何活动（阈值 ${info.idleTimeoutSec}s）。若确认卡死，请调用 alilas_stop_task(run_id="${info.runId}") 强杀后重新派活。`,
      );
    } else if (isRunActive(run)) {
      lines.push(
        `\n⏳ 任务仍在推进中（静默 ${info.idleSec}s）。请再次调用 alilas_wait_task(run_id="${info.runId}", wait_sec=90) 继续跟进。`,
      );
    } else if (refusalMatch && run.toolCallsInRun === 0) {
      lines.push(
        `\n⚠️ 上游风控截断告警：本轮 0 次工具调用且回复包含 "${refusalMatch[0]}"，请留空 session_id 用客观技术指令自动重试一次。`,
      );
    }

    if (rawFinal && !isRunActive(run)) {
      const MAX_FINAL = 32000;
      const body =
        rawFinal.length > MAX_FINAL
          ? rawFinal.slice(0, MAX_FINAL) + `\n…（已截断，完整回复共 ${rawFinal.length} 字）`
          : rawFinal;
      lines.push("\n--- ALilaS 最终回复 ---\n" + body);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// 4) Stop task (model-visible)
server.registerTool(
  "alilas_stop_task",
  {
    title: "中止 ALilaS 任务",
    description: "强杀指定 run_id 的子代理及整棵子进程树，释放并发锁便于立即重派。",
    inputSchema: {
      run_id: z.string().describe("要中止的 run_id"),
      reason: z.string().optional().describe("可选：中止原因"),
    },
  },
  async ({ run_id, reason }) => {
    const run = stopRunById(run_id, reason || "stopped_by_model");
    if (!run) {
      return { isError: true, content: [{ type: "text", text: `未找到 run_id: ${run_id}` }] };
    }
    const info = serializeRun(run);
    return {
      content: [
        {
          type: "text",
          text: `已中止 ${info.runId}（[${info.driver}] session_id: ${info.sessionId || "N/A"}，耗时 ${info.elapsedSec}s）。`,
        },
      ],
    };
  },
);

// 5) List available drivers & models (model-visible!)
server.registerTool(
  "alilas_list_models",
  {
    title: "列出可用子代理引擎与模型",
    description: "查看当前机器已安装的引擎（agy / dsh / claude / codex / direct）、原生及直连 API 模型列表与当前默认配置。",
    inputSchema: {
      refresh: z.boolean().optional().describe("设为 true 强制重新探测 CLI 与模型目录"),
    },
  },
  async ({ refresh = false } = {}) => {
    const drivers = getDetectedDrivers(refresh);
    const prof = profileStore.getSnapshot();
    const lines = [
      `默认子代理选择: driver=${prof.defaultSelection.driver || "auto"} | model=${prof.defaultSelection.model || "auto"} | effort=${prof.defaultSelection.effort || "high"}`,
      "",
    ];
    for (const d of drivers) {
      lines.push(`### ${d.label} (${d.id}) — ${d.installed ? "✅ 已就绪" : "⚪ 未安装"} (${d.detail})`);
      if (d.providers?.length) {
        for (const p of d.providers) {
          lines.push(`  - 上游 [${p.displayName || p.key}] (${p.source || "config"}, ${p.models.length} 模型): ${p.models.slice(0, 5).map((m) => `${p.key}/${m.id}`).join(", ")}${p.models.length > 5 ? " ..." : ""}`);
        }
      } else if (d.models?.length) {
        lines.push(d.models.slice(0, 12).map((m) => `  - ${m.id} (${m.name})`).join("\n"));
        if (d.models.length > 12) lines.push(`  ... 等共 ${d.models.length} 个模型`);
      }
    }
    if (prof.customProfiles.length) {
      lines.push("\n### 直连 API 模型预设");
      for (const p of prof.customProfiles) {
        const cap = Array.isArray(p.inputs) && p.inputs.includes("image") ? "text+image" : "text";
        lines.push(`  - ${p.id}: ${p.name} [${p.driver || "direct"}/${p.api || "openai-completions"}/${p.model}] (${cap}, baseURL: ${p.baseURL || "默认"}, keyEnv: ${p.apiKeyEnv || "无"})`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// 6) List sessions
server.registerTool(
  "alilas_list_sessions",
  {
    title: "列出 ALilaS 会话",
    description: "列出各引擎子代理会话，支持按 cwd 过滤当前项目。",
    inputSchema: {
      cwd: z.string().optional().describe("可选：仅列出指定项目目录的会话"),
      headless_only: z.boolean().optional().describe("默认 true"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数，默认 15"),
    },
  },
  async ({ cwd, headless_only = true, limit = 15 } = {}) => {
    const normFilter = cwd ? normalizeCwd(cwd) : "";
    let list = listAllUnifiedSessions({
      headlessOnly: headless_only,
      pluginOnly: false,
      includeHidden: false,
      activeIds: getActiveSessionIds(),
    });
    if (normFilter) list = list.filter((s) => normalizeCwd(s.cwd) === normFilter);
    list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    list = list.slice(0, limit);
    const text = list.length
      ? list
          .map(
            (s) =>
              `- ${s.pinned ? "📌" : ""}${s.sessionId} [${s.isRunning ? "运行中" : s.driver}${
                s.model ? "/" + s.model : ""
              }] (${s.cwd || s.workspaceSlug}) 思:${s.reasoningCount} 工:${s.toolCallCount} | ${
                s.alias || s.title
              }`,
          )
          .join("\n")
      : "暂无符合条件的会话。";
    return { content: [{ type: "text", text }] };
  },
);

// 7) App-only: Poll live state
registerAppTool(
  server,
  "alilas_poll_state",
  {
    title: "轮询 ALilaS 状态（App 内部）",
    description: "按项目隔离轮询会话、运行态、逐字流、驱动模型目录与遥测指标。",
    inputSchema: {
      session_id: z.string().optional(),
      scope_cwd: z.string().optional(),
      all_projects: z.boolean().optional(),
      headless_only: z.boolean().optional(),
      plugin_only: z.boolean().optional(),
      include_hidden: z.boolean().optional(),
      max_items: z.number().int().min(10).max(400).optional(),
      if_none_match: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    const snap = buildStateSnapshot({
      sessionId: args.session_id,
      scopeCwd: args.scope_cwd || "",
      allProjects: args.all_projects ?? !args.scope_cwd,
      headlessOnly: args.headless_only ?? true,
      pluginOnly: args.plugin_only ?? true,
      includeHidden: args.include_hidden ?? false,
      maxItems: args.max_items ?? 180,
      ifNoneMatch: args.if_none_match || "",
    });
    return {
      content: [{ type: "text", text: snap.unchanged ? "unchanged" : "ok" }],
      structuredContent: snap,
    };
  },
);

// 8) App-only: Send task from UI (supports driver/model/effort/profile/permissionMode)
registerAppTool(
  server,
  "alilas_ui_send_task",
  {
    title: "面板派活给 ALilaS（App 内部）",
    description: "供 ALilaS 面板直接按所选引擎、模型与模式派发子代理任务。",
    inputSchema: {
      task: z.string().min(1),
      session_id: z.string().optional(),
      cwd: z.string().optional(),
      driver: z.enum(["auto", "agy", "dsh", "claude", "codex", "direct"]).optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      profile_id: z.string().optional(),
      permission_mode: z.enum(["auto", "readonly"]).optional(),
      timeout_sec: z.number().int().min(0).max(86400).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args) => {
    try {
      const { run, sessionReady } = launchSubagentRun({
        task: args.task,
        sessionId: args.session_id,
        cwd: args.cwd,
        driver: args.driver,
        model: args.model,
        effort: args.effort,
        profileId: args.profile_id,
        permissionMode: args.permission_mode || "auto",
        timeoutSec: args.timeout_sec,
      });
      await Promise.race([
        sessionReady,
        new Promise((r) => setTimeout(r, 8000)),
      ]);
      return {
        content: [{ type: "text", text: "started" }],
        structuredContent: { run: serializeRun(run) },
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: e.message }],
        structuredContent: { error: e.message },
      };
    }
  },
);

// 9) App-only: Stop task from UI
registerAppTool(
  server,
  "alilas_ui_stop_task",
  {
    title: "中止 ALilaS 任务（App 内部）",
    description: "面板停止按钮强杀子进程树。",
    inputSchema: { run_id: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ run_id }) => {
    const run = stopRunById(run_id, "stopped_by_user");
    return {
      content: [{ type: "text", text: "stopped" }],
      structuredContent: { run: serializeRun(run) },
    };
  },
);

// 10) App-only: Manage session metadata
registerAppTool(
  server,
  "alilas_ui_manage_session",
  {
    title: "管理 ALilaS 会话元数据（App 内部）",
    description: "重命名、置顶或隐藏会话。",
    inputSchema: {
      session_id: z.string().min(1),
      action: z.enum(["rename", "pin", "unpin", "hide", "unhide"]),
      alias: z.string().max(60).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ session_id, action, alias }) => {
    if (!registry.sessions[session_id]) {
      registry.sessions[session_id] = {
        driver: session_id.startsWith("session-")
          ? "dsh"
          : session_id.startsWith("direct-")
            ? "direct"
            : "agy",
        model: "",
        effort: "",
        profileId: "",
        alias: "",
        pinned: false,
        hidden: false,
        cwd: resolveCwdForSessionId(session_id),
        createdAt: Date.now(),
      };
    }
    const meta = registry.sessions[session_id];
    if (action === "rename") meta.alias = (alias || "").trim().slice(0, 60);
    else if (action === "pin") meta.pinned = true;
    else if (action === "unpin") meta.pinned = false;
    else if (action === "hide") { meta.hidden = true; meta.pinned = false; }
    else if (action === "unhide") meta.hidden = false;
    saveRegistry(registry);
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { sessionId: session_id, meta },
    };
  },
);

// 11) App-only: Manage model defaults & custom upstream profiles
registerAppTool(
  server,
  "alilas_ui_manage_profiles",
  {
    title: "管理 ALilaS 默认模型与自定义上游（App 内部）",
    description: "设置默认子代理引擎/模型，或增删自定义上游预设（仅存环境变量名，不存明文 Key）。",
    inputSchema: {
      action: z.enum(["set_default", "upsert_profile", "delete_profile", "refresh_drivers", "update_settings"]),
      driver: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      profile_id: z.string().optional(),
      settings: z
        .object({
          idleTimeoutSec: z.number().int().min(60).max(600).optional(),
          scanDshDesktop: z.boolean().optional(),
        })
        .optional(),
      profile: z
        .object({
          id: z.string().optional(),
          name: z.string(),
          driver: z.enum(["direct", "dsh", "claude", "codex", "agy"]).optional(),
          provider: z.string().optional(),
          baseURL: z.string().optional(),
          apiKeyEnv: z.string().optional(),
          api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
          model: z.string(),
          contextWindow: z.number().int().positive().optional(),
          maxTokens: z.number().int().positive().optional(),
          inputs: z.array(z.enum(["text", "image"])).optional(),
          effort: z.string().optional(),
        })
        .optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args) => {
    if (args.action === "set_default") {
      profileStore.setDefaultSelection({
        driver: args.driver ?? "",
        model: args.model ?? "",
        effort: args.effort ?? "high",
        profileId: args.profile_id ?? "",
      });
    } else if (args.action === "upsert_profile" && args.profile) {
      profileStore.upsertCustomProfile(args.profile);
      getDetectedDrivers(true);
    } else if (args.action === "delete_profile" && args.profile_id) {
      profileStore.deleteCustomProfile(args.profile_id);
      getDetectedDrivers(true);
    } else if (args.action === "update_settings" && args.settings) {
      profileStore.updateSettings(args.settings);
      getDetectedDrivers(true);
    } else if (args.action === "refresh_drivers") {
      getDetectedDrivers(true);
    }
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        drivers: getDetectedDrivers(false),
        ...profileStore.getSnapshot(),
      },
    };
  },
);

// Graceful shutdown
function cleanup() {
  for (const r of runs.values()) {
    if (isRunActive(r)) {
      clearTimeout(r.timer);
      clearInterval(r.watchdog);
      killProcessTree(r.child);
    }
  }
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
