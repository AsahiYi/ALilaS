import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { escapeHtml, renderMarkdown } from "./markdown.js";

const app = new App({ name: "lilas", version: "2.1.0" }, {});

const state = {
  selectedSessionId: null,
  scopeCwd: "",
  allProjects: true,
  headlessOnly: true,
  pluginOnly: true,
  includeHidden: false,
  sessions: [],
  recentCwds: [],
  activeRun: null,
  activeRuns: [],
  session: null,
  expandAllReasoning: false,
  showTools: true,
  showManageBar: false,
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
  toastMsg: "",
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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function shortProjectName(cwd, slug) {
  if (cwd) {
    const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }
  return (slug || "").replace(/^--|--$/g, "").split("-").pop() || "";
}

function isRunningStatus(run) {
  return Boolean(run && (run.status === "running" || run.status === "starting"));
}

function anyActiveRun() {
  return state.activeRuns.some(isRunningStatus) || isRunningStatus(state.activeRun);
}

function showToast(msg) {
  state.toastMsg = msg;
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 1800);
}

async function copyText(text, label = "已复制") {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label);
      return;
    } catch {
      // Sandboxed iframe may deny Clipboard API; fall through to execCommand
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
    if (res?.isError) {
      showToast("当前视图不支持侧栏打开文件");
    }
  } catch {
    showToast("无法打开文件预览");
  }
}

async function attachContextToHost(title, body) {
  if (!state.canUpdateContext) return;
  try {
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `[LilaS 引用 · ${title}]\n${body.slice(0, 6000)}`,
        },
      ],
    });
    showToast("已附加到下条对话上下文");
  } catch {
    showToast("附加失败");
  }
}

