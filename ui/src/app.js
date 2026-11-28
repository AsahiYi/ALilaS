import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { escapeHtml, renderMarkdown } from "./markdown.js";

const app = new App({ name: "alilas", version: "3.3.1" }, {});

const API_LABELS = {
  "openai-completions": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

const EFFORT_LABELS = {
  off: "关",
  none: "无",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "满档",
};

const EFFORT_ORDER = {
  off: 0,
  none: 1,
  minimal: 2,
  low: 3,
  medium: 4,
  high: 5,
  xhigh: 6,
  max: 7,
};

function createDefaultDirectDraft() {
  return {
    name: "",
    api: "openai-completions",
    model: "",
    baseURL: "",
    apiKeyEnv: "",
    contextWindow: "",
    maxTokens: "",
    supportsImage: false,
    reasoningEnabled: true,
    effort: "high",
    effortRows: [
      { key: "off", val: "" },
      { key: "low", val: "low" },
      { key: "medium", val: "medium" },
      { key: "high", val: "high" },
    ],
    showEffortEditor: false,
  };
}

const state = {
  selectedSessionId: null,
  scopeCwd: "",
  allProjects: true,
  headlessOnly: true,
  pluginOnly: true,
  includeHidden: false,
  sessions: [],
  recentCwds: [],
  drivers: [],
  customProfiles: [],
  defaultSelection: { driver: "", model: "", effort: "high", profileId: "" },
  settings: { idleTimeoutSec: 180, scanDshDesktop: true },
  telemetry: {
    allTimeTokens: 0,
    allTimeInputTokens: 0,
    allTimeCacheReadTokens: 0,
    allTimeOutputTokens: 0,
    totalRuns: 0,
    totalSessions: 0,
    lastTps: 0,
    lastTtftSec: 0,
    lastDurationSec: 0,
    firstUsedAt: null,
    byDriver: {},
    byModel: {},
    daily: {},
    recentCalls: [],
  },
  // Active composer selection
  selection: { driver: "", model: "", effort: "high", profileId: "" },
  userTouchedModel: false,
  permissionMode: "auto", // "auto" | "readonly"
  activeRun: null,
  activeRuns: [],
  session: null,
  expandAllReasoning: false,
  showTools: true,
  showManageBar: false,
  // Isolated overlay view: null | "session" | "usage" | "settings"
  activeView: null,
  // Settings-embedded model selector state
  settingsEngineTab: "dsh",
  modelSearch: "",
  expandedProviders: new Set(),
  expandedProvidersSeeded: false,
  expandedModelRow: "",
  openSettingsFolds: new Set(),
  editingProfileId: "",
  directDraft: createDefaultDirectDraft(),
  discoveredDirectModels: [],
  discoverDirectLoading: false,
  discoverDirectError: "",
  probeDirectLoading: false,
  probeDirectResult: null,
  // Timeline incremental rendering
  openDetails: new Set(),
  closedDetails: new Set(),
  lastEtag: "",
  lastSessionsSig: "",
  lastRenderedSessionId: null,
  renderedCardSigs: new Map(),
  pollTimer: null,
  polling: false,
  canMessageHost: false,
  canUpdateContext: false,
  canOpenLinks: false,
  errorMsg: "",
  consecutivePollFailures: 0,
  isInline: false,
  inlineTitleExpanded: false,
  lastInlineHeight: 0,
  toastTimer: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- Helpers

function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatComma(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shortProjectName(cwd, slug) {
  if (cwd) {
    const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }
  return (slug || "").replace(/^--|--$/g, "").split("-").pop() || "";
}

function shortDriverTag(driver) {
  const map = { agy: "AGY", dsh: "DSH", claude: "Claude", codex: "Codex", direct: "Direct" };
  return map[driver] || driver || "AGY";
}

function effortLabel(effort) {
  if (!effort) return "";
  const lower = String(effort).toLowerCase();
  return EFFORT_LABELS[lower] || effort;
}

function isRunningStatus(run) {
  return Boolean(run && (run.status === "running" || run.status === "starting"));
}

function anyActiveRun() {
  return state.activeRuns.some(isRunningStatus) || isRunningStatus(state.activeRun);
}

function showToast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

async function copyText(text, label = "已复制") {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label);
      return;
    } catch {
      // Sandboxed iframe fallback
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    showToast(ok ? label : "复制失败");
  } catch {
    showToast("复制失败");
  }
}

function toFileUri(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

async function openFileInHost(filePath) {
  if (!filePath) return;
  try {
    const res = await app.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri: toFileUri(filePath) },
      },
      z.object({ isError: z.boolean().optional() }).passthrough(),
    );
    if (res?.isError) showToast("当前视图不支持侧栏打开文件");
  } catch {
    showToast("无法打开文件预览");
  }
}

async function attachContextToHost(title, body) {
  if (!state.canUpdateContext) return;
  try {
    await app.updateModelContext({
      content: [{ type: "text", text: `[ALilaS 引用 · ${title}]\n${body.slice(0, 6000)}` }],
    });
    showToast("已附加到下条对话上下文");
  } catch {
    showToast("附加失败");
  }
}

// ---------------------------------------------------------------- Model Catalog & Grouping

function getDriverInfo(driverId) {
  return state.drivers.find((d) => d.id === driverId) || null;
}

function groupAgyModels(models) {
  const byBase = new Map();
  for (const m of models || []) {
    const rawName = m.name || m.id;
    const match = rawName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    let baseName = rawName;
    let variantRaw = "";
    if (match) {
      baseName = match[1].trim();
      variantRaw = match[2].trim();
    } else {
      const idMatch = m.id.match(/^(.+?)-(low|medium|high|xhigh|max)$/i);
      if (idMatch) {
        baseName = rawName;
        variantRaw = idMatch[2];
      }
    }
    const lowerVar = variantRaw.toLowerCase();
    const isStdEffort = Object.prototype.hasOwnProperty.call(EFFORT_LABELS, lowerVar);
    const variantLabel = isStdEffort ? EFFORT_LABELS[lowerVar] : variantRaw || "默认";
    const effortKey = isStdEffort ? lowerVar : "high";

    if (!byBase.has(baseName)) {
      byBase.set(baseName, {
        baseName,
        contextWindow: m.contextWindow || 1_000_000,
        variants: [],
      });
    }
    byBase.get(baseName).variants.push({
      modelId: m.id,
      rawName,
      variantLabel,
      effortKey,
      order: isStdEffort ? EFFORT_ORDER[lowerVar] : 99,
      contextWindow: m.contextWindow || 1_000_000,
    });
  }
  const groups = Array.from(byBase.values());
  for (const g of groups) {
    g.variants.sort((a, b) => a.order - b.order);
  }
  return groups;
}

function getSelectionDisplay(sel = state.selection) {
  if (sel.profileId) {
    const p = state.customProfiles.find((x) => x.id === sel.profileId);
    if (p) {
      const eff = p.reasoningEnabled === false ? "" : effortLabel(sel.effort || p.effort);
      return {
        name: p.name || p.model,
        effort: eff,
        driver: p.driver || "direct",
      };
    }
  }
  const drv = sel.driver || state.defaultSelection.driver || "";
  const mdl = sel.model || "";
  const dInfo = getDriverInfo(drv);

  if (drv === "agy" && dInfo?.models?.length) {
    const found = dInfo.models.find((m) => m.id === mdl);
    if (found) {
      const match = (found.name || found.id).match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (match) {
        return {
          name: match[1].trim(),
          effort: effortLabel(match[2].trim()),
          driver: "agy",
        };
      }
      return { name: found.name || found.id, effort: effortLabel(sel.effort), driver: "agy" };
    }
  }

  if (drv === "dsh" && dInfo?.models?.length) {
    const found = dInfo.models.find((m) => m.compositeId === mdl || m.id === mdl);
    if (found) {
      return {
        name: found.name || found.id,
        effort: effortLabel(sel.effort),
        driver: "dsh",
        provider: found.providerLabel || found.provider,
      };
    }
  }

  if (dInfo?.models?.length && mdl) {
    const found = dInfo.models.find((m) => m.id === mdl);
    if (found) {
      return { name: found.name || found.id, effort: effortLabel(sel.effort), driver: drv };
    }
  }

  if (mdl) {
    const clean = mdl.includes("/") ? mdl.split("/").slice(1).join("/") : mdl;
    return { name: clean, effort: effortLabel(sel.effort), driver: drv };
  }
  return { name: dInfo ? `${shortDriverTag(drv)} 默认` : "自动模型", effort: "", driver: drv };
}

function syncInitialSelection() {
  if (state.userTouchedModel) return;
  const def = state.defaultSelection || {};
  let next = null;

  if (def.profileId && state.customProfiles.some((p) => p.id === def.profileId)) {
    const p = state.customProfiles.find((x) => x.id === def.profileId);
    next = {
      driver: p.driver || "direct",
      model: p.model,
      effort: p.reasoningEnabled === false ? "" : def.effort || p.effort || "",
      profileId: p.id,
    };
  } else if (def.driver) {
    const dInfo = getDriverInfo(def.driver);
    if (dInfo?.installed) {
      let model = def.model || "";
      if (model && def.driver === "dsh" && !model.includes("/")) {
        const matched = (dInfo.models || []).find((m) => m.id === model);
        if (matched?.compositeId) model = matched.compositeId;
      }
      if (!model && dInfo.models?.length) {
        model = dInfo.models[0].compositeId || dInfo.models[0].id;
      }
      next = { driver: def.driver, model, effort: def.effort || "high", profileId: "" };
    }
  }

  if (!next && state.session?.driver) {
    const dInfo = getDriverInfo(state.session.driver);
    if (dInfo?.installed) {
      let model = state.session.model || "";
      if (!model && dInfo.models?.length) model = dInfo.models[0].compositeId || dInfo.models[0].id;
      next = {
        driver: state.session.driver,
        model,
        effort: state.session.effort || "high",
        profileId: "",
      };
    }
  }

  if (!next) {
    const dshInfo = state.drivers.find((d) => d.id === "dsh" && d.installed && d.models?.length > 0);
    const agyInfo = state.drivers.find((d) => d.id === "agy" && d.installed);
    const first = dshInfo || agyInfo || state.drivers.find((d) => d.installed);
    if (first) {
      const m0 = first.models?.[0];
      next = {
        driver: first.id,
        model: m0 ? m0.compositeId || m0.id : "",
        effort: "high",
        profileId: "",
      };
    }
  }

  if (next) {
    state.selection = next;
    if (!state.expandedProvidersSeeded && next.driver === "dsh") {
      const provKey = next.model?.includes("/") ? next.model.split("/")[0] : "";
      if (provKey) {
        state.expandedProviders.add(provKey);
        state.expandedProvidersSeeded = true;
      }
    }
  }
}

function isDefaultMatch(driver, model, effort, profileId = "") {
  const def = state.defaultSelection || {};
  if (profileId) {
    return def.profileId === profileId && (def.effort || "") === (effort || "");
  }
  if (def.profileId) return false;
  if (def.driver !== driver) return false;
  if (def.model !== model) return false;
  if (driver === "agy") return true;
  return (def.effort || "") === (effort || "");
}

// ---------------------------------------------------------------- Header & Telemetry Bar

function renderStatus() {
  const run = state.activeRun;
  const dot = $("status-dot");
  const label = $("status-label");
  const stopBtn = $("btn-stop");

  if (isRunningStatus(run)) {
    if (run.stalled) {
      dot.className = "dot stalled";
      label.textContent = `疑似卡死 · 静默 ${run.idleSec}s`;
    } else {
      dot.className = "dot running";
      const phaseMap = {
        booting: "启动中",
        session_ready: "就绪",
        turn_start: "开始",
        step_start: "推理中",
        thinking: "思考中",
        writing: "回复中",
      };
      const p = run.phase?.startsWith("tool:")
        ? `执行 ${run.phase.slice(5)}`
        : phaseMap[run.phase] || "运行中";
      label.textContent = `${p} · S${run.step || 1} · ${run.elapsedSec}s`;
    }
    stopBtn.style.display = "inline-flex";
  } else if (run?.status === "error" || run?.status === "timeout") {
    dot.className = "dot error";
    label.textContent =
      run.status === "timeout" ? `超时 (${run.elapsedSec}s)` : `异常 (${run.elapsedSec}s)`;
    stopBtn.style.display = "none";
  } else if (run?.status === "stopped") {
    dot.className = "dot idle";
    label.textContent = `已停止 (${run.elapsedSec}s)`;
    stopBtn.style.display = "none";
  } else if (run?.status === "done") {
    dot.className = "dot done";
    label.textContent = `完成 · ${run.elapsedSec}s`;
    stopBtn.style.display = "none";
  } else if (state.session?.interrupted) {
    dot.className = "dot stalled";
    label.textContent = "上次意外中断";
    stopBtn.style.display = "none";
  } else if (state.session) {
    dot.className = "dot idle";
    label.textContent = formatTime(state.session.mtimeMs) || "历史";
    stopBtn.style.display = "none";
  } else {
    dot.className = "dot idle";
    label.textContent = "待命";
    stopBtn.style.display = "none";
  }
}

function renderSessionSelect() {
  const sel = $("session-select");
  const cur = state.selectedSessionId || "";
  const sig = JSON.stringify(
    state.sessions.map((s) => [
      s.sessionId,
      s.driver,
      s.isRunning,
      s.pinned,
      s.alias,
      s.title,
      s.reasoningCount,
      s.cwd,
    ]),
  );

  if (sig !== state.lastSessionsSig) {
    state.lastSessionsSig = sig;
    const opts = state.sessions
      .map((s) => {
        const prefix = s.isRunning ? "● " : s.pinned ? "★ " : s.isHeadless ? "" : "[桌面] ";
        const drv = shortDriverTag(s.driver);
        const proj = shortProjectName(s.cwd, s.workspaceSlug);
        const name = (s.alias || s.title || s.sessionId).slice(0, 28);
        return `<option value="${escapeHtml(s.sessionId)}">${prefix}[${drv}${
          proj ? "/" + escapeHtml(proj) : ""
        }] ${escapeHtml(name)} (${s.reasoningCount})</option>`;
      })
      .join("");
    sel.innerHTML = opts || '<option value="">暂无会话</option>';
  }
  if (sel.value !== cur && state.sessions.some((s) => s.sessionId === cur)) {
    sel.value = cur;
  }
}

function renderAgentChips() {
  const bar = $("agents-bar");
  const running = state.activeRuns.filter(isRunningStatus);
  const hasOtherRunning = running.some(
    (r) => r.sessionId && r.sessionId !== state.selectedSessionId,
  );
  if (running.length < 2 && !hasOtherRunning) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = running
    .map((r, idx) => {
      const isSel = r.sessionId && r.sessionId === state.selectedSessionId;
      const proj = shortProjectName(r.cwd, "") || `分身${idx + 1}`;
      const label = state.allProjects
        ? `${shortDriverTag(r.driver)}·${proj}`
        : `${shortDriverTag(r.driver)} #${idx + 1}`;
      const dotCls = r.stalled ? "chip-dot stalled" : "chip-dot";
      return `<button type="button" class="agent-chip ${isSel ? "active" : ""}" data-sid="${escapeHtml(
        r.sessionId || "",
      )}" title="${escapeHtml(`${r.driver}/${r.model || "default"} · ${r.taskPreview || ""}`)}"><span class="${dotCls}"></span><span>${escapeHtml(
        label,
      )}</span><span class="chip-meta">S${r.step || 1} · ${
        r.stalled ? `静默${r.idleSec}s` : `${r.elapsedSec}s`
      }</span></button>`;
    })
    .join("");
}

