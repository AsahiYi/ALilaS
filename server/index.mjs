import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  listSessions,
  parseSessionFile,
} from "./dsh_reader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT =
  process.env.LILAS_PLUGIN_ROOT || path.resolve(__dirname, "..");
const DATA_DIR =
  process.env.LILAS_DATA_DIR || path.join(PLUGIN_ROOT, "data");
const REGISTRY_FILE = path.join(DATA_DIR, "plugin_sessions.json");
const STREAM_PATCH_FILE = path.join(DATA_DIR, "stream_probe_patch.yml");
const STREAM_PROBE_PATH = path.join(__dirname, "stream_probe.mjs");
const SEED_SESSIONS = [];

const APP_URI = "ui://lilas/app.html";
const APP_HTML_PATH =
  process.env.LILAS_APP_HTML || path.join(PLUGIN_ROOT, "ui", "dist", "app.html");
const DEFAULT_PATCH_FILE = path.join(PLUGIN_ROOT, "config", "mode_a_patch.yml");
const PATCH_FILE =
  process.env.LILAS_PATCH_FILE ||
  (fs.existsSync(DEFAULT_PATCH_FILE) ? DEFAULT_PATCH_FILE : "");
const DEFAULT_CWD =
  process.env.LILAS_DEFAULT_CWD || process.cwd() || os.homedir();
const STREAM_PREFIX = "__LILAS_STREAM__";

function resolveDshSpawnSpec() {
  const configured = (process.env.LILAS_DSH_BIN || "").trim();
  if (configured) {
    if (/\.(?:c|m)?js$/i.test(configured)) {
      return { cmd: process.execPath, prefixArgs: [configured] };
    }
    return { cmd: configured, prefixArgs: [] };
  }
  return {
    cmd: process.platform === "win32" ? "dsh.cmd" : "dsh",
    prefixArgs: [],
  };
}