// ---------------------------------------------------------------- Header & Bars

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
      run.status === "timeout"
        ? `超时 (${run.elapsedSec}s)`
        : `异常 (${run.elapsedSec}s)`;
    stopBtn.style.display = "none";
  } else if (run?.status === "stopped") {
    dot.className = "dot idle";
    label.textContent = `已停止 (${run.elapsedSec}s)`;
    stopBtn.style.display = "none";
  } else if (run?.status === "done") {
    dot.className = "dot done";
    label.textContent = `完成 · ${run.elapsedSec}s`;
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
        const proj = shortProjectName(s.cwd, s.workspaceSlug);
        const name = (s.alias || s.title || s.sessionId).slice(0, 32);
        return `<option value="${escapeHtml(s.sessionId)}">${prefix}${
          proj ? `[${escapeHtml(proj)}] ` : ""
        }${escapeHtml(name)} (${s.reasoningCount})</option>`;
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
  // Keep UI clean: show switchable chips only when >=2 parallel agents run in current scope (or if running agent differs from selected)
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
      const label = state.allProjects ? proj : `分身${idx + 1}`;
      const dotCls = r.stalled ? "chip-dot stalled" : "chip-dot";
      return `<button type="button" class="agent-chip ${isSel ? "active" : ""}" data-sid="${escapeHtml(
        r.sessionId || "",
      )}" title="${escapeHtml(r.taskPreview || "")}"><span class="${dotCls}"></span><span>${escapeHtml(
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
  if (!s) {
    bar.innerHTML = `<span class="stat-item muted">LilaS 就绪</span>`;
    return;
  }
  const st = s.stats || {};
  const proj = shortProjectName(s.cwd, "");
  const usage = state.activeRun?.usage || s.usage || null;

  const items = [];
  if (!s.isHeadless) {
    items.push(`<span class="stat-tag readonly">桌面只读</span>`);
  }
  if (proj) {
    items.push(`<span class="stat-item" title="${escapeHtml(s.cwd || "")}">${escapeHtml(proj)}</span>`);
  }
  items.push(`<span class="stat-item">思考 <b>${st.reasoningCount ?? 0}</b></span>`);
  items.push(`<span class="stat-item">工具 <b>${st.toolCallCount ?? 0}</b></span>`);
  items.push(`<span class="stat-item">回复 <b>${st.textCount ?? 0}</b></span>`);

  if (usage?.totalTokens) {
    const pct = Math.min(100, (usage.totalTokens / 1_000_000) * 100);
    const cacheDenom = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0);
    const cachePct =
      cacheDenom > 0 ? Math.round(((usage.cacheReadTokens || 0) / cacheDenom) * 100) : null;
    const tone = pct >= 85 ? "danger" : pct >= 70 ? "warn" : "";
    const tip = `上下文 ${formatTokens(usage.totalTokens)} / 1M (${pct.toFixed(1)}%)${
      cachePct !== null ? ` · 缓存命中 ${cachePct}%` : ""
    }`;
    items.push(`
      <span class="ctx-meter ${tone}" title="${escapeHtml(tip)}">
        <span class="ctx-track"><span class="ctx-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="ctx-text">${formatTokens(usage.totalTokens)}/1M</span>
      </span>`);
  }

  bar.innerHTML = items.join('<span class="stat-sep">·</span>');
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
  const hasSession = Boolean(cur);

  if (!state.showManageBar || !hasSession) {
    $("rename-row").style.display = "none";
  }

  pinBtn.disabled = !hasSession;
  renameBtn.disabled = !hasSession;
  hideBtn.disabled = !hasSession;
  pinBtn.textContent = cur?.pinned ? "取消置顶" : "置顶";
  hideBtn.textContent = cur?.hidden ? "取消隐藏" : "隐藏";
}

// ---------------------------------------------------------------- Timeline (Incremental DOM)

function buildCardHtml(item, key, isLastReasoning) {
  const ctxBtn = state.canUpdateContext
    ? `<button type="button" class="icon-btn" data-attach="${escapeHtml(key)}" title="引用到下条对话上下文">引用</button>`
    : "";

  if (item.kind === "user") {
    const isNeon = item.text.startsWith("[来自 Neon");
    return `
      <div class="card card-user" data-card-key="${escapeHtml(key)}">
        <div class="card-head">
          <span class="tag tag-user">${isNeon ? "Neon" : "指令"}</span>
          <span class="meta">T${item.turn || 1}</span>
        </div>
        <div class="card-body pre-wrap">${escapeHtml(item.text)}</div>
      </div>`;
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
            <button type="button" class="icon-btn" data-copy-key="${escapeHtml(key)}" title="复制">复制</button>
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
          <span class="tag tag-text">LilaS</span>
          <span class="card-actions">
            <span class="meta">T${item.turn || 1} · S${item.step || 0}</span>
            <button type="button" class="icon-btn" data-copy-key="${escapeHtml(key)}" title="复制 Markdown">复制</button>
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
            <span class="tag tag-live"><span class="spinner-sm"></span> 实时流</span>
            <span class="meta">S${run.step || 1} · ${run.elapsedSec}s</span>
          </div>
          <div class="card-body">${blocks.join("")}</div>
        </div>`;
    }
    return `
      <div class="running-footer" id="live-stream-card">
        <span class="spinner"></span>
        <span>LilaS 处理中（S${run.step || 1} · ${run.elapsedSec}s）…</span>
      </div>`;
  }
  if (run?.error) {
    return `
      <div class="card card-error" id="live-stream-card">
        <div class="card-head"><span class="tag tag-err">运行异常</span></div>
        <pre class="card-body code-block">${escapeHtml(run.error)}</pre>
      </div>`;
  }
  return "";
}