function renderStats() {
  const s = state.session;
  const bar = $("stats-bar");
  const run = state.activeRun;

  const gearBtn = `
    <button type="button" class="gear-btn" data-open-view="settings" title="打开模型选择与设置">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="2.3"></circle>
        <path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M12.5 3.5l-.9.9M4.4 11.6l-.9.9"></path>
      </svg>
    </button>`;

  const leftParts = [gearBtn];
  if (s) {
    const st = s.stats || {};
    const proj = shortProjectName(s.cwd, "");
    const drv = shortDriverTag(run?.driver || s.driver);
    leftParts.push(`<span class="stat-driver">${escapeHtml(drv)}</span>`);
    if (proj) {
      leftParts.push(
        `<span class="stat-item" title="${escapeHtml(s.cwd || "")}">${escapeHtml(proj)}</span>`,
      );
    }
    leftParts.push(
      `<span class="stat-item">思<b>${st.reasoningCount ?? 0}</b></span><span class="stat-item">工<b>${st.toolCallCount ?? 0}</b></span><span class="stat-item">回<b>${st.textCount ?? 0}</b></span>`,
    );
  } else {
    leftParts.push(`<span class="stat-item muted">ALilaS 就绪</span>`);
  }

  const usage = run?.usage || s?.usage || null;
  const cw = run?.contextWindow || s?.contextWindow || 1_000_000;
  const used = usage?.totalTokens || 0;
  const pct = used > 0 ? Math.min(100, (used / cw) * 100) : 0;
  const pctLabel = pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  const ringTone = pct >= 85 ? "danger" : pct >= 70 ? "warn" : "";
  const circumference = 37.7;
  const dash = ((pct / 100) * circumference).toFixed(2);

  const tps = run?.tps || s?.lastTps || state.telemetry?.lastTps || 0;
  const tpsLabel = tps > 0 ? `${tps.toFixed(1)} tok/s` : "-- tok/s";

  const totalBurned = Math.max(
    state.telemetry?.allTimeTokens || 0,
    s?.cumulativeTokens || 0,
    run?.cumulativeTokens || 0,
    used,
  );

  const telemetryHtml = `
    <div class="telemetry">
      <button type="button" class="tel-btn tel-ring ${ringTone}" data-open-view="session" title="查看当前会话上下文与速度详情">
        <svg class="ring-svg" viewBox="0 0 16 16" width="13" height="13">
          <circle class="ring-track" cx="8" cy="8" r="6" />
          <circle class="ring-fill" cx="8" cy="8" r="6" stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 8 8)" />
        </svg>
        <span class="tel-pct">${used ? pctLabel : "0%"}</span>
      </button>
      <button type="button" class="tel-btn" data-open-view="session" title="查看当前会话速度与步骤明细">
        <span class="tel-star">★</span>
        <span class="tel-val">${tpsLabel}</span>
      </button>
      <button type="button" class="tel-btn" data-open-view="usage" title="查看累计 Token 用量与活动热力图">
        <svg class="bars-svg" viewBox="0 0 14 14" width="11" height="11">
          <rect x="1" y="7" width="2.4" height="6" rx="1" />
          <rect x="5.8" y="2" width="2.4" height="11" rx="1" />
          <rect x="10.6" y="4.5" width="2.4" height="8.5" rx="1" />
        </svg>
        <span class="tel-val">${formatTokens(totalBurned)}</span>
      </button>
    </div>`;

  bar.innerHTML = `<div class="stats-left">${leftParts.join("")}</div>${telemetryHtml}`;
}

function renderManageBar() {
  const bar = $("manage-bar");
  bar.style.display = state.showManageBar ? "flex" : "none";
  $("btn-more").classList.toggle("active", state.showManageBar);
  $("chk-all-projects").checked = state.allProjects;

  const cur = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
  const pinBtn = $("btn-pin-session");
  const renameBtn = $("btn-rename-session");
  const hideBtn = $("btn-hide-session");
  const sendBackBtn = $("btn-send-neon");
  const hasSession = Boolean(cur);

  if (!state.showManageBar || !hasSession) {
    $("rename-row").style.display = "none";
  }

  sendBackBtn.style.display = state.canMessageHost && hasSession ? "inline-flex" : "none";
  pinBtn.disabled = !hasSession;
  renameBtn.disabled = !hasSession;
  hideBtn.disabled = !hasSession;
  pinBtn.textContent = cur?.pinned ? "取消置顶" : "置顶";
  hideBtn.textContent = cur?.hidden ? "取消隐藏" : "隐藏";
}

function renderModelCapsule() {
  const disp = getSelectionDisplay();
  $("cap-model-name").textContent = disp.name || "自动模型";
  $("cap-model-effort").textContent = disp.effort ? `· ${disp.effort}` : "";
  $("btn-model-trigger").title = `当前模型: ${shortDriverTag(disp.driver)} / ${
    state.selection.model || "auto"
  } (${state.selection.effort || "high"}) · 点击前往设置切换`;
}

// ---------------------------------------------------------------- Standalone Isolated Views

function buildHeatmapData(dailyMap = {}) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalDays = 112; // 16 weeks
  let maxTokens = 0;
  let activeDays = 0;
  let rangeTokens = 0;

  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const key = localDateKey(d.getTime());
    const rec = dailyMap[key] || { tokens: 0, runs: 0 };
    if (rec.tokens > maxTokens) maxTokens = rec.tokens;
    if (rec.tokens > 0) activeDays++;
    rangeTokens += rec.tokens || 0;
    days.push({ key, tokens: rec.tokens || 0, runs: rec.runs || 0 });
  }

  const startLabel = days[0]?.key?.slice(5) || "";
  const endLabel = days[days.length - 1]?.key?.slice(5) || "";

  const cells = days
    .map((day) => {
      let cls = "";
      if (day.tokens > 0 && maxTokens > 0) {
        const r = day.tokens / maxTokens;
        cls = r >= 0.75 ? "l4" : r >= 0.45 ? "l3" : r >= 0.18 ? "l2" : "l1";
      }
      return `<span class="hm-cell ${cls}" title="${day.key}: ${formatTokens(day.tokens)} tokens · ${day.runs} 次"></span>`;
    })
    .join("");

  return {
    html: `
      <div class="heatmap-grid">${cells}</div>
      <div class="hm-legend">
        <span>${startLabel} → ${endLabel}</span>
        <span class="hm-scale">
          <span>少</span>
          <span class="hm-sw" style="background:var(--heat-0)"></span>
          <span class="hm-sw" style="background:var(--heat-1)"></span>
          <span class="hm-sw" style="background:var(--heat-2)"></span>
          <span class="hm-sw" style="background:var(--heat-3)"></span>
          <span class="hm-sw" style="background:var(--heat-4)"></span>
          <span>多</span>
        </span>
      </div>`,
    activeDays,
    rangeTokens,
  };
}