const REFUSAL_PATTERN =
  /(?:Sorry,\s*I\s*can(?:'|’)?t\s*(?:respond|assist|help)\s*to\s*this|I(?:'|’)?m\s*sorry,?\s*(?:but\s*)?I\s*can(?:'|’)?t\s*(?:assist|help|respond))/i;

function normalizeCwd(p) {
  if (!p || typeof p !== "string") return "";
  try {
    return path.resolve(p.trim()).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return p.trim().replace(/[\\/]+$/, "").toLowerCase();
  }
}

// ---------------------------------------------------------------- Registry v2

let registryVersion = 1;

function createEmptyRegistry() {
  const sessions = {};
  for (const sid of SEED_SESSIONS) {
    sessions[sid] = {
      alias: "",
      pinned: false,
      hidden: false,
      cwd: DEFAULT_CWD,
      createdAt: Date.now(),
    };
  }
  return {
    version: 2,
    recentCwds: [DEFAULT_CWD],
    sessions,
  };
}

function loadRegistry() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
      if (Array.isArray(raw)) {
        const reg = createEmptyRegistry();
        reg.sessions = {};
        for (const sid of raw) {
          if (typeof sid === "string" && sid.trim()) {
            reg.sessions[sid] = {
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
        return {
          version: 2,
          recentCwds: Array.isArray(raw.recentCwds) ? raw.recentCwds.filter(Boolean) : [DEFAULT_CWD],
          sessions: raw.sessions,
        };
      }
    }
  } catch {
    // fallback to seeded
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

function recordPluginSession(sessionId, { cwd } = {}) {
  if (!sessionId) return;
  let changed = false;
  if (!registry.sessions[sessionId]) {
    registry.sessions[sessionId] = {
      alias: "",
      pinned: false,
      hidden: false,
      cwd: cwd || "",
      createdAt: Date.now(),
    };
    changed = true;
  } else if (cwd && !registry.sessions[sessionId].cwd) {
    registry.sessions[sessionId].cwd = cwd;
    changed = true;
  }
  if (cwd) {
    const before = registry.recentCwds[0];
    recordRecentCwd(cwd);
    if (registry.recentCwds[0] !== before) changed = true;
  }
  if (changed) saveRegistry(registry);
}

function ensureStreamProbePatch() {
  try {
    if (!fs.existsSync(STREAM_PROBE_PATH)) return null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const probeUrl = pathToFileURL(STREAM_PROBE_PATH).href;
    const content = `- insert:\n    - id: lilas-stream-probe\n      name: ${JSON.stringify(probeUrl)}\n`;
    if (!fs.existsSync(STREAM_PATCH_FILE) || fs.readFileSync(STREAM_PATCH_FILE, "utf8") !== content) {
      fs.writeFileSync(STREAM_PATCH_FILE, content, "utf8");
    }
    return STREAM_PATCH_FILE;
  } catch {
    return null;
  }
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
        try {
          child.kill();
        } catch {
          // ignore
        }
      });
      return;
    } catch {
      // fallback below
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- MCP Metadata

const PANE_META = {
  ui: { resourceUri: APP_URI },
  "com.google.antigravity/ui": {
    entrypoints: [
      { type: "aux_pane", title: "LilaS" },
      { type: "global", title: "LilaS" },
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
let latestRunId = null;

function isRunActive(run) {
  return Boolean(run && (run.status === "starting" || run.status === "running"));
}

function touchRunActivity(run) {
  if (!run) return;
  run.lastActivityAt = Date.now();
  if (run.stalled) {
    run.stalled = false;
    if (run.phase === "stalled") run.phase = "running";
    // Recreate stallPromise for future stall detection
    run.stallPromise = new Promise((res) => {
      run.resolveStall = res;
    });
  }
}

function serializeRun(run) {
  if (!run) return null;
  const now = Date.now();
  const elapsedMs = (run.endedAt || now) - run.startedAt;
  const idleMs = isRunActive(run) ? Math.max(0, now - run.lastActivityAt) : 0;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    taskPreview: run.task.slice(0, 180),
    cwd: run.cwd,
    status: run.status, // starting | running | done | error | timeout | stopped
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
    usage: run.live.usage || run.lastStepUsage || null,
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
    if (r.sessionId && isRunActive(r)) {
      s.add(r.sessionId);
    }
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
  const fp = findSessionFileById(sessionId);
  if (fp) {
    const parsed = parseSessionFile(fp, { maxItems: 1 });
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

function launchLilaSRun({ task, sessionId, cwd, timeoutSec, idleTimeoutSec }) {
  let workDir = (cwd || "").trim() || DEFAULT_CWD;

  if (sessionId) {
    const existing = findRunForSession(sessionId);
    if (existing && isRunActive(existing)) {
      throw new Error(
        `会话 ${sessionId} 正在运行中（${existing.runId}），禁止对同一会话并发派活。如需中止旧任务请先调 lilas_stop_task("${existing.runId}")，如需多开并行请留空 session_id。`,
      );
    }
    const check = inspectSessionForResume(sessionId);
    if (!check.adoptable) {
      throw new Error(check.reason);
    }
    workDir = check.cwd;
  } else {
    if (!fs.existsSync(workDir)) {
      throw new Error(`工作目录不存在: ${workDir}`);
    }
  }

  const runId = `run-${crypto.randomBytes(4).toString("hex")}`;
  // Default: no hard wall-clock limit (0 = unlimited) so active long-running tasks are never killed mid-work.
  // Only set a hard wall-clock timer if caller explicitly requests timeoutSec > 0.
  const timeoutMs =
    typeof timeoutSec === "number" && timeoutSec > 0
      ? Math.max(30, Math.min(timeoutSec, 86400)) * 1000
      : 0;
  const clampedIdleSec = Math.max(60, Math.min(idleTimeoutSec || 180, 600));

  const dshSpec = resolveDshSpawnSpec();
  const args = [
    ...dshSpec.prefixArgs,
    "--profile",
    "headless",
  ];
  if (PATCH_FILE && fs.existsSync(PATCH_FILE)) {
    args.push("--patch", PATCH_FILE);
  }
  const probePatch = ensureStreamProbePatch();
  if (probePatch) {
    args.push("--patch", probePatch);
  }
  args.push("--json");
  if (sessionId) {
    args.push("--session-id", sessionId);
  }
  args.push("-");

  let resolveSession;
  const sessionReady = new Promise((res) => {
    resolveSession = res;
  });

  let resolveDone;
  const donePromise = new Promise((res) => {
    resolveDone = res;
  });

  let resolveStall;
  const stallPromise = new Promise((res) => {
    resolveStall = res;
  });

  const now = Date.now();
  const run = {
    runId,
    sessionId: sessionId || null,
    task,
    cwd: workDir,
    status: "starting",
    phase: "booting",
    turn: 0,
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
    lastStepUsage: null,
    live: {
      active: false,
      seq: 0,
      step: 0,
      reasoning: "",
      text: "",
      toolName: "",
      usage: null,
    },
    child: null,
    timer: null,
    watchdog: null,
    donePromise,
    resolveDone,
    resolveSession,
    stallPromise,
    resolveStall,
  };

  if (sessionId) {
    recordPluginSession(sessionId, { cwd: workDir });
  } else {
    recordRecentCwd(workDir);
    saveRegistry(registry);
  }

  runs.set(runId, run);
  latestRunId = runId;

  if (runs.size > 30) {
    for (const [k, v] of runs.entries()) {
      if (!isRunActive(v)) {
        runs.delete(k);
        if (runs.size <= 25) break;
      }
    }
  }

  const child = spawn(dshSpec.cmd, args, {
    cwd: workDir,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(dshSpec.cmd),
  });
  run.child = child;

  try {
    child.stdin.write(task, "utf8");
    child.stdin.end();
  } catch (e) {
    run.error = `stdin 写入失败: ${e.message}`;
  }

  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    touchRunActivity(run);
    stdoutBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "session" && ev.sessionId) {
          run.sessionId = ev.sessionId;
          recordPluginSession(ev.sessionId, { cwd: workDir });
          run.status = "running";
          run.phase = "session_ready";
          resolveSession(ev.sessionId);
        } else if (ev.type === "status") {
          run.status = "running";
          if (ev.phase) run.phase = ev.phase;
          if (typeof ev.turn === "number") run.turn = ev.turn;
          if (typeof ev.step === "number") run.step = ev.step;
          if (ev.usage && typeof ev.usage === "object") {
            run.lastStepUsage = ev.usage;
          }
          if (ev.phase === "turn_end") {
            run.live.active = false;
            run.live.reasoning = "";
            run.live.text = "";
            run.live.toolName = "";
            run.live.seq++;
          }
          if (ev.reason?.kind === "error") {
            const msg = ev.reason?.error?.message || JSON.stringify(ev.reason);
            run.error = msg;
          }
        } else if (ev.type === "thinking" || ev.type === "text") {
          run.live.seq++;
        } else if (ev.type === "tool_call") {
          run.toolCallsInRun++;
          run.phase = `tool:${ev.tool || "exec"}`;
          run.live.toolName = ev.tool || "";
          run.live.seq++;
        } else if (ev.type === "tool_result") {
          run.live.toolName = "";
          run.live.seq++;
        } else if (ev.type === "final") {
          if (typeof ev.text === "string" && ev.text.trim()) {
            run.finalText = ev.text.trim();
          }
        } else if (ev.type === "error") {
          run.error = ev.message || JSON.stringify(ev);
        }
      } catch {
        // ignore non-json stdout line
      }
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
    let idx;
    while ((idx = stderrBuf.indexOf("\n")) !== -1) {
      const rawLine = stderrBuf.slice(0, idx);
      stderrBuf = stderrBuf.slice(idx + 1);
      if (rawLine.startsWith(STREAM_PREFIX)) {
        try {
          const ev = JSON.parse(rawLine.slice(STREAM_PREFIX.length));
          if (ev.sessionId && run.sessionId && ev.sessionId !== run.sessionId) {
            continue;
          }
          touchRunActivity(run);
          if (ev.type === "stream_start") {
            run.live.active = true;
            run.live.step = run.step || 1;
            run.live.reasoning = "";
            run.live.text = "";
            run.live.toolName = "";
            run.live.seq++;
          } else if (ev.type === "stream_end") {
            run.live.seq++;
          } else if (ev.type === "reasoning_delta" && ev.text) {
            run.live.active = true;
            if (!run.live.step) run.live.step = run.step || 1;
            run.phase = "thinking";
            run.live.reasoning = (run.live.reasoning + ev.text).slice(-16000);
            run.live.seq++;
          } else if (ev.type === "text_delta" && ev.text) {
            run.live.active = true;
            if (!run.live.step) run.live.step = run.step || 1;
            run.phase = "writing";
            run.live.text = (run.live.text + ev.text).slice(-16000);
            run.live.seq++;
          } else if (ev.type === "tool_delta" && ev.toolName) {
            run.live.active = true;
            run.live.toolName = ev.toolName;
            run.phase = `tool:${ev.toolName}`;
            run.live.seq++;
          } else if (ev.type === "usage" && ev.usage) {
            run.live.usage = ev.usage;
            run.live.seq++;
          }
        } catch {
          // ignore malformed stream line
        }
      } else if (rawLine.trim()) {
        touchRunActivity(run);
        run.stderrTail = (run.stderrTail + rawLine + "\n").slice(-2000);
      }
    }
  });

  // Idle watchdog: wake up waiting model early if subagent produces zero output for idleTimeoutSec
  run.watchdog = setInterval(() => {
    if (!isRunActive(run)) {
      clearInterval(run.watchdog);
      return;
    }
    // Check if disk session log grew silently
    if (run.sessionId) {
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
  }, 10000);

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

  child.on("close", (code) => {
    clearTimeout(run.timer);
    clearInterval(run.watchdog);
    run.exitCode = code;
    run.endedAt = Date.now();
    run.stalled = false;
    run.live.active = false;
    if (stderrBuf.trim() && !stderrBuf.startsWith(STREAM_PREFIX)) {
      run.stderrTail = (run.stderrTail + stderrBuf).slice(-2000);
    }
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

// ---------------------------------------------------------------- Snapshot

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

  let sessions = listSessions({
    headlessOnly,
    allWorkspaces: true,
    allowedSessionIds: pluginOnly ? getPluginSessionIdSet() : null,
    hiddenSessionIds: includeHidden ? null : getHiddenSessionIdSet(),
    limit: 60,
    activeSessionIds: activeIds,
  });

  // Collect recentCwds before scoping filter so the cwd picker still knows all projects
  const recentCwds = collectRecentCwds(sessions);

  sessions = sessions.map((s) => {
    const meta = registry.sessions[s.sessionId] || {};
    return {
      ...s,
      alias: meta.alias || "",
      pinned: Boolean(meta.pinned),
      hidden: Boolean(meta.hidden),
    };
  });

  // Ensure running sessions (even before file flush) appear in list
  const knownIds = new Set(sessions.map((s) => s.sessionId));
  for (const r of runs.values()) {
    if (r.sessionId && !knownIds.has(r.sessionId)) {
      const meta = registry.sessions[r.sessionId] || {};
      sessions.unshift({
        sessionId: r.sessionId,
        workspaceSlug: cwdToWorkspaceSlug(r.cwd),
        title: r.task.slice(0, 48),
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
        usage: r.live.usage || r.lastStepUsage || null,
      });
    }
  }

  // Apply project scope isolation when scopeCwd is active and allProjects is false
  if (normScope) {
    sessions = sessions.filter((s) => normalizeCwd(s.cwd) === normScope);
  }

  // Sort: running first, then pinned, then mtime desc
  sessions.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });
  sessions = sessions.slice(0, 35);

  // Scoped activeRuns (never leak other projects' chips unless allProjects=true)
  const scopedRunObjs = Array.from(runs.values())
    .filter((r) => !normScope || normalizeCwd(r.cwd) === normScope)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 8);

  let selectedId = sessionId || null;
  if (selectedId) {
    const inList = sessions.some((s) => s.sessionId === selectedId);
    const inRuns = scopedRunObjs.some((r) => r.sessionId === selectedId);
    if (!inList && !inRuns) {
      if (normScope) {
        selectedId = null;
      } else {
        const fp = findSessionFileById(selectedId);
        if (!fp || getHiddenSessionIdSet().has(selectedId)) {
          selectedId = null;
        }
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

  // Lightweight ETag
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
      serverTime: Date.now(),
    };
  }

  let activeSession = null;
  if (selectedId) {
    const fp = findSessionFileById(selectedId);
    if (fp) {
      activeSession = parseSessionFile(fp, { maxItems });
      const meta = registry.sessions[selectedId] || {};
      activeSession.alias = meta.alias || "";
      activeSession.pinned = Boolean(meta.pinned);
      activeSession.hidden = Boolean(meta.hidden);
    } else {
      const r = findRunForSession(selectedId);
      const meta = registry.sessions[selectedId] || {};
      activeSession = {
        sessionId: selectedId,
        title: r ? r.task.slice(0, 48) : selectedId,
        alias: meta.alias || "",
        pinned: Boolean(meta.pinned),
        hidden: Boolean(meta.hidden),
        cwd: r ? r.cwd : scopeCwd || DEFAULT_CWD,
        isHeadless: true,
        usage: r?.live?.usage || r?.lastStepUsage || null,
        stats: {
          totalEvents: 0,
          turns: r?.turn || 0,
          steps: r?.step || 0,
          reasoningCount: 0,
          toolCallCount: 0,
          textCount: 0,
          totalTimelineItems: r ? 1 : 0,
          truncatedItems: false,
        },
        items: r
          ? [{ kind: "user", seq: 0, turn: 1, step: 0, text: r.task, charCount: r.task.length }]
          : [],
      };
    }
  }

  // Deduplicate live stream against already-flushed .zstd cards
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
    sessions,
    activeRun,
    activeRuns,
    session: activeSession,
    serverTime: Date.now(),
  };
}

// ---------------------------------------------------------------- MCP Server

const server = new McpServer({
  name: "lilas-subagent",
  version: "2.1.0",
});

registerAppResource(
  server,
  "LilaS",
  APP_URI,
  {
    description: "LilaS 子代理实时面板：查看原生思维链、工具调用、上下文用量与项目隔离分身状态",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
  async () => {
    let html;
    try {
      html = fs.readFileSync(APP_HTML_PATH, "utf8");
    } catch (e) {
      html = `<!doctype html><html><body><h3>UI 尚未构建</h3><pre>${String(e.message)}</pre></body></html>`;
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

// 1) Open or focus the side pane (ONLY UI tool — eliminates duplicate inline panes)
registerAppTool(
  server,
  "lilas_open_pane",
  {
    title: "LilaS",
    description:
      "在 Antigravity 侧边栏打开或刷新 LilaS 实时思维链面板。传入 session_id 或 cwd 时自动按该项目隔离显示，不串其他项目的子代理。",
    inputSchema: {
      session_id: z
        .string()
        .optional()
        .describe("可选：指定要展示的会话 ID；自动反推所属项目目录进行隔离"),
      cwd: z
        .string()
        .optional()
        .describe("可选：当前项目根目录，用于将面板默认隔离在当前项目内"),
      headless_only: z
        .boolean()
        .optional()
        .describe("可选：是否仅显示 Mode A 子代理会话（默认 true）"),
      all_projects: z
        .boolean()
        .optional()
        .describe("可选：设为 true 时跨所有项目展示全部会话"),
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
      ? `已打开 LilaS 面板${scopeHint}：会话 ${s.sessionId}（${label}），共 ${s.stats.reasoningCount} 段思维链、${s.stats.toolCallCount} 次工具调用、${s.stats.textCount} 条回复。`
      : `已打开 LilaS 面板${scopeHint}，当前暂无 Mode A 会话记录。`;
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

// 2) Start a Mode A subagent task (renders project-isolated inline card in chat + syncs with side pane)
registerAppTool(
  server,
  "lilas_start_task",
  {
    title: "派活给 LilaS",
    description:
      "以 Mode A（dsh headless）异步启动 LilaS 子代理执行任务，在对话流内展示按当前项目隔离的紧凑 LilaS 状态卡并返回 run_id、session_id 与 cwd。启动后可调用 lilas_open_pane(session_id, cwd) 同步右侧大窗，再调用 lilas_wait_task(run_id) 分段等待并验收。",
    inputSchema: {
      task: z.string().min(1).describe("任务说明书（背景、目标文件绝对路径、允许/禁止边界、验收标准）"),
      session_id: z
        .string()
        .optional()
        .describe("可选：复用已有 Mode A 会话 ID（自动继承原 cwd，前置拦截桌面端会话）；新主题留空"),
      cwd: z
        .string()
        .optional()
        .describe("新建会话时的工作目录（务必传当前项目目录）；复用 session_id 时自动继承原会话 cwd"),
      timeout_sec: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .optional()
        .describe("可选：总超时硬上限（秒），默认 0 表示不限制总时长（防误杀长任务，仅靠无活动看门狗监测卡死）"),
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
      const { run, sessionReady } = launchLilaSRun({
        task: args.task,
        sessionId: args.session_id,
        cwd: args.cwd,
        timeoutSec: args.timeout_sec,
        idleTimeoutSec: args.idle_timeout_sec,
      });

      // Wait up to 10s for Windows cold-start DSH to emit exact sessionId
      await Promise.race([
        sessionReady,
        new Promise((r) => setTimeout(r, 10000)),
      ]);

      const info = serializeRun(run);
      const text = [
        `已启动 LilaS 任务（run_id: ${info.runId}）`,
        `session_id: ${info.sessionId || "初始化中..."} | cwd: ${info.cwd}`,
        `状态: ${info.status} (${info.phase}) | 无活动告警阈值: ${info.idleTimeoutSec}s`,
        info.error
          ? `错误: ${info.error}`
          : `建议紧接着调用 lilas_open_pane(session_id="${info.sessionId || ""}", cwd="${info.cwd}") 同步右侧大窗，再调用 lilas_wait_task(run_id="${info.runId}") 分段等待。`,
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
        content: [{ type: "text", text: `启动 LilaS 失败: ${e.message}` }],
      };
    }
  },
);

// 3) Wait for (or inspect status of) a started run with heartbeat & stall/refusal alerts
server.registerTool(
  "lilas_wait_task",
  {
    title: "等待或查询 LilaS 任务进度",
    description:
      "分段等待 LilaS 任务完成（默认每次最多等 90 秒；若检测到无活动卡死会提前唤醒）。返回状态、静默时长 idleSec、思维链摘录、完整回复及风控截断告警。",
    inputSchema: {
      run_id: z.string().describe("lilas_start_task 返回的 run_id"),
      wait_sec: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe("本次最多等待秒数，默认 90（推荐 60~120 分段轮询，避免盲等 10 分钟）"),
      status_only: z
        .boolean()
        .optional()
        .describe("设为 true 时不阻塞等待，立即返回当前阶段、步数、静默秒数与实时思维链"),
    },
  },
  async ({ run_id, wait_sec = 90, status_only = false }) => {
    const run = runs.get(run_id);
    if (!run) {
      return {
        isError: true,
        content: [{ type: "text", text: `未找到 run_id: ${run_id}` }],
      };
    }

    if (!status_only && isRunActive(run) && !run.stalled) {
      await Promise.race([
        run.donePromise,
        run.stallPromise,
        new Promise((r) => setTimeout(r, wait_sec * 1000)),
      ]);
    }

    const info = serializeRun(run);
    let parsed = null;
    if (run.sessionId) {
      const fp = findSessionFileById(run.sessionId);
      if (fp) parsed = parseSessionFile(fp, { maxItems: 60 });
    }

    const lines = [
      `run_id: ${info.runId} | session_id: ${info.sessionId || "N/A"} | cwd: ${info.cwd}`,
      `状态: ${info.status}${info.stalled ? " [STALLED/疑似卡死]" : ""} (${info.phase}) | Turn ${info.turn} Step ${info.step} | 已耗时: ${info.elapsedSec}s | 静默: ${info.idleSec}s | exitCode: ${info.exitCode}`,
    ];
    if (info.error) lines.push(`错误: ${info.error}`);

    const usage = info.usage || parsed?.usage;
    if (usage?.totalTokens) {
      const pct = ((usage.totalTokens / 1_000_000) * 100).toFixed(1);
      lines.push(
        `上下文: ${(usage.totalTokens / 1000).toFixed(1)}K / 1M (${pct}%) | cacheRead: ${((usage.cacheReadTokens || 0) / 1000).toFixed(1)}K`,
      );
    }

    if (parsed?.stats) {
      lines.push(
        `统计: 思维链 ${parsed.stats.reasoningCount} 段 | 工具调用 ${parsed.stats.toolCallCount} 次（本次运行 ${run.toolCallsInRun} 次） | 回复 ${parsed.stats.textCount} 条`,
      );
      const recentReasonings = (parsed.items || [])
        .filter((it) => it.kind === "reasoning")
        .slice(-5);
      if (recentReasonings.length) {
        lines.push("\n--- 最近原生思维链摘录 ---");
        for (const r of recentReasonings) {
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
        `\n⚠️ 疑似卡死告警：子代理已连续 ${info.idleSec}s 无任何输出/工具活动（阈值 ${info.idleTimeoutSec}s）。请判断是否卡住；若确认卡死，请立即调用 lilas_stop_task(run_id="${info.runId}") 强杀进程树，然后重新派活。`,
      );
    } else if (isRunActive(run)) {
      lines.push(
        `\n⏳ 任务仍在正常推进中（未完成，距上次活动 ${info.idleSec}s）。请再次调用 lilas_wait_task(run_id="${info.runId}", wait_sec=90) 继续跟进，勿假定已完成。`,
      );
    } else if (refusalMatch && run.toolCallsInRun === 0) {
      lines.push(
        `\n⚠️ 上游风控截断告警：本轮 0 次工具调用且回复包含 "${refusalMatch[0]}"，子代理未执行实际任务！请自动重新派活（建议留空 session_id 新开会话，并用简洁客观的技术指令描述任务）。`,
      );
    }

    if (rawFinal && !isRunActive(run)) {
      const MAX_FINAL = 32000;
      const body =
        rawFinal.length > MAX_FINAL
          ? rawFinal.slice(0, MAX_FINAL) + `\n…（已截断，完整回复共 ${rawFinal.length} 字）`
          : rawFinal;
      lines.push("\n--- LilaS 最终回复 ---\n" + body);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

// 4) Stop a running/stalled task (Model-visible!)
server.registerTool(
  "lilas_stop_task",
  {
    title: "中止卡死或运行中的 LilaS 任务",
    description:
      "强杀指定 run_id 的 LilaS 子代理及其 Windows 子进程树，释放同一 session_id 的并发锁，方便立即重新派活。",
    inputSchema: {
      run_id: z.string().describe("要中止的 run_id"),
      reason: z.string().optional().describe("可选：中止原因（默认 stopped_by_model）"),
    },
  },
  async ({ run_id, reason }) => {
    const run = stopRunById(run_id, reason || "stopped_by_model");
    if (!run) {
      return {
        isError: true,
        content: [{ type: "text", text: `未找到 run_id: ${run_id}` }],
      };
    }
    const info = serializeRun(run);
    return {
      content: [
        {
          type: "text",
          text: `已中止任务 ${info.runId}（session_id: ${info.sessionId || "N/A"}，耗时 ${info.elapsedSec}s）。现在可以安全地重新调用 lilas_start_task 派活。`,
        },
      ],
    };
  },
);

// 5) List sessions (model tool)
server.registerTool(
  "lilas_list_sessions",
  {
    title: "列出 LilaS 会话",
    description: "列出本机 Mode A 子代理会话；可按 cwd 过滤当前项目，或省略 cwd 跨项目列出。",
    inputSchema: {
      cwd: z.string().optional().describe("可选：仅列出指定项目目录的会话"),
      headless_only: z.boolean().optional().describe("默认 true，仅列 Mode A 子代理会话"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数，默认 15"),
    },
  },
  async ({ cwd, headless_only = true, limit = 15 } = {}) => {
    const normFilter = cwd ? normalizeCwd(cwd) : "";
    let list = listSessions({
      headlessOnly: headless_only,
      allWorkspaces: true,
      hiddenSessionIds: getHiddenSessionIdSet(),
      limit: normFilter ? 60 : limit,
      activeSessionIds: getActiveSessionIds(),
    });
    if (normFilter) {
      list = list.filter((s) => normalizeCwd(s.cwd) === normFilter).slice(0, limit);
    }
    const text = list.length
      ? list
          .map((s) => {
            const meta = registry.sessions[s.sessionId] || {};
            const label = meta.alias ? `${meta.alias} · ${s.title}` : s.title;
            const pin = meta.pinned ? "📌" : "";
            return `- ${pin}${s.sessionId} [${s.isRunning ? "运行中" : s.isHeadless ? "Mode A" : "桌面端"}] (${s.cwd || s.workspaceSlug}) 思维链:${s.reasoningCount} 工具:${s.toolCallCount} | ${label}`;
          })
          .join("\n")
      : "暂无符合条件的会话。";
    return { content: [{ type: "text", text }] };
  },
);

// 6) App-only: Poll live state & timeline with project scoping & ETag
registerAppTool(
  server,
  "lilas_poll_state",
  {
    title: "轮询 LilaS 实时状态（App 内部）",
    description: "供 LilaS 面板按项目隔离轮询会话列表、运行状态、打字机流与时间线。",
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

// 7) App-only: Send a task directly from the side pane UI
registerAppTool(
  server,
  "lilas_ui_send_task",
  {
    title: "面板内派活给 LilaS（App 内部）",
    description: "供 LilaS 面板直接发送 Mode A 任务。",
    inputSchema: {
      task: z.string().min(1),
      session_id: z.string().optional(),
      cwd: z.string().optional(),
      timeout_sec: z.number().int().min(0).max(86400).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args) => {
    try {
      const { run, sessionReady } = launchLilaSRun({
        task: args.task,
        sessionId: args.session_id,
        cwd: args.cwd,
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

// 8) App-only: Stop a running task from UI
registerAppTool(
  server,
  "lilas_ui_stop_task",
  {
    title: "中止 LilaS 当前任务（App 内部）",
    description: "供 LilaS 面板中止正在运行的子代理任务及其子进程树。",
    inputSchema: {
      run_id: z.string(),
    },
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

// 9) App-only: Manage session metadata (rename / pin / hide)
registerAppTool(
  server,
  "lilas_ui_manage_session",
  {
    title: "管理 LilaS 会话元数据（App 内部）",
    description: "为会话设置别名、置顶或从列表隐藏（不修改硬盘原始日志）。",
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
        alias: "",
        pinned: false,
        hidden: false,
        cwd: resolveCwdForSessionId(session_id),
        createdAt: Date.now(),
      };
    }
    const meta = registry.sessions[session_id];
    if (action === "rename") {
      meta.alias = (alias || "").trim().slice(0, 60);
    } else if (action === "pin") {
      meta.pinned = true;
    } else if (action === "unpin") {
      meta.pinned = false;
    } else if (action === "hide") {
      meta.hidden = true;
      meta.pinned = false;
    } else if (action === "unhide") {
      meta.hidden = false;
    }
    saveRegistry(registry);
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { sessionId: session_id, meta },
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
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