// Lookup map for copy/attach buttons
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
        <div class="empty-mark">LilaS</div>
        <div class="empty-desc">等待任务派发，或在下方直接输入指令开始新会话。</div>
      </div>`;
    return;
  }

  const sessionChanged = forceFull || state.lastRenderedSessionId !== s.sessionId;
  if (sessionChanged) {
    state.lastRenderedSessionId = s.sessionId;
    state.renderedCardSigs.clear();
    container.innerHTML = "";
  }

  // Ensure notice banner if truncated
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
  }

  // Filter visible items and find latest reasoning index
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

  // Remove live card temporarily while reconciling cards
  const existingLive = $("live-stream-card");
  if (existingLive) existingLive.remove();

  // Map existing DOM cards
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
      // Ensure chronological position even if an earlier sibling was re-inserted
      const expectedPrev = prevAnchor;
      const inPlace = expectedPrev
        ? expectedPrev.nextElementSibling === existingEl
        : container.firstElementChild === existingEl;
      if (!inPlace) {
        if (expectedPrev) expectedPrev.after(existingEl);
        else container.prepend(existingEl);
      }
      prevAnchor = existingEl;
      return; // untouched content! preserves text selection & scroll
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

  // Prune stale cards (e.g. when showTools toggled off or window slid)
  for (const [k, el] of existingNodes.entries()) {
    if (!activeKeys.has(k)) {
      el.remove();
      state.renderedCardSigs.delete(k);
    }
  }

  // Append live streaming / running footer
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
  const sendToNeonBtn = $("btn-send-neon");
  sendToNeonBtn.style.display = state.canMessageHost ? "inline-flex" : "none";

  const isDesktop = state.session && !state.session.isHeadless;
  const input = $("task-input");
  const sendBtn = $("btn-send-task");
  const newChk = $("chk-new-session");
  const cwdRow = $("cwd-row");
  const cwdInput = $("cwd-input");
  const cwdHint = $("cwd-hint");

  // Populate datalist with recentCwds
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
    cwdHint.textContent = "";
  } else {
    input.placeholder = willCreateNew
      ? "输入新任务给 LilaS… (Ctrl+Enter)"
      : "继续当前会话… (Ctrl+Enter)";
    sendBtn.disabled = false;
    cwdHint.textContent =
      !willCreateNew && state.session?.cwd
        ? `📁 ${shortProjectName(state.session.cwd, "")}`
        : "";
    cwdHint.title = state.session?.cwd || "";
  }
}

function renderAll(forceFullTimeline = false) {
  renderStatus();
  renderSessionSelect();
  renderAgentChips();
  renderStats();
  renderManageBar();
  renderComposerState();

  const errBar = $("error-banner");
  if (state.errorMsg) {
    errBar.textContent = state.errorMsg;
    errBar.style.display = "block";
  } else {
    errBar.style.display = "none";
  }

  renderTimeline(forceFullTimeline);
}

// ---------------------------------------------------------------- Polling

async function pollState(force = false) {
  if (state.polling) return;
  state.polling = true;
  try {
    const res = await app.callServerTool({
      name: "lilas_poll_state",
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
      state.errorMsg = "";
      state.lastEtag = snap.etag || "";
      state.activeRun = snap.activeRun || null;
      state.activeRuns = snap.activeRuns || [];

      if (snap.unchanged) {
        // Still update elapsed timers and chips smoothly
        renderStatus();
        renderAgentChips();
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
        state.selectedSessionId = snap.selectedSessionId || null;
        state.session = snap.session || null;
        renderAll(force);
      }
    }
  } catch (e) {
    state.errorMsg = `同步失败: ${e?.message || String(e)}`;
    renderAll(false);
  } finally {
    state.polling = false;
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  const hasLiveStream = Boolean(state.activeRun?.live?.active);
  const running = anyActiveRun();
  const delay = hasLiveStream ? 650 : running ? 1300 : 4000;
  state.pollTimer = setTimeout(() => pollState(false), delay);
}

// ---------------------------------------------------------------- Events

function bindEvents() {
  // Delegated click & toggle handlers inside timeline (no per-render listener churn)
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
      if (url && state.canOpenLinks) {
        app.openLink({ url }).catch(() => {});
      }
    }
  });

  // Agent chips switching
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
      name: "lilas_ui_manage_session",
      arguments: {
        session_id: cur.sessionId,
        action: cur.pinned ? "unpin" : "pin",
      },
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
      name: "lilas_ui_manage_session",
      arguments: {
        session_id: cur.sessionId,
        action: "rename",
        alias: val,
      },
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
    if (e.key === "Enter") {
      e.preventDefault();
      submitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeRenameRow();
    }
  });

  $("btn-hide-session").addEventListener("click", async () => {
    const cur = state.sessions.find((s) => s.sessionId === state.selectedSessionId);
    if (!cur) return;
    await app.callServerTool({
      name: "lilas_ui_manage_session",
      arguments: {
        session_id: cur.sessionId,
        action: cur.hidden ? "unhide" : "hide",
      },
    });
    if (!cur.hidden) state.selectedSessionId = null;
    state.lastEtag = "";
    showToast(cur.hidden ? "已恢复显示" : "已从列表隐藏");
    pollState(true);
  });

  $("btn-refresh").addEventListener("click", () => {
    state.lastEtag = "";
    pollState(true);
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

  $("btn-stop").addEventListener("click", async () => {
    if (!state.activeRun?.runId) return;
    try {
      await app.callServerTool({
        name: "lilas_ui_stop_task",
        arguments: { run_id: state.activeRun.runId },
      });
      state.lastEtag = "";
      showToast("已停止任务");
      pollState(true);
    } catch (e) {
      state.errorMsg = `停止失败: ${e?.message || e}`;
      renderAll(false);
    }
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
    const sid =
      forceNew || !state.session?.isHeadless
        ? undefined
        : state.selectedSessionId || undefined;
    const cwd = sid ? undefined : $("cwd-input").value.trim() || undefined;
    input.value = "";
    try {
      const res = await app.callServerTool({
        name: "lilas_ui_send_task",
        arguments: { task, session_id: sid, cwd },
      });
      if (res?.isError || res?.structuredContent?.error) {
        state.errorMsg = res?.structuredContent?.error || res?.content?.[0]?.text || "启动失败";
        renderAll(false);
        return;
      }
      const run = res?.structuredContent?.run;
      if (run?.sessionId) {
        state.selectedSessionId = run.sessionId;
      }
      if (!sid && run?.cwd && !state.allProjects) {
        state.scopeCwd = run.cwd;
      }
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
    const msg = `请审阅 LilaS 会话 ${state.session.sessionId} 的最新输出：\n\n${reply.slice(0, 1800)}`;
    try {
      await app.sendMessage({
        role: "user",
        content: [{ type: "text", text: msg }],
      });
      showToast("已发回对话");
    } catch (e) {
      state.errorMsg = `发送失败: ${e?.message || e}`;
      renderAll(false);
    }
  });
}

// ---------------------------------------------------------------- MCP App Lifecycle

function applyTheme(ctx) {
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute("data-theme", ctx.theme);
  }
  if (ctx?.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

app.ontoolinput = ({ arguments: args }) => {
  if (args?.session_id) state.selectedSessionId = args.session_id;
  if (args?.cwd) {
    state.scopeCwd = args.cwd;
    state.allProjects = false;
  }
  if (typeof args?.all_projects === "boolean") {
    state.allProjects = args.all_projects;
  }
  if (typeof args?.headless_only === "boolean") {
    state.headlessOnly = args.headless_only;
    $("chk-include-desktop").checked = !state.headlessOnly;
  }
};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (sc?.selectedSessionId) {
    state.selectedSessionId = sc.selectedSessionId;
  }
  if (typeof sc?.scopeCwd === "string") {
    state.scopeCwd = sc.scopeCwd;
  }
  if (typeof sc?.allProjects === "boolean") {
    state.allProjects = sc.allProjects;
  }
  if (sc?.activeRun) {
    state.activeRun = sc.activeRun;
  }
  state.lastEtag = "";
  pollState(true);
};

app.onhostcontextchanged = (ctx) => {
  applyTheme(ctx);
};

async function init() {
  bindEvents();
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