function buildSettingsModelListHtml() {
  const q = state.modelSearch.trim().toLowerCase();
  const tab = state.settingsEngineTab;

  if (tab === "agy") {
    const dInfo = getDriverInfo("agy");
    if (!dInfo?.installed) {
      return `<div class="pop-empty">未检测到 agy CLI。安装 Antigravity CLI 后在下方点击「刷新探测」。</div>`;
    }
    const groups = groupAgyModels(dInfo.models).filter(
      (g) =>
        !q ||
        g.baseName.toLowerCase().includes(q) ||
        g.variants.some((v) => v.modelId.toLowerCase().includes(q)),
    );
    if (!groups.length) return `<div class="pop-empty">未找到匹配的 Antigravity 模型</div>`;

    return groups
      .map((g) => {
        const rowKey = `agy::${g.baseName}`;
        const activeVar = g.variants.find(
          (v) => !state.selection.profileId && state.selection.driver === "agy" && state.selection.model === v.modelId,
        );
        const isSel = Boolean(activeVar);
        const isExpanded = state.expandedModelRow === rowKey;
        const preferredVar =
          activeVar || g.variants.find((v) => v.effortKey === "high") || g.variants[0];
        const isDef = isDefaultMatch("agy", preferredVar.modelId, preferredVar.effortKey);

        const trayHtml = isExpanded
          ? `<div class="effort-tray">
              <div class="effort-chips">
                ${g.variants
                  .map(
                    (v) =>
                      `<button type="button" class="effort-chip ${
                        activeVar?.modelId === v.modelId ? "active" : ""
                      }" data-pick-driver="agy" data-pick-model="${escapeHtml(
                        v.modelId,
                      )}" data-pick-effort="${escapeHtml(v.effortKey)}" data-apply-toast="1">${escapeHtml(
                        v.variantLabel,
                      )}</button>`,
                  )
                  .join("")}
              </div>
              <button type="button" class="default-pin-btn ${isDef ? "is-def" : ""}" data-pin-driver="agy" data-pin-model="${escapeHtml(
                preferredVar.modelId,
              )}" data-pin-effort="${escapeHtml(preferredVar.effortKey)}">${
                isDef ? "★ 已默认" : "★ 设为默认"
              }</button>
            </div>`
          : "";

        return `<div class="pop-row-wrap">
          <button type="button" class="pop-row ${isSel ? "selected" : ""}" data-toggle-row="${escapeHtml(
            rowKey,
          )}" data-pick-driver="agy" data-pick-model="${escapeHtml(
            preferredVar.modelId,
          )}" data-pick-effort="${escapeHtml(preferredVar.effortKey)}">
            <span class="pop-row-left">
              <span class="pop-row-name">${escapeHtml(g.baseName)}</span>
              <span class="pop-row-sub">${escapeHtml(activeVar ? activeVar.variantLabel : preferredVar.variantLabel)} · ${formatTokens(
                g.contextWindow,
              )}</span>
            </span>
            <span class="pop-row-right">
              ${isSel ? '<span class="pop-check">✓</span>' : ""}
              <span>${isExpanded ? "▾" : "▸"}</span>
            </span>
          </button>
          ${trayHtml}
        </div>`;
      })
      .join("");
  }

  if (tab === "dsh") {
    const dInfo = getDriverInfo("dsh");
    if (!dInfo?.installed) {
      return `<div class="pop-empty">未检测到 dsh。请在环境变量设置 ALILAS_DSH_BIN 或安装 DeepSeek Harness。</div>`;
    }
    const providers = dInfo.providers || [];
    if (!providers.length) {
      return `<div class="pop-empty">未发现 DSH 上游模型。请在下方开启「自动扫描 DSH 桌面端上游」或配置 mode_a_patch.yml。</div>`;
    }

    const activeProvKey =
      state.selection.driver === "dsh" && state.selection.model?.includes("/")
        ? state.selection.model.split("/")[0]
        : "";

    const blocks = [];
    for (const p of providers) {
      const provMatch =
        q && ((p.displayName || "").toLowerCase().includes(q) || p.key.toLowerCase().includes(q));
      const matchedModels = q
        ? provMatch
          ? p.models
          : p.models.filter(
              (m) =>
                (m.name || "").toLowerCase().includes(q) || (m.id || "").toLowerCase().includes(q),
            )
        : p.models;
      if (!matchedModels.length) continue;

      const isOpen = Boolean(q) || state.expandedProviders.has(p.key);
      const hasSelected = activeProvKey === p.key && !state.selection.profileId;
      const srcTag =
        p.source === "plugin"
          ? `<span class="pop-badge plugin">插件</span>`
          : `<span class="pop-badge">桌面</span>`;

      const rowsHtml = isOpen
        ? `<div class="pop-group-list">${matchedModels
            .map((m) => {
              const compId = `${p.key}/${m.id}`;
              const rowKey = `dsh::${compId}`;
              const isSel =
                !state.selection.profileId &&
                state.selection.driver === "dsh" &&
                (state.selection.model === compId || state.selection.model === m.id);
              const hasReasoning =
                m.hasReasoning !== false &&
                ((m.effortMap && Object.keys(m.effortMap).length > 0) || (m.efforts && m.efforts.length > 0));
              const efforts = hasReasoning
                ? m.effortMap && Object.keys(m.effortMap).length > 0
                  ? Object.keys(m.effortMap)
                  : m.efforts.includes("off")
                    ? m.efforts
                    : ["off", ...m.efforts]
                : [];
              const fallbackEff = efforts.includes("high")
                ? "high"
                : efforts.find((x) => x !== "off" && x !== "none") || efforts[0] || "";
              const curEffort = !hasReasoning
                ? ""
                : isSel && efforts.includes(state.selection.effort)
                  ? state.selection.effort
                  : fallbackEff;
              const isExpanded = state.expandedModelRow === rowKey;
              const isDef = isDefaultMatch("dsh", compId, curEffort);

              const trayHtml = isExpanded
                ? `<div class="effort-tray">
                    <div class="effort-chips">
                      ${
                        efforts.length
                          ? efforts
                              .map(
                                (ef) =>
                                  `<button type="button" class="effort-chip ${
                                    isSel && curEffort === ef ? "active" : ""
                                  }" data-pick-driver="dsh" data-pick-model="${escapeHtml(
                                    compId,
                                  )}" data-pick-effort="${escapeHtml(ef)}" data-apply-toast="1">${escapeHtml(
                                    effortLabel(ef),
                                  )}</button>`,
                              )
                              .join("")
                          : `<span class="muted" style="font-size:11px;">该模型未启用推理等级</span>`
                      }
                    </div>
                    <button type="button" class="default-pin-btn ${isDef ? "is-def" : ""}" data-pin-driver="dsh" data-pin-model="${escapeHtml(
                      compId,
                    )}" data-pin-effort="${escapeHtml(curEffort)}">${
                      isDef ? "★ 已默认" : "★ 设为默认"
                    }</button>
                  </div>`
                : "";

              const hasVision = Array.isArray(m.inputs) && m.inputs.includes("image");
              const capBadge = Array.isArray(m.inputs)
                ? hasVision
                  ? `<span class="pop-badge vision">视觉</span>`
                  : `<span class="pop-badge">纯文本</span>`
                : "";

              return `<div class="pop-row-wrap">
                <button type="button" class="pop-row ${isSel ? "selected" : ""}" data-toggle-row="${escapeHtml(
                  rowKey,
                )}" data-pick-driver="dsh" data-pick-model="${escapeHtml(
                  compId,
                )}" data-pick-effort="${escapeHtml(curEffort)}">
                  <span class="pop-row-left">
                    <span class="pop-row-name">${escapeHtml(m.name || m.id)}</span>
                    ${capBadge}
                    <span class="pop-row-sub">${isSel ? effortLabel(curEffort) + " · " : ""}${formatTokens(
                      m.contextWindow || 200000,
                    )}</span>
                  </span>
                  <span class="pop-row-right">
                    ${isSel ? '<span class="pop-check">✓</span>' : ""}
                    <span>${isExpanded ? "▾" : "▸"}</span>
                  </span>
                </button>
                ${trayHtml}
              </div>`;
            })
            .join("")}</div>`
        : "";

      blocks.push(`<div class="pop-group">
        <button type="button" class="pop-group-head" data-toggle-provider="${escapeHtml(p.key)}">
          <span class="pop-group-left">
            <span>${isOpen ? "▾" : "▸"}</span>
            <span>${escapeHtml(p.displayName || p.key)}</span>
            ${hasSelected ? '<span class="pop-check">●</span>' : ""}
          </span>
          <span class="pop-group-meta">${srcTag}<span>${matchedModels.length}</span></span>
        </button>
        ${rowsHtml}
      </div>`);
    }
    return blocks.length ? blocks.join("") : `<div class="pop-empty">未找到匹配的 DSH 上游或模型</div>`;
  }

  if (tab === "claude" || tab === "codex") {
    const dInfo = getDriverInfo(tab);
    const installed = Boolean(dInfo?.installed);
    const efforts = tab === "codex" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "max"];
    const models = (dInfo?.models || []).filter(
      (m) =>
        !q || (m.name || "").toLowerCase().includes(q) || (m.id || "").toLowerCase().includes(q),
    );
    const notice = !installed
      ? `<div class="notice-banner">本机暂未检测到 ${shortDriverTag(tab)} CLI（安装或配置中转后点击下方「刷新探测」）</div>`
      : "";
    if (!models.length) return notice + `<div class="pop-empty">暂无匹配模型</div>`;

    return (
      notice +
      models
        .map((m) => {
          const rowKey = `${tab}::${m.id}`;
          const isSel =
            !state.selection.profileId &&
            state.selection.driver === tab &&
            state.selection.model === m.id;
          const curEffort = isSel ? state.selection.effort || "high" : "high";
          const isExpanded = installed && state.expandedModelRow === rowKey;
          const isDef = isDefaultMatch(tab, m.id, curEffort);

          const trayHtml = isExpanded
            ? `<div class="effort-tray">
                <div class="effort-chips">
                  ${efforts
                    .map(
                      (ef) =>
                        `<button type="button" class="effort-chip ${
                          isSel && curEffort === ef ? "active" : ""
                        }" data-pick-driver="${tab}" data-pick-model="${escapeHtml(
                          m.id,
                        )}" data-pick-effort="${ef}" data-apply-toast="1">${escapeHtml(
                          effortLabel(ef),
                        )}</button>`,
                    )
                    .join("")}
                </div>
                <button type="button" class="default-pin-btn ${isDef ? "is-def" : ""}" data-pin-driver="${tab}" data-pin-model="${escapeHtml(
                  m.id,
                )}" data-pin-effort="${curEffort}">${isDef ? "★ 已默认" : "★ 设为默认"}</button>
              </div>`
            : "";

          return `<div class="pop-row-wrap">
            <button type="button" class="pop-row ${isSel ? "selected" : ""}" ${
              installed ? "" : "disabled"
            } data-toggle-row="${escapeHtml(rowKey)}" data-pick-driver="${tab}" data-pick-model="${escapeHtml(
              m.id,
            )}" data-pick-effort="${curEffort}">
              <span class="pop-row-left">
                <span class="pop-row-name">${escapeHtml(m.name || m.id)}</span>
                <span class="pop-row-sub">${formatTokens(m.contextWindow || 200000)}</span>
              </span>
              <span class="pop-row-right">
                ${isSel ? '<span class="pop-check">✓</span>' : ""}
                <span>${installed ? (isExpanded ? "▾" : "▸") : "未装"}</span>
              </span>
            </button>
            ${trayHtml}
          </div>`;
        })
        .join("")
    );
  }

  // Direct API (zero-CLI, zero third-party injection) tab
  const list = state.customProfiles.filter(
    (p) =>
      !q ||
      (p.name || "").toLowerCase().includes(q) ||
      (p.model || "").toLowerCase().includes(q) ||
      (p.api || "").toLowerCase().includes(q),
  );
  if (!list.length) {
    return `<div class="pop-empty">暂无直连 API 模型。可在下方「直连 API 模型」折叠栏填写 Base URL、协议与 Key 环境变量名添加（无需安装外部 CLI，无第三方系统注入）。</div>`;
  }
  return list
    .map((p) => {
      const rowKey = `direct::${p.id}`;
      const isSel = state.selection.profileId === p.id;
      const reasoningOn = p.reasoningEnabled !== false;
      const directEfforts = reasoningOn
        ? Object.keys(
            p.effortMap && Object.keys(p.effortMap).length
              ? p.effortMap
              : { off: "", low: "low", medium: "medium", high: "high" },
          )
        : [];
      const fallbackEff = directEfforts.includes(p.effort)
        ? p.effort
        : directEfforts.includes("high")
          ? "high"
          : directEfforts.find((x) => x !== "off" && x !== "none") || directEfforts[0] || "";
      const curEffort = !reasoningOn
        ? ""
        : isSel && directEfforts.includes(state.selection.effort)
          ? state.selection.effort
          : fallbackEff;
      const isExpanded = state.expandedModelRow === rowKey;
      const isDef = isDefaultMatch(p.driver || "direct", p.model, curEffort, p.id);
      const hasVision = Array.isArray(p.inputs) && p.inputs.includes("image");
      const apiShort = API_LABELS[p.api || "openai-completions"] || p.api || "OpenAI Chat";
      const capBadge = hasVision
        ? `<span class="pop-badge vision">视觉</span>`
        : `<span class="pop-badge">纯文本</span>`;

      const trayHtml = isExpanded
        ? `<div class="effort-tray">
            <div class="effort-chips">
              ${
                directEfforts.length
                  ? directEfforts
                      .map(
                        (ef) =>
                          `<button type="button" class="effort-chip ${
                            isSel && curEffort === ef ? "active" : ""
                          }" data-pick-profile="${escapeHtml(p.id)}" data-pick-effort="${escapeHtml(
                            ef,
                          )}" data-apply-toast="1">${escapeHtml(effortLabel(ef))}</button>`,
                      )
                      .join("")
                  : `<span class="muted" style="font-size:11px;">已关闭推理等级（不发思考参数）</span>`
              }
            </div>
            <button type="button" class="default-pin-btn ${isDef ? "is-def" : ""}" data-pin-profile="${escapeHtml(
              p.id,
            )}" data-pin-effort="${escapeHtml(curEffort)}">${isDef ? "★ 已默认" : "★ 设为默认"}</button>
          </div>`
        : "";

      return `<div class="pop-row-wrap">
        <button type="button" class="pop-row ${isSel ? "selected" : ""}" data-toggle-row="${escapeHtml(
          rowKey,
        )}" data-pick-profile="${escapeHtml(p.id)}" data-pick-effort="${escapeHtml(curEffort)}">
          <span class="pop-row-left">
            <span class="pop-row-name">${escapeHtml(p.name || p.model)}</span>
            ${capBadge}
            <span class="pop-row-sub">${escapeHtml(apiShort)} · ${formatTokens(
              p.contextWindow || 200000,
            )}</span>
          </span>
          <span class="pop-row-right">
            ${isSel ? '<span class="pop-check">✓</span>' : ""}
            <span>${isExpanded ? "▾" : "▸"}</span>
          </span>
        </button>
        ${trayHtml}
      </div>`;
    })
    .join("");
}

function renderSessionContextView() {
  const s = state.session;
  const run = state.activeRun;
  const usage = run?.usage || s?.usage || null;
  const cw = run?.contextWindow || s?.contextWindow || 1_000_000;
  const used = usage?.totalTokens || 0;
  const remain = Math.max(0, cw - used);
  const pct = cw > 0 ? Math.min(100, (used / cw) * 100) : 0;
  const tone = pct >= 85 ? "danger" : pct >= 70 ? "warn" : "ok";
  const toneText = pct >= 85 ? "紧张" : pct >= 70 ? "偏高" : "健康";

  const tps = run?.tps || s?.lastTps || 0;
  const durSec = run?.lastStepDurationSec || s?.lastStepDurationSec || 0;
  const ttftSec = run?.ttftSec || s?.lastTtftSec || 0;
  const lastOut =
    (usage?.outputTokens || 0) + (usage?.thinkingTokens || 0) + (usage?.reasoningTokens || 0);
  const cacheDenom = (usage?.inputTokens || 0) + (usage?.cacheReadTokens || 0);
  const cachePct =
    cacheDenom > 0 ? ((usage.cacheReadTokens / cacheDenom) * 100).toFixed(1) : null;

  const sessCumTotal = s?.cumulativeTokens || run?.cumulativeTokens || used;
  const sessCumIn = s?.cumulativeInputTokens || run?.cumulativeInputTokens || usage?.inputTokens || 0;
  const sessCumCache = s?.cumulativeCacheReadTokens || run?.cumulativeCacheReadTokens || usage?.cacheReadTokens || 0;
  const sessCumOut = s?.cumulativeOutputTokens || run?.cumulativeOutputTokens || lastOut;
  const sessParts = sessCumIn + sessCumCache + sessCumOut;
  const pIn = sessParts > 0 ? (sessCumIn / sessParts) * 100 : 0;
  const pCache = sessParts > 0 ? (sessCumCache / sessParts) * 100 : 0;
  const pOut = sessParts > 0 ? (sessCumOut / sessParts) * 100 : 0;

  const dispModel = getSelectionDisplay({
    driver: run?.driver || s?.driver || state.selection.driver,
    model: run?.model || s?.model || state.selection.model,
    effort: run?.effort || s?.effort || "",
  });

  // Prefer current session's real step history (populated for both historical DSH & live timelines)
  const steps = (s?.recentSteps?.length ? s.recentSteps : state.telemetry?.recentCalls || []).slice(0, 10);
  const stepsHtml = steps.length
    ? steps
        .map((c) => {
          const denom = (c.inputTokens || 0) + (c.cacheReadTokens || 0);
          const hit = denom > 0 ? `${Math.round((c.cacheReadTokens / denom) * 100)}%` : "--";
          const stepBadge = c.step !== undefined ? `T${c.turn || 1}·S${c.step}` : shortDriverTag(c.driver);
          return `<div class="call-row">
            <div class="call-left">
              <div class="call-top">
                <span class="pop-badge plugin">${escapeHtml(stepBadge)}</span>
                <span>${formatTime(c.time) || "已记录"}</span>
                <span class="meta">缓存 ${hit}</span>
              </div>
              <div class="call-sub">入 ${formatTokens(c.inputTokens)} · 缓 ${formatTokens(
                c.cacheReadTokens,
              )} · 出 ${formatTokens(c.outputTokens)}</div>
            </div>
            <div class="call-right">
              <span class="call-tps">${c.tps > 0 ? `${c.tps} tok/s` : "--"}</span>
              <span class="call-dur">${c.durationSec > 0 ? `${c.durationSec}s` : formatTokens(c.totalTokens)}</span>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="pop-empty">当前会话暂无步骤调用记录</div>`;

  return `
    <div class="hero-card">
      <div class="dash-head">
        <span>上下文窗口占用</span>
        <span class="pill-badge ${tone}">${toneText}</span>
      </div>
      <div class="hero-num-row">
        <div>
          <span class="hero-big">${formatTokens(used)}</span>
          <span class="hero-denom">/ ${formatTokens(cw)}</span>
        </div>
        <span class="hero-pct ${tone === "ok" ? "" : tone}">${pct.toFixed(1)}%</span>
      </div>
      <div class="meter-track">
        <div class="meter-fill ${tone === "ok" ? "" : tone}" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <div class="hero-foot">
        <span>剩余 ${formatTokens(remain)}</span>
        <span>${cachePct !== null ? `缓存命中 ${cachePct}%` : "等待遥测"}</span>
        <span>${escapeHtml(shortDriverTag(dispModel.driver))} · ${escapeHtml(dispModel.name)}</span>
      </div>
      ${
        pct >= 85
          ? `<div style="font-size:11px;color:var(--danger);">⚠️ 上下文接近上限，建议开启新会话或等待自动压缩。</div>`
          : ""
      }
    </div>

    <div class="dash-card">
      <div class="dash-head">
        <span>最近一步生成表现</span>
        <span class="dash-head-sub">本会话累计 ${formatTokens(sessCumTotal)}</span>
      </div>
      <div class="metric-grid-2">
        <div class="metric-tile">
          <span class="m-label"><span class="m-dot" style="background:var(--brand)"></span>纯流式速度</span>
          <span class="m-val">${tps > 0 ? tps.toFixed(1) : "--"}<span class="m-unit">tok/s</span></span>
        </div>
        <div class="metric-tile">
          <span class="m-label"><span class="m-dot" style="background:var(--accent)"></span>生成耗时</span>
          <span class="m-val">${durSec > 0 ? durSec.toFixed(1) : "--"}<span class="m-unit">${durSec > 0 ? "s" : ""}</span></span>
        </div>
        <div class="metric-tile">
          <span class="m-label"><span class="m-dot" style="background:var(--warn)"></span>首字延迟</span>
          <span class="m-val">${ttftSec > 0 ? ttftSec.toFixed(2) : "--"}<span class="m-unit">${ttftSec > 0 ? "s" : ""}</span></span>
        </div>
        <div class="metric-tile">
          <span class="m-label"><span class="m-dot" style="background:var(--success)"></span>本步输出</span>
          <span class="m-val">${lastOut > 0 ? formatTokens(lastOut) : "--"}<span class="m-unit">${lastOut > 0 ? "tok" : ""}</span></span>
        </div>
      </div>
      ${
        sessParts > 0
          ? `<div class="stack-bar">
              <div class="stack-in" style="width:${pIn.toFixed(1)}%"></div>
              <div class="stack-cache" style="width:${pCache.toFixed(1)}%"></div>
              <div class="stack-out" style="width:${pOut.toFixed(1)}%"></div>
            </div>
            <div class="stack-legend">
              <div class="leg-item"><span class="leg-head"><span class="leg-dot" style="background:var(--accent)"></span>未缓存输入</span><span class="leg-val">${formatTokens(sessCumIn)}</span></div>
              <div class="leg-item"><span class="leg-head"><span class="leg-dot" style="background:var(--brand)"></span>缓存读取</span><span class="leg-val">${formatTokens(sessCumCache)}</span></div>
              <div class="leg-item"><span class="leg-head"><span class="leg-dot" style="background:var(--success)"></span>累计输出</span><span class="leg-val">${formatTokens(sessCumOut)}</span></div>
            </div>`
          : ""
      }
    </div>

    <div class="dash-card">
      <div class="dash-head">
        <span>本会话调用明细</span>
        <span class="dash-head-sub">近 ${steps.length} 步</span>
      </div>
      ${stepsHtml}
    </div>`;
}

function renderLifetimeUsageView() {
  const t = state.telemetry || {};
  const daily = t.daily || {};
  const todayKey = localDateKey();
  const monthPrefix = todayKey.slice(0, 7);
  const todayRec = daily[todayKey] || { tokens: 0, runs: 0 };
  let monthTokens = 0;
  let monthRuns = 0;
  for (const [k, v] of Object.entries(daily)) {
    if (k.startsWith(monthPrefix)) {
      monthTokens += v.tokens || 0;
      monthRuns += v.runs || 0;
    }
  }

  const allTime = t.allTimeTokens || 0;
  const inTok = t.allTimeInputTokens || 0;
  const cacheTok = t.allTimeCacheReadTokens || 0;
  const outTok = t.allTimeOutputTokens || 0;
  const partsTotal = inTok + cacheTok + outTok;
  const pIn = partsTotal > 0 ? (inTok / partsTotal) * 100 : 0;
  const pCache = partsTotal > 0 ? (cacheTok / partsTotal) * 100 : 0;
  const pOut = partsTotal > 0 ? (outTok / partsTotal) * 100 : 0;
  const totalInDenom = inTok + cacheTok;
  const cacheHitPct = totalInDenom > 0 ? ((cacheTok / totalInDenom) * 100).toFixed(1) : "0.0";

  const hm = buildHeatmapData(daily);

  const byDriverEntries = Object.entries(t.byDriver || {}).sort((a, b) => b[1] - a[1]);
  const maxDriverTok = byDriverEntries[0]?.[1] || 1;
  const byModelEntries = Object.entries(t.byModel || {})
    .sort((a, b) => (b[1]?.tokens || 0) - (a[1]?.tokens || 0))
    .slice(0, 6);
  const maxModelTok = byModelEntries[0]?.[1]?.tokens || 1;

  const driverRows = byDriverEntries.length
    ? byDriverEntries
        .map(([drv, tok]) => {
          const pct = Math.max(4, Math.round((tok / maxDriverTok) * 100));
          const share = allTime > 0 ? `${Math.round((tok / allTime) * 100)}%` : "";
          return `<div class="rank-row">
            <div class="rank-top">
              <span class="rank-name">${shortDriverTag(drv)}</span>
              <span class="rank-meta">${formatTokens(tok)}${share ? ` · ${share}` : ""}</span>
            </div>
            <div class="rank-bar"><div class="rank-fill" style="width:${pct}%"></div></div>
          </div>`;
        })
        .join("")
    : `<div class="pop-empty">尚无引擎用量记录</div>`;

  const modelRows = byModelEntries.length
    ? byModelEntries
        .map(([mKey, info]) => {
          const pct = Math.max(4, Math.round(((info.tokens || 0) / maxModelTok) * 100));
          return `<div class="rank-row">
            <div class="rank-top">
              <span class="rank-name">${escapeHtml(mKey)}</span>
              <span class="rank-meta">${formatTokens(info.tokens || 0)}${
                info.lastTps ? ` · ${info.lastTps} tok/s` : ""
              }</span>
            </div>
            <div class="rank-bar"><div class="rank-fill" style="width:${pct}%"></div></div>
          </div>`;
        })
        .join("")
    : "";

  return `
    <div class="hero-card">
      <div class="dash-head">
        <span>累计处理 Token</span>
        <span class="pill-badge">精准实测计数</span>
      </div>
      <div class="hero-num-row">
        <div>
          <span class="hero-big">${formatTokens(allTime)}</span>
          <span class="hero-denom">${formatComma(allTime)} tok</span>
        </div>
      </div>
      <div class="metric-grid-3">
        <div class="metric-tile flat">
          <span class="m-label">今日使用</span>
          <span class="m-val" style="font-size:13.5px;">${formatTokens(todayRec.tokens)}</span>
          <span class="m-sub">${todayRec.runs} 步/次</span>
        </div>
        <div class="metric-tile flat">
          <span class="m-label">本月使用</span>
          <span class="m-val" style="font-size:13.5px;">${formatTokens(monthTokens)}</span>
          <span class="m-sub">${monthRuns} 步/次</span>
        </div>
        <div class="metric-tile flat">
          <span class="m-label">累计会话</span>
          <span class="m-val" style="font-size:13.5px;">${t.totalRuns || 0}</span>
          <span class="m-sub">${hm.activeDays} 天活跃</span>
        </div>
      </div>
    </div>

    <div class="dash-card">
      <div class="dash-head">
        <span>Token 构成与缓存命中</span>
        <span class="pill-badge ok">缓存命中 ${cacheHitPct}%</span>
      </div>
      <div class="stack-bar">
        <div class="stack-in" style="width:${pIn.toFixed(1)}%"></div>
        <div class="stack-cache" style="width:${pCache.toFixed(1)}%"></div>
        <div class="stack-out" style="width:${pOut.toFixed(1)}%"></div>
      </div>
      <div class="stack-legend">
        <div class="leg-item"><span class="leg-head"><span class="leg-dot" style="background:var(--accent)"></span>未缓存输入</span><span class="leg-val">${formatTokens(inTok)}</span></div>
        <div class="leg-item"><span class="leg-head"><span class="leg-dot" style="background:var(--brand)"></span>缓存读取</span><span class="leg-val">${formatTokens(cacheTok)}</span></div>
        <div class="leg-item"><span class="leg-head"><span class="leg-dot" style="background:var(--success)"></span>生成输出</span><span class="leg-val">${formatTokens(outTok)}</span></div>
      </div>
    </div>

    <div class="dash-card">
      <div class="dash-head">
        <span>Token 活跃热力图（近 16 周）</span>
        <span class="dash-head-sub">合计 ${formatTokens(hm.rangeTokens)}</span>
      </div>
      ${hm.html}
    </div>

    <div class="dash-card">
      <div class="dash-head">
        <span>按引擎与模型分布</span>
        <span class="dash-head-sub">历史 + 实时聚合</span>
      </div>
      ${driverRows}
      ${modelRows ? `<div class="muted" style="font-size:11px;margin-top:4px;">高频模型</div>${modelRows}` : ""}
    </div>`;
}

function syncDirectDraftFromDom() {
  const d = state.directDraft;
  if ($("pf-name")) d.name = $("pf-name").value;
  if ($("pf-api")) d.api = $("pf-api").value;
  if ($("pf-model")) d.model = $("pf-model").value;
  if ($("pf-baseurl")) d.baseURL = $("pf-baseurl").value;
  if ($("pf-keyenv")) d.apiKeyEnv = $("pf-keyenv").value;
  if ($("pf-cw")) d.contextWindow = $("pf-cw").value;
  if ($("pf-maxtok")) d.maxTokens = $("pf-maxtok").value;
  if ($("pf-effort")) d.effort = $("pf-effort").value;
  if ($("pf-inp-image")) d.supportsImage = Boolean($("pf-inp-image").checked);
  if ($("pf-reasoning-on")) d.reasoningEnabled = Boolean($("pf-reasoning-on").checked);
  const rows = document.querySelectorAll("#pf-effort-rows .eff-row");
  if (rows.length > 0) {
    d.effortRows = Array.from(rows).map((r) => ({
      key: r.querySelector("[data-eff-key]")?.value || "",
      val: r.querySelector("[data-eff-val]")?.value || "",
    }));
  }
}

function loadProfileIntoDraft(p) {
  if (!p) {
    state.directDraft = createDefaultDirectDraft();
    state.probeDirectResult = null;
    return;
  }
  const reasoningEnabled = p.reasoningEnabled !== false;
  const mapObj =
    p.effortMap && typeof p.effortMap === "object" && Object.keys(p.effortMap).length
      ? p.effortMap
      : reasoningEnabled
        ? { off: "", low: "low", medium: "medium", high: "high" }
        : {};
  state.directDraft = {
    name: p.name || "",
    api: p.api || "openai-completions",
    model: p.model || "",
    baseURL: p.baseURL || "",
    apiKeyEnv: p.apiKeyEnv || "",
    contextWindow: p.contextWindow ? String(p.contextWindow) : "",
    maxTokens: p.maxTokens ? String(p.maxTokens) : "",
    supportsImage: Array.isArray(p.inputs) && p.inputs.includes("image"),
    reasoningEnabled,
    effort: p.effort || "",
    effortRows: Object.entries(mapObj).map(([key, val]) => ({ key, val: val ?? "" })),
    showEffortEditor: false,
  };
  state.probeDirectResult = null;
}

function draftToEffortMap(draft = state.directDraft) {
  const map = {};
  for (const r of draft.effortRows || []) {
    const k = String(r.key || "").trim();
    if (!k) continue;
    map[k] = String(r.val ?? "").trim();
  }
  return map;
}

function renderSettingsView() {
  const curDisp = getSelectionDisplay(state.selection);
  const defDisp = getSelectionDisplay(state.defaultSelection);

  const tabDefs = [
    { id: "dsh", label: "DSH", info: getDriverInfo("dsh") },
    { id: "agy", label: "AGY", info: getDriverInfo("agy") },
    { id: "claude", label: "Claude", info: getDriverInfo("claude") },
    { id: "codex", label: "Codex", info: getDriverInfo("codex") },
    { id: "direct", label: "直连 API", info: { installed: state.customProfiles.length > 0 } },
  ];

  const enginePillsHtml = tabDefs
    .map((t) => {
      const installed = Boolean(t.info?.installed);
      const active = state.settingsEngineTab === t.id;
      return `<button type="button" class="eng-pill ${active ? "active" : ""}" data-eng-tab="${t.id}">
        <span class="eng-dot ${installed ? "" : "off"}"></span>
        <span>${escapeHtml(t.label)}</span>
      </button>`;
    })
    .join("");

  const driversHtml = state.drivers
    .map(
      (d) => `<div class="call-row">
        <div class="call-left">
          <div class="call-top"><span class="eng-dot ${d.installed ? "" : "off"}"></span><span>${escapeHtml(
            d.label,
          )}</span></div>
          <div class="call-sub">${escapeHtml(d.detail || (d.installed ? "就绪" : "未安装"))}</div>
        </div>
        <span class="pill-badge ${d.installed ? "ok" : ""}">${d.installed ? "就绪" : "未装"}</span>
      </div>`,
    )
    .join("");

  const editing = state.editingProfileId
    ? state.customProfiles.find((x) => x.id === state.editingProfileId) || null
    : null;
  const d = state.directDraft;
  const validEffortKeys = (d.effortRows || []).map((r) => String(r.key || "").trim()).filter(Boolean);
  const effectiveDraftEffort = d.reasoningEnabled
    ? validEffortKeys.includes(d.effort)
      ? d.effort
      : validEffortKeys.includes("high")
        ? "high"
        : validEffortKeys.find((x) => x !== "off" && x !== "none") || validEffortKeys[0] || ""
    : "";

  const effortOptionsHtml = d.reasoningEnabled
    ? validEffortKeys.length
      ? validEffortKeys
          .map(
            (k) =>
              `<option value="${escapeHtml(k)}" ${
                effectiveDraftEffort === k ? "selected" : ""
              }>默认思考: ${escapeHtml(effortLabel(k))}${
                EFFORT_LABELS[k.toLowerCase()] ? ` (${escapeHtml(k)})` : ""
              }</option>`,
          )
          .join("")
      : `<option value="">未配置档位</option>`
    : `<option value="">推理等级已关闭</option>`;

  const effortEditorHtml =
    d.reasoningEnabled && d.showEffortEditor
      ? `<div id="pf-effort-rows" class="eff-editor">
          <div class="eff-head"><span>档位名</span><span>API 参数值（留空=关闭思考）</span><span></span></div>
          ${(d.effortRows || [])
            .map(
              (r, idx) => `<div class="eff-row">
                <input data-eff-key="${idx}" placeholder="如 high / xhigh / max" value="${escapeHtml(r.key)}" />
                <input data-eff-val="${idx}" placeholder="如 high / 16384" value="${escapeHtml(r.val)}" />
                <button type="button" class="eff-del" data-del-effort-row="${idx}" title="删除此档位">✕</button>
              </div>`,
            )
            .join("")}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
            <span class="muted" style="font-size:10px;">Anthropic 协议可填数字作为 budget_tokens</span>
            <button type="button" class="btn" id="btn-add-effort-row">+ 添加档位</button>
          </div>
        </div>`
      : "";

  const discHtml = state.discoverDirectError
    ? `<div class="probe-banner err form-full">${escapeHtml(state.discoverDirectError)}</div>`
    : state.discoveredDirectModels.length
      ? `<div class="disc-box">
          ${state.discoveredDirectModels
            .slice(0, 60)
            .map(
              (m, idx) => `<button type="button" class="disc-pill" data-apply-discovered="${idx}" title="点击自动回填：${escapeHtml(
                m.id,
              )} · ${formatTokens(m.contextWindow)}${
                m.reasoningEnabled ? ` · ${m.efforts.join("/")}` : " · 非思考模型"
              }">${escapeHtml(m.id)} <span class="muted">${formatTokens(m.contextWindow)}</span></button>`,
            )
            .join("")}
        </div>`
      : "";

  const probeBannerHtml = state.probeDirectResult
    ? `<div class="probe-banner ${state.probeDirectResult.ok ? "ok" : "err"}">${
        state.probeDirectResult.ok ? "✓ " : "✕ "
      }${escapeHtml(state.probeDirectResult.message || "")}</div>`
    : "";

  const customListHtml = state.customProfiles.length
    ? state.customProfiles
        .map((p) => {
          const apiShort = API_LABELS[p.api || "openai-completions"] || p.api || "OpenAI Chat";
          const cap = Array.isArray(p.inputs) && p.inputs.includes("image") ? "视觉" : "纯文本";
          const rBadge = p.reasoningEnabled === false ? `<span class="pop-badge">非思考</span>` : "";
          const isEditingThis = editing?.id === p.id;
          return `<div class="call-row">
            <div class="call-left">
              <div class="call-top">
                <span>${escapeHtml(p.name || p.model)}</span>
                <span class="pop-badge ${cap === "视觉" ? "vision" : ""}">${cap}</span>
                ${rBadge}
                ${isEditingThis ? `<span class="pop-badge plugin">编辑中</span>` : ""}
              </div>
              <div class="call-sub">${escapeHtml(apiShort)} · ${escapeHtml(p.model)} · ${formatTokens(
                p.contextWindow || 200000,
              )}${p.apiKeyEnv ? ` · $${escapeHtml(p.apiKeyEnv)}` : ""}</div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn" data-edit-profile="${escapeHtml(p.id)}">编辑</button>
              <button type="button" class="btn btn-danger" data-del-profile="${escapeHtml(p.id)}">删除</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="muted" style="font-size:11px;">暂无直连 API 模型（无需安装 CLI、无第三方系统提示注入；仅存环境变量名，绝不存明文 Key）</div>`;

  const readyCount = state.drivers.filter((d) => d.installed).length;
  const isFoldOpen = (k) => (state.openSettingsFolds.has(k) ? "open" : "");

  return `
    <div class="dash-card">
      <div class="dash-head">
        <span>选择子代理模型与思考强度</span>
        <span id="settings-cur-badge" class="pill-badge">${escapeHtml(curDisp.name)}${
          curDisp.effort ? ` · ${escapeHtml(curDisp.effort)}` : ""
        }</span>
      </div>
      <div id="settings-def-line" class="muted" style="font-size:11px;">
        当前全局默认：<b>${escapeHtml(defDisp.name)}${defDisp.effort ? ` · ${escapeHtml(defDisp.effort)}` : ""}</b>（点击任意模型展开思考强度或「★ 设为默认」）
      </div>
      <input id="settings-model-search" class="search-input" value="${escapeHtml(
        state.modelSearch,
      )}" placeholder="搜索模型名或上游渠道…" autocomplete="off" />
      <div id="settings-engine-pills" class="engine-pills">${enginePillsHtml}</div>
      <div id="settings-model-list" class="model-list">${buildSettingsModelListHtml()}</div>
    </div>

    <details class="fold-card" data-fold="drivers" ${isFoldOpen("drivers")}>
      <summary>
        <span>引擎探测状态（${readyCount} / ${state.drivers.length} 就绪）</span>
        <span class="meta">展开 ▾</span>
      </summary>
      <div class="fold-body">
        ${driversHtml}
        <div style="display:flex;justify-content:flex-end;">
          <button type="button" class="btn" id="btn-refresh-drivers">↻ 重新探测全部引擎</button>
        </div>
      </div>
    </details>

    <details class="fold-card" data-fold="runtime" ${isFoldOpen("runtime")}>
      <summary>
        <span>运行与扫描设置</span>
        <span class="meta">阈值 ${state.settings.idleTimeoutSec || 180}s ▾</span>
      </summary>
      <div class="fold-body">
        <div class="setting-row">
          <span>无活动卡死告警阈值（秒）</span>
          <div style="display:flex;align-items:center;gap:5px;">
            <input id="set-idle-sec" class="setting-input" type="number" min="60" max="600" style="width:74px;" value="${
              state.settings.idleTimeoutSec || 180
            }" />
            <button type="button" class="btn" id="btn-save-idle">保存</button>
          </div>
        </div>
        <label class="chk-label" style="justify-content:space-between;width:100%;">
          <span>自动扫描 DSH 桌面端上游（只读）</span>
          <input id="set-scan-dsh" type="checkbox" ${state.settings.scanDshDesktop !== false ? "checked" : ""} />
        </label>
      </div>
    </details>

    <details class="fold-card" data-fold="custom" ${isFoldOpen("custom")}>
      <summary>
        <span>直连 API 模型（${state.customProfiles.length}）</span>
        <span class="meta">无注入 · 展开 ▾</span>
      </summary>
      <div class="fold-body">
        <div class="form-grid">
          <input id="pf-baseurl" class="form-full" placeholder="Base URL（必填，如 https://api.example.com/v1）" value="${escapeHtml(
            d.baseURL,
          )}" />
          <div class="inline-input-row">
            <input id="pf-keyenv" placeholder="API Key 环境变量名（如 MY_API_KEY，绝不存明文）" value="${escapeHtml(
              d.apiKeyEnv,
            )}" />
            <button id="btn-discover-direct" type="button" class="btn" ${
              state.discoverDirectLoading ? "disabled" : ""
            }>${state.discoverDirectLoading ? "获取中…" : "获取模型"}</button>
          </div>
          ${discHtml}
          <input id="pf-name" placeholder="显示名称（如 DeepSeek 直连）" value="${escapeHtml(d.name)}" />
          <select id="pf-api">
            <option value="openai-completions" ${
              d.api === "openai-completions" ? "selected" : ""
            }>协议: OpenAI Chat Completions</option>
            <option value="openai-responses" ${
              d.api === "openai-responses" ? "selected" : ""
            }>协议: OpenAI Responses</option>
            <option value="anthropic-messages" ${
              d.api === "anthropic-messages" ? "selected" : ""
            }>协议: Anthropic Messages</option>
          </select>
          <input id="pf-model" placeholder="模型 ID（必填，如 deepseek-chat）" value="${escapeHtml(d.model)}" />
          <select id="pf-effort" ${d.reasoningEnabled ? "" : "disabled"}>
            ${effortOptionsHtml}
          </select>
          <input id="pf-cw" type="number" placeholder="上下文窗口（默认 200000）" value="${escapeHtml(
            d.contextWindow,
          )}" />
          <input id="pf-maxtok" type="number" placeholder="最大输出（默认 64000）" value="${escapeHtml(
            d.maxTokens,
          )}" />
          <div class="form-checks form-full">
            <span>输入类型</span>
            <div class="form-checks-group">
              <label class="chk-label"><input id="pf-inp-text" type="checkbox" checked disabled />文本</label>
              <label class="chk-label"><input id="pf-inp-image" type="checkbox" ${
                d.supportsImage ? "checked" : ""
              } />图片 / 识图</label>
            </div>
          </div>
          <div class="form-checks form-full">
            <label class="chk-label">
              <input id="pf-reasoning-on" type="checkbox" ${d.reasoningEnabled ? "checked" : ""} />
              <span>启用推理等级</span>
            </label>
            <button id="btn-toggle-effort-map" type="button" class="btn" ${
              d.reasoningEnabled ? "" : "disabled"
            }>档位映射 (${validEffortKeys.length}) ${d.showEffortEditor ? "▴" : "▾"}</button>
          </div>
          ${effortEditorHtml}
        </div>
        <div class="form-actions">
          <button id="btn-probe-direct" type="button" class="btn" ${
            state.probeDirectLoading ? "disabled" : ""
          }>${state.probeDirectLoading ? "测试中…" : "测试工具"}</button>
          <div class="row-actions">
            ${
              editing
                ? `<button id="btn-cancel-edit-profile" type="button" class="btn">取消</button>`
                : ""
            }
            <button id="btn-save-profile" type="button" class="btn btn-primary">${
              editing ? "更新直连模型" : "保存直连模型"
            }</button>
          </div>
        </div>
        ${probeBannerHtml}
        ${customListHtml}
      </div>
    </details>`;
}

function refreshSettingsModelSection() {
  const listEl = $("settings-model-list");
  if (!listEl) {
    renderOverlayView(true);
    return;
  }
  const savedScroll = listEl.scrollTop;
  listEl.innerHTML = buildSettingsModelListHtml();
  listEl.scrollTop = savedScroll;

  const curDisp = getSelectionDisplay(state.selection);
  const badge = $("settings-cur-badge");
  if (badge) {
    badge.textContent = `${curDisp.name}${curDisp.effort ? ` · ${curDisp.effort}` : ""}`;
  }
  const defDisp = getSelectionDisplay(state.defaultSelection);
  const defLine = $("settings-def-line");
  if (defLine) {
    defLine.innerHTML = `当前全局默认：<b>${escapeHtml(defDisp.name)}${
      defDisp.effort ? ` · ${escapeHtml(defDisp.effort)}` : ""
    }</b>（点击任意模型展开思考强度或「★ 设为默认」）`;
  }
  const pillsEl = $("settings-engine-pills");
  if (pillsEl) {
    pillsEl.querySelectorAll("[data-eng-tab]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-eng-tab") === state.settingsEngineTab);
    });
  }
}

const OV_ICONS = {
  session: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="5.6" stroke-opacity="0.28"/><path d="M8 2.4A5.6 5.6 0 1 1 2.4 8" stroke-linecap="round"/></svg>`,
  usage: `<svg viewBox="0 0 14 14" width="13" height="13" fill="currentColor"><rect x="1" y="7" width="2.4" height="6" rx="1"/><rect x="5.8" y="2" width="2.4" height="11" rx="1"/><rect x="10.6" y="4.5" width="2.4" height="8.5" rx="1"/></svg>`,
  settings: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.6v1.3M8 13.1v1.3M1.6 8h1.3M13.1 8h1.3M3.5 3.5l.9.9M11.6 11.6l.9.9M12.5 3.5l-.9.9M4.4 11.6l-.9.9"/></svg>`,
};

function renderOverlayView(force = false) {
  const ov = $("overlay-view");
  ov.classList.toggle("open", Boolean(state.activeView));
  if (!state.activeView) return;

  const titleEl = $("ov-title");
  const bodyEl = $("ov-body");

  // Never clobber focused form/search inputs during background poll ticks
  if (
    !force &&
    state.activeView === "settings" &&
    bodyEl.contains(document.activeElement) &&
    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)
  ) {
    return;
  }

  const prevBodyScroll = bodyEl.scrollTop;
  const prevListScroll = $("settings-model-list")?.scrollTop || 0;

  if (state.activeView === "session") {
    titleEl.innerHTML = `
      <span class="ov-icon">${OV_ICONS.session}</span>
      <span>当前会话上下文</span>
      <span class="ov-sub">${escapeHtml(shortProjectName(state.session?.cwd, "") || "ALilaS")}</span>`;
    bodyEl.innerHTML = renderSessionContextView();
  } else if (state.activeView === "usage") {
    titleEl.innerHTML = `
      <span class="ov-icon">${OV_ICONS.usage}</span>
      <span>累计 Token 用量</span>
      <span class="ov-sub">历史 + 实时</span>`;
    bodyEl.innerHTML = renderLifetimeUsageView();
  } else if (state.activeView === "settings") {
    titleEl.innerHTML = `
      <span class="ov-icon">${OV_ICONS.settings}</span>
      <span>模型与设置</span>
      <span class="ov-sub">v3.3.1</span>`;
    bodyEl.innerHTML = renderSettingsView();
    const newList = $("settings-model-list");
    if (newList) newList.scrollTop = prevListScroll;
  }
  bodyEl.scrollTop = prevBodyScroll;
}

// ---------------------------------------------------------------- Timeline

function buildCardHtml(item, key, isLastReasoning) {
  const ctxBtn = state.canUpdateContext
    ? `<button type="button" class="icon-btn" data-attach="${escapeHtml(key)}" title="引用到下条对话上下文">引用</button>`
    : "";

  if (item.kind === "user") {
    const isNeon = item.text.startsWith("[来自 Neon");
    return `
      <div class="card card-user" data-card-key="${escapeHtml(key)}">
        <div class="card-head">
          <span class="tag tag-user">${isNeon ? "Coordinator" : "指令"}</span>
          <span class="meta">T${item.turn || 1}</span>
        </div>
        <div class="card-body pre-wrap">${escapeHtml(item.text)}</div>
      </div>`;
  }

  if (item.kind === "system") {
    const isOpen = state.openDetails.has(key);
    const label = item.label || "DSH 系统注入";
    return `
      <details class="card card-system" data-card-key="${escapeHtml(key)}" data-key="${escapeHtml(
        key,
      )}" ${isOpen ? "open" : ""}>
        <summary class="card-head clickable">
          <span class="tag tag-sys">DSH 系统注入</span>
          <span class="summary-preview">${escapeHtml(label)}<span class="sys-hint">（非主代理指令）</span></span>
          <span class="card-actions">
            <span class="meta">T${item.turn || 1} · ${item.charCount || item.text.length}字</span>
            <button type="button" class="icon-btn" data-copy-key="${escapeHtml(key)}">复制</button>
          </span>
        </summary>
        <div class="card-body pre-wrap">${escapeHtml(item.text)}</div>
      </details>`;
  }

  if (item.kind === "reasoning") {
    const defaultOpen = state.expandAllReasoning || isLastReasoning;
    const isOpen = state.openDetails.has(key)
      ? true
      : state.closedDetails.has(key)
        ? false
        : defaultOpen;
    const preview = item.text.replace(/\s+/g, " ").slice(0, 76);
    return `
      <details class="card card-reasoning" data-card-key="${escapeHtml(key)}" data-key="${escapeHtml(
        key,
      )}" ${isOpen ? "open" : ""}>
        <summary class="card-head clickable">
          <span class="tag tag-reason">思考</span>
          <span class="summary-preview">${escapeHtml(preview)}</span>
          <span class="card-actions">
            <span class="meta">S${item.step || 0} · ${item.charCount || item.text.length}字</span>
            <button type="button" class="icon-btn" data-copy-key="${escapeHtml(key)}">复制</button>
            ${ctxBtn}
          </span>
        </summary>
        <div class="card-body reasoning-text pre-wrap">${escapeHtml(item.text)}</div>
      </details>`;
  }

  if (item.kind === "tool") {
    const isOpen = state.openDetails.has(key);
    const isRunning = item.status === "running";
    const isErr = item.isError || item.status === "error";
    const statusIcon = isRunning ? "…" : isErr ? "✕" : "✓";
    const dur = formatDuration(item.durationMs);
    const filesHtml = (item.filePaths || [])
      .map((fp) => {
        const base = fp.replace(/\\/g, "/").split("/").pop() || fp;
        return `<button type="button" class="file-pill" data-open-file="${escapeHtml(
          fp,
        )}" title="在侧边栏打开 ${escapeHtml(fp)}">${escapeHtml(base)}</button>`;
      })
      .join("");

    return `
      <details class="card card-tool ${isErr ? "is-err" : ""} ${
        isRunning ? "is-running" : ""
      }" data-card-key="${escapeHtml(key)}" data-key="${escapeHtml(key)}" ${isOpen ? "open" : ""}>
        <summary class="card-head clickable">
          <span class="tag ${isErr ? "tag-err" : isRunning ? "tag-run" : "tag-tool"}">${statusIcon} ${escapeHtml(
            item.toolName || "tool",
          )}</span>
          <span class="summary-preview mono">${escapeHtml(item.argsSummary || "")}</span>
          <span class="meta">${dur || `S${item.step || 0}`}</span>
        </summary>
        <div class="card-body tool-body">
          ${filesHtml ? `<div class="file-pills">${filesHtml}</div>` : ""}
          ${
            item.argsPreview
              ? `<div class="tool-sec"><div class="tool-sec-head"><span>输入</span><button type="button" class="mini-copy" data-copy-raw="${escapeHtml(
                  encodeURIComponent(item.argsPreview),
                )}">复制</button></div><pre class="code-block">${escapeHtml(
                  item.argsPreview,
                )}</pre></div>`
              : ""
          }
          ${
            item.resultText
              ? `<div class="tool-sec"><div class="tool-sec-head"><span>输出${
                  isErr ? "（错误）" : ""
                }</span><button type="button" class="mini-copy" data-copy-raw="${escapeHtml(
                  encodeURIComponent(item.resultText),
                )}">复制</button></div><pre class="code-block">${escapeHtml(
                  item.resultText,
                )}</pre></div>`
              : isRunning
                ? `<div class="tool-pending">执行中…</div>`
                : ""
          }
        </div>
      </details>`;
  }

  if (item.kind === "text") {
    return `
      <div class="card card-text" data-card-key="${escapeHtml(key)}">
        <div class="card-head">
          <span class="tag tag-text">ALilaS</span>
          <span class="card-actions">
            <span class="meta">T${item.turn || 1} · S${item.step || 0}</span>
            <button type="button" class="icon-btn" data-copy-key="${escapeHtml(key)}">复制</button>
            ${ctxBtn}
          </span>
        </div>
        <div class="card-body md-body">${renderMarkdown(item.text)}</div>
      </div>`;
  }

  if (item.kind === "error") {
    return `
      <div class="card card-error" data-card-key="${escapeHtml(key)}">
        <div class="card-head"><span class="tag tag-err">错误</span></div>
        <pre class="card-body code-block">${escapeHtml(item.text)}</pre>
      </div>`;
  }

  return "";
}

function buildLiveFooterHtml(run) {
  if (isRunningStatus(run)) {
    const live = run.live;
    if (live?.active && (live.reasoning || live.text || live.toolName)) {
      const blocks = [];
      if (live.reasoning) {
        blocks.push(
          `<div class="live-block"><div class="live-label">思考中</div><div class="reasoning-text pre-wrap">${escapeHtml(
            live.reasoning,
          )}<span class="cursor"></span></div></div>`,
        );
      }
      if (live.text) {
        blocks.push(
          `<div class="live-block"><div class="live-label">回复中</div><div class="md-body">${renderMarkdown(
            live.text,
          )}<span class="cursor"></span></div></div>`,
        );
      }
      if (live.toolName) {
        blocks.push(
          `<div class="live-tool"><span class="spinner"></span><span>准备调用工具 <code>${escapeHtml(
            live.toolName,
          )}</code>…</span></div>`,
        );
      }
      return `
        <div class="card card-live" id="live-stream-card">
          <div class="card-head">
            <span class="tag tag-live"><span class="spinner-sm"></span> 实时流 · ${shortDriverTag(run.driver)}</span>
            <span class="meta">S${run.step || 1} · ${run.elapsedSec}s</span>
          </div>
          <div class="card-body">${blocks.join("")}</div>
        </div>`;
    }
    return `
      <div class="running-footer" id="live-stream-card">
        <span class="spinner"></span>
        <span>ALilaS 处理中（${shortDriverTag(run.driver)} · S${run.step || 1} · ${run.elapsedSec}s）…</span>
      </div>`;
  }
  if (run?.error) {
    return `
      <div class="card card-error" id="live-stream-card">
        <div class="card-head"><span class="tag tag-err">运行异常</span></div>
        <pre class="card-body code-block">${escapeHtml(run.error)}</pre>
      </div>`;
  }
  if (run?.status === "stopped") {
    const reasonMap = {
      stopped_by_user: "已由用户手动中止",
      stopped_by_model: "已由主代理中止",
    };
    const reasonText = reasonMap[run.phase] || (run.phase ? `已中止：${run.phase}` : "任务已中止");
    return `
      <div class="card card-stopped" id="live-stream-card">
        <div class="card-head">
          <span class="tag tag-run">已中止</span>
          <span class="meta">耗时 ${run.elapsedSec}s</span>
        </div>
        <div class="card-body muted">${escapeHtml(reasonText)}。可在下方继续输入指令续聊该会话。</div>
      </div>`;
  }
  if (state.session?.interrupted && !run?.status) {
    return `
      <div class="card card-interrupted" id="live-stream-card">
        <div class="card-head">
          <span class="tag tag-run">上次运行意外中断</span>
          <span class="meta">未正常收尾</span>
        </div>
        <div class="card-body muted">该会话在步骤执行中途失去连接（例如插件刷新重启或子进程被外部终止），可直接在下方发送消息继续执行。</div>
      </div>`;
  }
  return "";
}

const itemLookup = new Map();

function renderTimeline(forceFull = false) {
  const container = $("timeline");
  const s = state.session;
  const run = state.activeRun;

  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 90;

  if (!s || !s.items || s.items.length === 0) {
    state.lastRenderedSessionId = null;
    state.renderedCardSigs.clear();
    itemLookup.clear();
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-mark">ALilaS</div>
        <div class="empty-desc">多引擎增强子代理就绪。点左下角模型胶囊或顶部 ⚙ 可切换模型与思考强度。</div>
      </div>`;
    return;
  }

  const sessionChanged = forceFull || state.lastRenderedSessionId !== s.sessionId;
  if (sessionChanged) {
    state.lastRenderedSessionId = s.sessionId;
    state.renderedCardSigs.clear();
    container.innerHTML = "";
  }

  let noticeEl = container.querySelector(":scope > .notice-banner");
  if (s.stats?.truncatedItems) {
    const noticeText = `仅展示最近 ${s.items.length} / ${s.stats.totalTimelineItems} 条`;
    if (!noticeEl) {
      noticeEl = document.createElement("div");
      noticeEl.className = "notice-banner";
      container.prepend(noticeEl);
    }
    if (noticeEl.textContent !== noticeText) noticeEl.textContent = noticeText;
  } else if (noticeEl) {
    noticeEl.remove();
    noticeEl = null;
  }

  const visible = s.items.filter((it) => state.showTools || it.kind !== "tool");
  let lastReasoningIdx = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].kind === "reasoning") {
      lastReasoningIdx = i;
      break;
    }
  }

  itemLookup.clear();
  const activeKeys = new Set();

  const existingLive = $("live-stream-card");
  if (existingLive) existingLive.remove();

  const existingNodes = new Map();
  container.querySelectorAll(":scope > [data-card-key]").forEach((el) => {
    existingNodes.set(el.getAttribute("data-card-key"), el);
  });

  let prevAnchor = noticeEl || null;

  visible.forEach((item, idx) => {
    const key = `${s.sessionId}:${item.seq}:${item.kind}`;
    activeKeys.add(key);
    itemLookup.set(key, item);

    const isLastR = idx === lastReasoningIdx;
    const itemSig = JSON.stringify([
      item.kind,
      item.status,
      item.isError,
      item.durationMs,
      item.text?.length || 0,
      item.resultText?.length || 0,
      isLastR,
      state.expandAllReasoning,
    ]);

    const prevSig = state.renderedCardSigs.get(key);
    const existingEl = existingNodes.get(key);

    if (existingEl && prevSig === itemSig) {
      const inPlace = prevAnchor
        ? prevAnchor.nextElementSibling === existingEl
        : container.firstElementChild === existingEl;
      if (!inPlace) {
        if (prevAnchor) prevAnchor.after(existingEl);
        else container.prepend(existingEl);
      }
      prevAnchor = existingEl;
      return;
    }

    const html = buildCardHtml(item, key, isLastR);
    if (!html) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    const nextEl = tpl.content.firstElementChild;

    if (existingEl) {
      existingEl.replaceWith(nextEl);
      const inPlace = prevAnchor
        ? prevAnchor.nextElementSibling === nextEl
        : container.firstElementChild === nextEl;
      if (!inPlace) {
        if (prevAnchor) prevAnchor.after(nextEl);
        else container.prepend(nextEl);
      }
    } else if (prevAnchor) {
      prevAnchor.after(nextEl);
    } else {
      container.prepend(nextEl);
    }
    prevAnchor = nextEl;
    state.renderedCardSigs.set(key, itemSig);
  });

  for (const [k, el] of existingNodes.entries()) {
    if (!activeKeys.has(k)) {
      el.remove();
      state.renderedCardSigs.delete(k);
    }
  }

  const liveHtml = buildLiveFooterHtml(run);
  if (liveHtml) {
    const tpl = document.createElement("template");
    tpl.innerHTML = liveHtml.trim();
    container.appendChild(tpl.content.firstElementChild);
  }

  if (nearBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

// ---------------------------------------------------------------- Composer

function renderComposerState() {
  const isDesktop = state.session && !state.session.isHeadless;
  const input = $("task-input");
  const sendBtn = $("btn-send-task");
  const newChk = $("chk-new-session");
  const cwdRow = $("cwd-row");
  const cwdInput = $("cwd-input");
  const permBtn = $("btn-perm-mode");

  permBtn.textContent = state.permissionMode === "readonly" ? "只读" : "自动";
  permBtn.classList.toggle("active", state.permissionMode === "readonly");

  const dl = $("cwd-datalist");
  const dlSig = state.recentCwds.join("|");
  if (dl.dataset.sig !== dlSig) {
    dl.dataset.sig = dlSig;
    dl.innerHTML = state.recentCwds
      .map((c) => `<option value="${escapeHtml(c)}"></option>`)
      .join("");
  }
  if (!cwdInput.value && state.recentCwds.length > 0) {
    cwdInput.value = state.session?.cwd || state.recentCwds[0];
  }

  const willCreateNew = newChk.checked || !state.selectedSessionId || isDesktop;
  cwdRow.style.display = newChk.checked || !state.selectedSessionId ? "flex" : "none";

  if (isDesktop && !newChk.checked) {
    input.placeholder = "当前为桌面端只读会话；勾选「新会话」可直接派活…";
    sendBtn.disabled = true;
  } else {
    input.placeholder = willCreateNew
      ? "输入新任务给 ALilaS… (Ctrl+Enter)"
      : "继续当前会话… (Ctrl+Enter)";
    sendBtn.disabled = false;
  }
}

function renderErrorBanner() {
  const errBar = $("error-banner");
  if (!errBar) return;
  if (state.errorMsg) {
    errBar.textContent = state.errorMsg;
    errBar.style.display = "block";
  } else {
    errBar.style.display = "none";
  }
}

function formatCompactModelName(rawModel, effort) {
  let m = String(rawModel || "").trim();
  if (m.includes("/")) m = m.split("/").slice(1).join("/");
  if (m.includes(":")) m = m.split(":").slice(1).join(":");
  if (!m) {
    const disp = getSelectionDisplay();
    m = disp.name || "";
    if (!effort && disp.effort) effort = disp.effort;
  }
  const eff = effort && EFFORT_LABELS[effort] ? effort : "";
  return m ? (eff ? `${m} · ${eff}` : m) : "";
}

function syncInlineCardHeight() {
  if (!state.isInline) return;
  requestAnimationFrame(() => {
    const card = $("inline-card");
    if (!card) return;
    const h = Math.ceil(card.getBoundingClientRect().height) + 4;
    if (h > 40 && Math.abs(h - state.lastInlineHeight) >= 2) {
      state.lastInlineHeight = h;
      try {
        if (typeof app.sendSizeChanged === "function") {
          app.sendSizeChanged({ height: h });
        }
      } catch {
        // ignore if host ignores size notifications
      }
    }
  });
}

function renderInlineCard() {
  if (!state.isInline) return;
  const card = $("inline-card");
  if (!card) return;
  const s = state.session;
  const run = state.activeRun;
  const running = isRunningStatus(run);

  // Driver & model
  const drv = shortDriverTag(run?.driver || s?.driver || state.selection.driver || "ALilaS");
  $("ic-driver").textContent = drv;
  const modelText = formatCompactModelName(run?.model || s?.model, run?.effort || s?.effort);
  $("ic-model").textContent = modelText;
  $("ic-model").title = modelText;

  // Status pill & card top accent
  const statusWrap = $("ic-status");
  const dot = $("ic-dot");
  const statusText = $("ic-status-text");
  const stopBtn = $("ic-btn-stop");

  card.classList.toggle("is-running", running);
  card.classList.toggle(
    "is-error",
    run?.status === "error" || run?.status === "timeout",
  );

  let phaseDesc = "";
  if (running) {
    stopBtn.style.display = "inline-flex";
    if (run.stalled) {
      statusWrap.className = "ic-status stalled";
      dot.className = "dot stalled";
      statusText.textContent = `静默 ${run.idleSec}s`;
      phaseDesc = `疑似无响应 · 静默 ${run.idleSec}s`;
    } else {
      statusWrap.className = "ic-status running";
      dot.className = "dot running";
      const phaseMap = {
        booting: "启动中",
        session_ready: "就绪",
        turn_start: "开始",
        step_start: "推理中",
        thinking: "思考中",
        writing: "回复中",
      };
      const p = run.phase?.startsWith("tool:")
        ? `执行 ${run.phase.slice(5)}`
        : phaseMap[run.phase] || "运行中";
      statusText.textContent = `${p} · S${run.step || 1} · ${run.elapsedSec}s`;
      phaseDesc = run.phase?.startsWith("tool:")
        ? `⚡ 正在执行 ${run.phase.slice(5)}`
        : `✦ ${p} · 右侧面板查看实时思维链`;
    }
  } else {
    stopBtn.style.display = "none";
    if (run?.status === "error" || run?.status === "timeout") {
      statusWrap.className = "ic-status error";
      dot.className = "dot error";
      statusText.textContent =
        run.status === "timeout" ? `超时 · ${run.elapsedSec}s` : `异常 · ${run.elapsedSec}s`;
    } else if (run?.status === "stopped") {
      statusWrap.className = "ic-status";
      dot.className = "dot idle";
      statusText.textContent = `已停止 · ${run.elapsedSec}s`;
    } else if (run?.status === "done") {
      statusWrap.className = "ic-status done";
      dot.className = "dot done";
      statusText.textContent = `完成 · ${run.elapsedSec}s`;
    } else if (s?.interrupted) {
      statusWrap.className = "ic-status stalled";
      dot.className = "dot stalled";
      statusText.textContent = "上次中断";
    } else if (s) {
      statusWrap.className = "ic-status";
      dot.className = "dot idle";
      statusText.textContent = formatTime(s.mtimeMs) || "历史";
    } else {
      statusWrap.className = "ic-status";
      dot.className = "dot idle";
      statusText.textContent = "待命";
    }
  }

  // Project & session title (click to expand full title cleanly)
  const midEl = $("ic-mid");
  const projEl = $("ic-proj");
  const titleBtn = $("ic-title-btn");
  const titleEl = $("ic-title");
  const proj = shortProjectName(run?.cwd || s?.cwd || state.scopeCwd, s?.workspaceSlug || "");
  if (proj) {
    projEl.textContent = proj;
    projEl.title = run?.cwd || s?.cwd || state.scopeCwd || proj;
    projEl.style.display = "inline-flex";
  } else {
    projEl.style.display = "none";
  }
  const curMeta = state.sessions.find((x) => x.sessionId === state.selectedSessionId);
  const title =
    curMeta?.alias ||
    s?.alias ||
    s?.title ||
    curMeta?.title ||
    run?.taskPreview ||
    (state.selectedSessionId ? state.selectedSessionId : "右侧 ALilaS 面板查看完整会话");
  titleEl.textContent = title;
  if (midEl) midEl.classList.toggle("expanded", state.inlineTitleExpanded);
  if (titleBtn) {
    titleBtn.setAttribute("aria-expanded", String(state.inlineTitleExpanded));
    titleBtn.title = state.inlineTitleExpanded ? "点击收起标题" : `${title}\n（点击展开完整标题）`;
  }
  requestAnimationFrame(() => {
    if (!titleBtn || !titleEl) return;
    const isOverflowing = !state.inlineTitleExpanded && titleEl.scrollWidth > titleEl.clientWidth + 1;
    titleBtn.classList.toggle("can-expand", isOverflowing || state.inlineTitleExpanded);
  });

  // Footer left: inline warning OR live phase OR crisp counters
  const footLeft = $("ic-foot-left");
  const st = s?.stats || {};
  if (state.errorMsg) {
    footLeft.innerHTML = `<span class="ic-err-inline" title="${escapeHtml(
      state.errorMsg,
    )}">⚠ ${escapeHtml(state.errorMsg)}</span>`;
  } else if (running && phaseDesc) {
    footLeft.innerHTML = `<span class="ic-live-phase">${escapeHtml(phaseDesc)}</span>`;
  } else if (s) {
    footLeft.innerHTML = `<span class="ic-counts"><span>思<b>${
      st.reasoningCount ?? 0
    }</b></span><span>工<b>${st.toolCallCount ?? 0}</b></span><span>回<b>${
      st.textCount ?? 0
    }</b></span></span>`;
  } else {
    footLeft.innerHTML = `<span class="ic-counts">ALilaS 就绪 · 右侧面板查看详情</span>`;
  }

  // Footer right: minimalist 3-metric telemetry
  const usage = run?.usage || s?.usage || null;
  const cw = run?.contextWindow || s?.contextWindow || 1_000_000;
  const used = usage?.totalTokens || 0;
  const pct = used > 0 ? Math.min(100, (used / cw) * 100) : 0;
  const pctLabel = pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
  const ringTone = pct >= 85 ? "danger" : pct >= 70 ? "warn" : "";
  const circumference = 37.7;
  const dash = ((pct / 100) * circumference).toFixed(2);
  const tps = run?.tps || s?.lastTps || state.telemetry?.lastTps || 0;
  const tpsLabel = tps > 0 ? `${tps.toFixed(1)} tok/s` : "-- tok/s";
  const totalBurned = Math.max(
    state.telemetry?.allTimeTokens || 0,
    s?.cumulativeTokens || 0,
    run?.cumulativeTokens || 0,
    used,
  );

  $("ic-tel").innerHTML = `
    <span class="ic-tel-item ${ringTone}" title="上下文窗口占用">
      <svg viewBox="0 0 16 16" width="12" height="12">
        <circle class="ring-track" cx="8" cy="8" r="6" />
        <circle class="ring-fill" cx="8" cy="8" r="6" stroke-dasharray="${dash} ${circumference}" transform="rotate(-90 8 8)" />
      </svg>
      <span>${used ? pctLabel : "0%"}</span>
    </span>
    <span class="ic-tel-item" title="当前生成速率">
      <span style="color:var(--brand)">★</span>
      <span>${tpsLabel}</span>
    </span>
    <span class="ic-tel-item" title="跨会话累计用量">
      <svg class="bars-svg" viewBox="0 0 14 14" width="10" height="10">
        <rect x="1" y="7" width="2.4" height="6" rx="1" />
        <rect x="5.8" y="2" width="2.4" height="11" rx="1" />
        <rect x="10.6" y="4.5" width="2.4" height="8.5" rx="1" />
      </svg>
      <span>${formatTokens(totalBurned)}</span>
    </span>`;

  syncInlineCardHeight();
}

function renderAll(forceFullTimeline = false) {
  syncInitialSelection();
  renderStatus();
  renderSessionSelect();
  renderAgentChips();
  renderStats();
  renderManageBar();
  renderModelCapsule();
  if (state.activeView) renderOverlayView(false);
  renderComposerState();
  renderErrorBanner();
  renderTimeline(forceFullTimeline);
  renderInlineCard();
}

// ---------------------------------------------------------------- Polling

async function pollState(force = false) {
  if (state.polling) return;
  state.polling = true;
  try {
    const res = await app.callServerTool({
      name: "alilas_poll_state",
      arguments: {
        session_id: state.selectedSessionId || undefined,
        scope_cwd: state.allProjects ? undefined : state.scopeCwd || undefined,
        all_projects: state.allProjects,
        headless_only: state.headlessOnly,
        plugin_only: state.pluginOnly,
        include_hidden: state.includeHidden,
        max_items: 180,
        if_none_match: force ? "" : state.lastEtag,
      },
    });
    const snap = res?.structuredContent;
    if (snap) {
      state.consecutivePollFailures = 0;
      state.errorMsg = "";
      state.lastEtag = snap.etag || "";
      state.activeRun = snap.activeRun || null;
      state.activeRuns = snap.activeRuns || [];
      if (snap.telemetry) state.telemetry = snap.telemetry;
      if (snap.settings) state.settings = snap.settings;

      if (snap.unchanged) {
        renderErrorBanner();
        renderStatus();
        renderAgentChips();
        renderStats();
        renderInlineCard();
        if (state.activeView && state.activeView !== "settings") {
          renderOverlayView(false);
        }
        if (isRunningStatus(state.activeRun)) {
          const liveCard = $("live-stream-card");
          if (liveCard) {
            const nextHtml = buildLiveFooterHtml(state.activeRun);
            if (nextHtml) {
              const tpl = document.createElement("template");
              tpl.innerHTML = nextHtml.trim();
              liveCard.replaceWith(tpl.content.firstElementChild);
            }
          }
        }
      } else {
        state.sessions = snap.sessions || [];
        state.recentCwds = snap.recentCwds || state.recentCwds;
        state.drivers = snap.drivers || state.drivers;
        state.customProfiles = snap.customProfiles || state.customProfiles;
        if (snap.defaultSelection) state.defaultSelection = snap.defaultSelection;
        state.selectedSessionId = snap.selectedSessionId || null;
        state.session = snap.session || null;
        renderAll(force);
      }
    }
  } catch (e) {
    state.consecutivePollFailures++;
    const rawMsg = e?.message || String(e);
    const isTransport = /failed to fetch|network|aborted|timeout|mcp error 2/i.test(rawMsg);
    if (!isTransport || state.consecutivePollFailures >= 2) {
      state.errorMsg = isTransport
        ? "宿主连接暂时中断，正在自动重连…（若持续未恢复请点 ↻ 或重开 ALilaS 标签页）"
        : `同步失败: ${rawMsg}`;
      renderErrorBanner();
      renderInlineCard();
    }
  } finally {
    state.polling = false;
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  if (state.consecutivePollFailures >= 2) {
    const backoff = Math.min(15000, 4000 * Math.pow(2, state.consecutivePollFailures - 2));
    state.pollTimer = setTimeout(() => pollState(false), backoff);
    return;
  }
  const hasLiveStream = Boolean(state.activeRun?.live?.active);
  const running = anyActiveRun();
  const delay = hasLiveStream ? 650 : running ? 1300 : 4000;
  state.pollTimer = setTimeout(() => pollState(false), delay);
}

// ---------------------------------------------------------------- View Navigation

function openView(viewName) {
  state.activeView = viewName;
  if (viewName === "settings") {
    if (state.selection.profileId || state.selection.driver === "direct") {
      state.settingsEngineTab = "direct";
    } else if (["dsh", "agy", "claude", "codex"].includes(state.selection.driver)) {
      state.settingsEngineTab = state.selection.driver;
    }
    if (state.selection.driver === "dsh" && state.selection.model?.includes("/")) {
      state.expandedProviders.add(state.selection.model.split("/")[0]);
    }
  }
  renderOverlayView(true);
}

function closeView() {
  if (!state.activeView) return;
  state.activeView = null;
  renderOverlayView(true);
}

async function pinDefaultModel({ driver = "", model = "", effort = "high", profileId = "" }) {
  try {
    const res = await app.callServerTool({
      name: "alilas_ui_manage_profiles",
      arguments: {
        action: "set_default",
        driver,
        model,
        effort,
        profile_id: profileId,
      },
    });
    const sc = res?.structuredContent;
    if (sc?.defaultSelection) state.defaultSelection = sc.defaultSelection;
    state.lastEtag = "";
    showToast("已设为全局默认子代理模型");
    renderModelCapsule();
    if (state.activeView === "settings") refreshSettingsModelSection();
  } catch (e) {
    showToast(`设置默认失败: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------- Events

function bindEvents() {
  const timeline = $("timeline");

  timeline.addEventListener(
    "toggle",
    (e) => {
      const el = e.target;
      if (el?.tagName === "DETAILS" && el.hasAttribute("data-key")) {
        const k = el.getAttribute("data-key");
        if (el.open) {
          state.openDetails.add(k);
          state.closedDetails.delete(k);
        } else {
          state.closedDetails.add(k);
          state.openDetails.delete(k);
        }
      }
    },
    true,
  );

  timeline.addEventListener("click", (e) => {
    const copyRawBtn = e.target.closest("[data-copy-raw]");
    if (copyRawBtn) {
      e.preventDefault();
      e.stopPropagation();
      copyText(decodeURIComponent(copyRawBtn.getAttribute("data-copy-raw") || ""));
      return;
    }
    const copyKeyBtn = e.target.closest("[data-copy-key]");
    if (copyKeyBtn) {
      e.preventDefault();
      e.stopPropagation();
      const it = itemLookup.get(copyKeyBtn.getAttribute("data-copy-key"));
      if (it?.text) copyText(it.text);
      return;
    }
    const attachBtn = e.target.closest("[data-attach]");
    if (attachBtn) {
      e.preventDefault();
      e.stopPropagation();
      const it = itemLookup.get(attachBtn.getAttribute("data-attach"));
      if (it?.text) {
        const label = it.kind === "reasoning" ? `思考 S${it.step}` : `回复 T${it.turn}`;
        attachContextToHost(label, it.text);
      }
      return;
    }
    const fileBtn = e.target.closest("[data-open-file]");
    if (fileBtn) {
      e.preventDefault();
      e.stopPropagation();
      openFileInHost(fileBtn.getAttribute("data-open-file"));
      return;
    }
    const extLink = e.target.closest("a[data-ext-url]");
    if (extLink) {
      e.preventDefault();
      const url = extLink.getAttribute("data-ext-url");
      if (url && state.canOpenLinks) app.openLink({ url }).catch(() => {});
    }
  });

  // Top telemetry & gear strip -> strictly isolated views
  $("stats-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-view]");
    if (!btn) return;
    openView(btn.getAttribute("data-open-view"));
  });

  // Bottom model capsule -> opens Settings view directly
  $("btn-model-trigger").addEventListener("click", () => openView("settings"));

  // Close isolated overlay view
  $("btn-close-overlay").addEventListener("click", closeView);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.activeView) closeView();
  });

  // Overlay interactions (persist fold states, in-place model list updates)
  $("ov-body").addEventListener(
    "toggle",
    (e) => {
      const el = e.target;
      if (el?.tagName === "DETAILS" && el.hasAttribute("data-fold")) {
        const k = el.getAttribute("data-fold");
        if (el.open) state.openSettingsFolds.add(k);
        else state.openSettingsFolds.delete(k);
      }
    },
    true,
  );

  $("ov-body").addEventListener("input", (e) => {
    if (e.target?.id === "settings-model-search") {
      state.modelSearch = e.target.value || "";
      const listEl = $("settings-model-list");
      if (listEl) listEl.innerHTML = buildSettingsModelListHtml();
      return;
    }
    if (e.target?.id?.startsWith("pf-") || e.target?.hasAttribute("data-eff-key") || e.target?.hasAttribute("data-eff-val")) {
      syncDirectDraftFromDom();
    }
  });

  $("ov-body").addEventListener("click", async (e) => {
    const engBtn = e.target.closest("[data-eng-tab]");
    if (engBtn) {
      state.settingsEngineTab = engBtn.getAttribute("data-eng-tab") || "dsh";
      refreshSettingsModelSection();
      return;
    }

    const pinProfBtn = e.target.closest("[data-pin-profile]");
    if (pinProfBtn) {
      e.stopPropagation();
      const pid = pinProfBtn.getAttribute("data-pin-profile");
      const eff = pinProfBtn.getAttribute("data-pin-effort") ?? "";
      const p = state.customProfiles.find((x) => x.id === pid);
      if (p) {
        await pinDefaultModel({
          driver: p.driver || "direct",
          model: p.model,
          effort: p.reasoningEnabled === false ? "" : eff || p.effort || "",
          profileId: p.id,
        });
      }
      return;
    }

    const pinBtn = e.target.closest("[data-pin-driver]");
    if (pinBtn) {
      e.stopPropagation();
      await pinDefaultModel({
        driver: pinBtn.getAttribute("data-pin-driver") || "",
        model: pinBtn.getAttribute("data-pin-model") || "",
        effort: pinBtn.getAttribute("data-pin-effort") ?? "",
        profileId: "",
      });
      return;
    }

    const toggleProvBtn = e.target.closest("[data-toggle-provider]");
    if (toggleProvBtn) {
      const key = toggleProvBtn.getAttribute("data-toggle-provider");
      if (state.expandedProviders.has(key)) state.expandedProviders.delete(key);
      else state.expandedProviders.add(key);
      const listEl = $("settings-model-list");
      if (listEl) listEl.innerHTML = buildSettingsModelListHtml();
      return;
    }

    const pickProfBtn = e.target.closest("[data-pick-profile]");
    if (pickProfBtn) {
      const pid = pickProfBtn.getAttribute("data-pick-profile");
      const eff = pickProfBtn.getAttribute("data-pick-effort") ?? "";
      const rowKey = pickProfBtn.getAttribute("data-toggle-row");
      const applyToast = pickProfBtn.getAttribute("data-apply-toast") === "1";
      const p = state.customProfiles.find((x) => x.id === pid);
      if (p) {
        const nextEffort = p.reasoningEnabled === false ? "" : eff || p.effort || "";
        state.selection = {
          driver: p.driver || "direct",
          model: p.model,
          effort: nextEffort,
          profileId: p.id,
        };
        state.userTouchedModel = true;
        if (rowKey) {
          state.expandedModelRow = state.expandedModelRow === rowKey ? "" : rowKey;
        }
        renderModelCapsule();
        if (applyToast || !rowKey) {
          showToast(
            `已切换: ${p.name || p.model}${nextEffort ? ` · ${effortLabel(nextEffort)}` : ""}`,
          );
        }
        refreshSettingsModelSection();
      }
      return;
    }

    const pickBtn = e.target.closest("[data-pick-driver]");
    if (pickBtn) {
      const drv = pickBtn.getAttribute("data-pick-driver") || "";
      const mdl = pickBtn.getAttribute("data-pick-model") || "";
      const eff = pickBtn.getAttribute("data-pick-effort") ?? "";
      const rowKey = pickBtn.getAttribute("data-toggle-row");
      const applyToast = pickBtn.getAttribute("data-apply-toast") === "1";

      state.selection = { driver: drv, model: mdl, effort: eff, profileId: "" };
      state.userTouchedModel = true;
      if (rowKey) {
        state.expandedModelRow = state.expandedModelRow === rowKey ? "" : rowKey;
      }
      renderModelCapsule();
      if (applyToast) {
        const d = getSelectionDisplay();
        showToast(`已切换: ${d.name}${d.effort ? ` · ${d.effort}` : ""}`);
      }
      refreshSettingsModelSection();
      return;
    }

    if (e.target.closest("#btn-refresh-drivers")) {
      const res = await app.callServerTool({
        name: "alilas_ui_manage_profiles",
        arguments: { action: "refresh_drivers" },
      });
      if (res?.structuredContent?.drivers) state.drivers = res.structuredContent.drivers;
      state.lastEtag = "";
      showToast("已重新探测引擎与上游");
      renderModelCapsule();
      renderOverlayView(true);
      return;
    }

    if (e.target.closest("#btn-save-idle")) {
      const val = Number($("set-idle-sec")?.value) || 180;
      const res = await app.callServerTool({
        name: "alilas_ui_manage_profiles",
        arguments: { action: "update_settings", settings: { idleTimeoutSec: val } },
      });
      if (res?.structuredContent?.settings) state.settings = res.structuredContent.settings;
      state.lastEtag = "";
      showToast(`已保存告警阈值 ${state.settings.idleTimeoutSec}s`);
      renderOverlayView(true);
      return;
    }

    if (e.target.closest("#btn-discover-direct")) {
      syncDirectDraftFromDom();
      const baseURL = state.directDraft.baseURL.trim();
      if (!baseURL) {
        showToast("请先填写 Base URL");
        return;
      }
      state.discoverDirectLoading = true;
      state.discoverDirectError = "";
      state.discoveredDirectModels = [];
      state.openSettingsFolds.add("custom");
      renderOverlayView(true);
      try {
        const res = await app.callServerTool({
          name: "alilas_ui_manage_profiles",
          arguments: {
            action: "discover_models",
            base_url: baseURL,
            api_key_env: state.directDraft.apiKeyEnv.trim(),
            api: state.directDraft.api || "openai-completions",
          },
        });
        const disc = res?.structuredContent?.discovered;
        if (disc?.ok && Array.isArray(disc.models)) {
          state.discoveredDirectModels = disc.models;
          showToast(`已获取 ${disc.models.length} 个可用模型，点击一键回填`);
        } else {
          state.discoverDirectError = disc?.error || "获取模型失败";
        }
      } catch (err) {
        state.discoverDirectError = err?.message || String(err);
      } finally {
        state.discoverDirectLoading = false;
        renderOverlayView(true);
      }
      return;
    }

    const applyDiscBtn = e.target.closest("[data-apply-discovered]");
    if (applyDiscBtn) {
      syncDirectDraftFromDom();
      const idx = Number(applyDiscBtn.getAttribute("data-apply-discovered"));
      const m = state.discoveredDirectModels[idx];
      if (m) {
        const d = state.directDraft;
        d.model = m.id;
        if (!d.name.trim()) d.name = m.name || m.id;
        d.contextWindow = String(m.contextWindow || 200000);
        if (m.maxTokens) d.maxTokens = String(m.maxTokens);
        d.reasoningEnabled = m.reasoningEnabled !== false;
        d.effortRows = Object.entries(m.effortMap || {}).map(([key, val]) => ({ key, val: val ?? "" }));
        d.effort = m.defaultEffort || "";
        state.probeDirectResult = null;
        showToast(`已回填 ${m.id}`);
        renderOverlayView(true);
      }
      return;
    }

    if (e.target.closest("#btn-toggle-effort-map")) {
      syncDirectDraftFromDom();
      state.directDraft.showEffortEditor = !state.directDraft.showEffortEditor;
      renderOverlayView(true);
      return;
    }

    if (e.target.closest("#btn-add-effort-row")) {
      syncDirectDraftFromDom();
      state.directDraft.effortRows.push({ key: "", val: "" });
      state.directDraft.showEffortEditor = true;
      renderOverlayView(true);
      return;
    }

    const delEffBtn = e.target.closest("[data-del-effort-row]");
    if (delEffBtn) {
      syncDirectDraftFromDom();
      const idx = Number(delEffBtn.getAttribute("data-del-effort-row"));
      if (Number.isInteger(idx) && idx >= 0) {
        state.directDraft.effortRows.splice(idx, 1);
        renderOverlayView(true);
      }
      return;
    }

    if (e.target.closest("#btn-probe-direct")) {
      syncDirectDraftFromDom();
      const d = state.directDraft;
      if (!d.baseURL.trim() || !d.model.trim()) {
        showToast("请先填写 Base URL 和模型 ID");
        return;
      }
      state.probeDirectLoading = true;
      state.probeDirectResult = null;
      renderOverlayView(true);
      try {
        const res = await app.callServerTool({
          name: "alilas_ui_manage_profiles",
          arguments: {
            action: "probe_tools",
            base_url: d.baseURL.trim(),
            api_key_env: d.apiKeyEnv.trim(),
            api: d.api || "openai-completions",
            model: d.model.trim(),
            max_tokens: Number(d.maxTokens) || 1024,
            reasoning_enabled: Boolean(d.reasoningEnabled),
            effort: d.reasoningEnabled ? d.effort || "" : "",
            effort_map: d.reasoningEnabled ? draftToEffortMap(d) : {},
          },
        });
        state.probeDirectResult = res?.structuredContent?.probe || {
          ok: false,
          message: "未收到探针响应",
        };
      } catch (err) {
        state.probeDirectResult = { ok: false, message: err?.message || String(err) };
      } finally {
        state.probeDirectLoading = false;
        renderOverlayView(true);
      }
      return;
    }

    const editBtn = e.target.closest("[data-edit-profile]");
    if (editBtn) {
      const pid = editBtn.getAttribute("data-edit-profile") || "";
      const p = state.customProfiles.find((x) => x.id === pid) || null;
      state.editingProfileId = p ? p.id : "";
      loadProfileIntoDraft(p);
      state.openSettingsFolds.add("custom");
      renderOverlayView(true);
      return;
    }

    if (e.target.closest("#btn-cancel-edit-profile")) {
      state.editingProfileId = "";
      loadProfileIntoDraft(null);
      renderOverlayView(true);
      return;
    }

    if (e.target.closest("#btn-save-profile")) {
      syncDirectDraftFromDom();
      const d = state.directDraft;
      const name = d.name.trim();
      const api = d.api || "openai-completions";
      const model = d.model.trim();
      const baseURL = d.baseURL.trim();
      const apiKeyEnv = d.apiKeyEnv.trim();
      const cw = Number(d.contextWindow) || 200000;
      const maxTokens = Number(d.maxTokens) || 64000;
      const inputs = d.supportsImage ? ["text", "image"] : ["text"];
      const reasoningEnabled = Boolean(d.reasoningEnabled);
      const effortMap = reasoningEnabled ? draftToEffortMap(d) : {};
      const effort = reasoningEnabled ? d.effort || "" : "";
      if (!model) {
        showToast("请填写模型 ID");
        return;
      }
      if (!baseURL) {
        showToast("请填写 Base URL");
        return;
      }
      const wasEditing = Boolean(state.editingProfileId);
      const res = await app.callServerTool({
        name: "alilas_ui_manage_profiles",
        arguments: {
          action: "upsert_profile",
          profile: {
            id: state.editingProfileId || undefined,
            name: name || model,
            driver: "direct",
            api,
            provider: (name || "direct").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "direct",
            model,
            baseURL,
            apiKeyEnv,
            contextWindow: cw,
            maxTokens,
            inputs,
            reasoningEnabled,
            effortMap,
            effort,
          },
        },
      });
      if (res?.structuredContent?.customProfiles) {
        state.customProfiles = res.structuredContent.customProfiles;
      }
      if (res?.structuredContent?.drivers) {
        state.drivers = res.structuredContent.drivers;
      }
      state.editingProfileId = "";
      loadProfileIntoDraft(null);
      state.discoveredDirectModels = [];
      state.discoverDirectError = "";
      state.settingsEngineTab = "direct";
      state.lastEtag = "";
      showToast(wasEditing ? "已更新直连模型" : "已保存直连模型");
      renderModelCapsule();
      renderOverlayView(true);
      return;
    }

    const delBtn = e.target.closest("[data-del-profile]");
    if (delBtn) {
      const pid = delBtn.getAttribute("data-del-profile");
      const res = await app.callServerTool({
        name: "alilas_ui_manage_profiles",
        arguments: { action: "delete_profile", profile_id: pid },
      });
      if (res?.structuredContent?.customProfiles) {
        state.customProfiles = res.structuredContent.customProfiles;
      }
      if (res?.structuredContent?.drivers) {
        state.drivers = res.structuredContent.drivers;
      }
      if (state.editingProfileId === pid) {
        state.editingProfileId = "";
        loadProfileIntoDraft(null);
      }
      if (state.selection.profileId === pid) {
        state.selection = { driver: "", model: "", effort: "high", profileId: "" };
        state.userTouchedModel = false;
      }
      state.lastEtag = "";
      showToast("已删除直连模型");
      renderModelCapsule();
      renderOverlayView(true);
    }
  });

  $("ov-body").addEventListener("change", async (e) => {
    if (e.target?.id === "pf-reasoning-on") {
      syncDirectDraftFromDom();
      state.directDraft.reasoningEnabled = Boolean(e.target.checked);
      if (state.directDraft.reasoningEnabled && state.directDraft.effortRows.length === 0) {
        state.directDraft.effortRows = [
          { key: "off", val: "" },
          { key: "low", val: "low" },
          { key: "medium", val: "medium" },
          { key: "high", val: "high" },
        ];
      }
      renderOverlayView(true);
      return;
    }
    if (e.target?.id?.startsWith("pf-")) {
      syncDirectDraftFromDom();
      return;
    }
    if (e.target?.id === "set-scan-dsh") {
      const checked = Boolean(e.target.checked);
      const res = await app.callServerTool({
        name: "alilas_ui_manage_profiles",
        arguments: { action: "update_settings", settings: { scanDshDesktop: checked } },
      });
      if (res?.structuredContent?.settings) state.settings = res.structuredContent.settings;
      if (res?.structuredContent?.drivers) state.drivers = res.structuredContent.drivers;
      state.lastEtag = "";
      showToast(checked ? "已开启 DSH 桌面端上游扫描" : "已关闭 DSH 桌面端上游扫描");
      renderOverlayView(true);
    }
  });

  // Session & top bar actions
  $("agents-bar").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-sid]");
    if (!chip) return;
    const sid = chip.getAttribute("data-sid");
    if (sid) {
      state.selectedSessionId = sid;
      state.lastEtag = "";
      pollState(true);
    }
  });

  $("session-select").addEventListener("change", (e) => {
    state.selectedSessionId = e.target.value || null;
    state.lastEtag = "";
    pollState(true);
  });

  $("btn-more").addEventListener("click", () => {
    state.showManageBar = !state.showManageBar;
    renderManageBar();
  });

  $("chk-all-projects").addEventListener("change", (e) => {
    state.allProjects = e.target.checked;
    if (!state.allProjects && !state.scopeCwd && state.session?.cwd) {
      state.scopeCwd = state.session.cwd;
    }
    state.lastEtag = "";
    pollState(true);
  });

  $("chk-plugin-only").addEventListener("change", (e) => {
    state.pluginOnly = e.target.checked;
    if (state.pluginOnly) {
      state.headlessOnly = true;
      $("chk-include-desktop").checked = false;
    }
    state.lastEtag = "";
    pollState(true);
  });

  $("chk-include-desktop").addEventListener("change", (e) => {
    state.headlessOnly = !e.target.checked;
    if (e.target.checked) {
      state.pluginOnly = false;
      $("chk-plugin-only").checked = false;
    }
    state.lastEtag = "";
    pollState(true);
  });

  $("chk-show-hidden").addEventListener("change", (e) => {
    state.includeHidden = e.target.checked;
    state.lastEtag = "";
    pollState(true);
  });

  $("btn-pin-session").addEventListener("click", async () => {
    const cur = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
    if (!cur) return;
    await app.callServerTool({
      name: "alilas_ui_manage_session",
      arguments: { session_id: cur.sessionId, action: cur.pinned ? "unpin" : "pin" },
    });
    state.lastEtag = "";
    showToast(cur.pinned ? "已取消置顶" : "已置顶");
    pollState(true);
  });

  function closeRenameRow() {
    $("rename-row").style.display = "none";
  }

  async function submitRename() {
    const cur = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
    if (!cur) return;
    const val = $("rename-input").value.trim();
    closeRenameRow();
    await app.callServerTool({
      name: "alilas_ui_manage_session",
      arguments: { session_id: cur.sessionId, action: "rename", alias: val },
    });
    state.lastEtag = "";
    showToast("已更新名称");
    pollState(true);
  }

  $("btn-rename-session").addEventListener("click", () => {
    const cur = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
    if (!cur) return;
    const row = $("rename-row");
    const inp = $("rename-input");
    if (row.style.display === "flex") {
      closeRenameRow();
      return;
    }
    inp.value = cur.alias || cur.title || "";
    row.style.display = "flex";
    inp.focus();
    inp.select();
  });

  $("btn-rename-save").addEventListener("click", submitRename);
  $("btn-rename-cancel").addEventListener("click", closeRenameRow);
  $("rename-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitRename(); }
    else if (e.key === "Escape") { e.preventDefault(); closeRenameRow(); }
  });

  $("btn-hide-session").addEventListener("click", async () => {
    const cur = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
    if (!cur) return;
    await app.callServerTool({
      name: "alilas_ui_manage_session",
      arguments: { session_id: cur.sessionId, action: cur.hidden ? "unhide" : "hide" },
    });
    if (!cur.hidden) state.selectedSessionId = null;
    state.lastEtag = "";
    showToast(cur.hidden ? "已恢复显示" : "已从列表隐藏");
    pollState(true);
  });

  function doManualRefresh() {
    state.consecutivePollFailures = 0;
    state.lastEtag = "";
    pollState(true);
  }
  $("btn-refresh").addEventListener("click", doManualRefresh);
  $("ic-btn-refresh").addEventListener("click", doManualRefresh);
  $("ic-title-btn")?.addEventListener("click", () => {
    state.inlineTitleExpanded = !state.inlineTitleExpanded;
    renderInlineCard();
  });

  $("btn-toggle-reason").addEventListener("click", () => {
    state.expandAllReasoning = !state.expandAllReasoning;
    state.openDetails.clear();
    state.closedDetails.clear();
    $("btn-toggle-reason").classList.toggle("active", state.expandAllReasoning);
    $("btn-toggle-reason").textContent = state.expandAllReasoning ? "折叠思考" : "展开思考";
    renderAll(true);
  });

  $("btn-toggle-tools").addEventListener("click", () => {
    state.showTools = !state.showTools;
    $("btn-toggle-tools").classList.toggle("active", !state.showTools);
    $("btn-toggle-tools").textContent = state.showTools ? "工具" : "已隐藏工具";
    renderAll(true);
  });

  async function doStopTask() {
    if (!state.activeRun?.runId) return;
    try {
      await app.callServerTool({
        name: "alilas_ui_stop_task",
        arguments: { run_id: state.activeRun.runId },
      });
      state.lastEtag = "";
      showToast("已停止任务");
      pollState(true);
    } catch (e) {
      state.errorMsg = `停止失败: ${e?.message || e}`;
      renderAll(false);
    }
  }
  $("btn-stop").addEventListener("click", doStopTask);
  $("ic-btn-stop").addEventListener("click", doStopTask);

  $("btn-perm-mode").addEventListener("click", () => {
    state.permissionMode = state.permissionMode === "auto" ? "readonly" : "auto";
    renderComposerState();
    showToast(state.permissionMode === "readonly" ? "已切为只读审计模式" : "已切为自动执行模式");
  });

  $("chk-new-session").addEventListener("change", () => {
    if ($("chk-new-session").checked && state.session?.cwd) {
      $("cwd-input").value = state.session.cwd;
    }
    renderComposerState();
  });

  async function doSendTask() {
    const input = $("task-input");
    const task = input.value.trim();
    if (!task) return;
    const forceNew = $("chk-new-session").checked;
    const chosen = state.selection;
    const switchingDriver =
      state.session?.driver && chosen.driver && state.session.driver !== chosen.driver;
    const sid =
      forceNew || switchingDriver || !state.session?.isHeadless
        ? undefined
        : state.selectedSessionId || undefined;
    const cwd = sid ? undefined : $("cwd-input").value.trim() || state.session?.cwd || undefined;
    input.value = "";
    try {
      const res = await app.callServerTool({
        name: "alilas_ui_send_task",
        arguments: {
          task,
          session_id: sid,
          cwd,
          driver: chosen.driver || undefined,
          model: chosen.model || undefined,
          effort: chosen.effort || undefined,
          profile_id: chosen.profileId || undefined,
          permission_mode: state.permissionMode,
        },
      });
      if (res?.isError || res?.structuredContent?.error) {
        state.errorMsg = res?.structuredContent?.error || res?.content?.[0]?.text || "启动失败";
        renderAll(false);
        return;
      }
      const run = res?.structuredContent?.run;
      if (run?.sessionId) state.selectedSessionId = run.sessionId;
      if (!sid && run?.cwd && !state.allProjects) state.scopeCwd = run.cwd;
      state.activeRun = run || state.activeRun;
      $("chk-new-session").checked = false;
      state.lastEtag = "";
      pollState(true);
    } catch (e) {
      state.errorMsg = `发送失败: ${e?.message || e}`;
      renderAll(false);
    }
  }

  $("btn-send-task").addEventListener("click", doSendTask);
  $("task-input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      doSendTask();
    }
  });

  $("btn-send-neon").addEventListener("click", async () => {
    if (!state.canMessageHost || !state.session) return;
    const reply = state.session.lastAssistantText || "(无回复文本)";
    const msg = `请审阅 ALilaS 会话 ${state.session.sessionId} [${shortDriverTag(
      state.session.driver,
    )}/${state.session.model || "default"}] 的最新输出：\n\n${reply.slice(0, 1800)}`;
    try {
      await app.sendMessage({ role: "user", content: [{ type: "text", text: msg }] });
      showToast("已发回主对话");
    } catch (e) {
      state.errorMsg = `发送失败: ${e?.message || e}`;
      renderAll(false);
    }
  });
}

// ---------------------------------------------------------------- MCP App Lifecycle

function updateSurfaceMode(ctx) {
  const maxH = ctx?.containerDimensions?.maxHeight;
  const hasInlineCap = typeof maxH === "number" && maxH > 0;
  // Antigravity sets containerDimensions.maxHeight ONLY on inline conversation cards.
  // Side pane & global views fill their full pane and omit maxHeight.
  const isInline = hasInlineCap || (window.innerHeight > 0 && window.innerHeight <= 260);
  if (state.isInline !== isInline) {
    state.isInline = isInline;
    state.lastInlineHeight = 0;
    document.documentElement.classList.toggle("is-inline", isInline);
    if (isInline) renderInlineCard();
  }
}

function applyTheme(ctx) {
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute("data-theme", ctx.theme);
  }
  if (ctx?.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  updateSurfaceMode(ctx);
}

app.ontoolinput = ({ arguments: args }) => {
  if (args?.session_id) state.selectedSessionId = args.session_id;
  if (args?.cwd) {
    state.scopeCwd = args.cwd;
    state.allProjects = false;
  }
  if (typeof args?.all_projects === "boolean") state.allProjects = args.all_projects;
  if (typeof args?.headless_only === "boolean") {
    state.headlessOnly = args.headless_only;
    $("chk-include-desktop").checked = !state.headlessOnly;
  }
};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (sc?.selectedSessionId) state.selectedSessionId = sc.selectedSessionId;
  if (typeof sc?.scopeCwd === "string") state.scopeCwd = sc.scopeCwd;
  if (typeof sc?.allProjects === "boolean") state.allProjects = sc.allProjects;
  if (sc?.activeRun) state.activeRun = sc.activeRun;
  state.lastEtag = "";
  pollState(true);
};

app.onhostcontextchanged = (ctx) => applyTheme(ctx);

async function init() {
  bindEvents();
  window.addEventListener("resize", () => {
    try {
      updateSurfaceMode(app.getHostContext());
    } catch {
      updateSurfaceMode(null);
    }
  });
  await app.connect();
  applyTheme(app.getHostContext());
  const caps = app.getHostCapabilities();
  state.canMessageHost = Boolean(caps?.message);
  state.canUpdateContext = Boolean(caps?.updateModelContext);
  state.canOpenLinks = Boolean(caps?.openLinks);
  renderComposerState();
  await pollState(true);
}

init().catch((e) => {
  const errBar = $("error-banner");
  if (errBar) {
    errBar.textContent = `初始化失败: ${e?.message || String(e)}`;
    errBar.style.display = "block";
  }
});
