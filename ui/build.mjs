import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../server/node_modules/esbuild/lib/main.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "src", "app.js");
const outDir = path.join(__dirname, "dist");
fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  minify: true,
  write: false,
  nodePaths: [path.join(__dirname, "..", "server", "node_modules")],
});

const jsCode = result.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LilaS</title>
<style>
  :root {
    --bg-1: var(--color-background-primary, #0f1117);
    --bg-2: var(--color-background-secondary, #161922);
    --bg-3: var(--color-background-tertiary, #1f2430);
    --fg-1: var(--color-text-primary, #eceef2);
    --fg-2: var(--color-text-secondary, #a2aab8);
    --fg-3: var(--color-text-tertiary, #6e7787);
    --bd-1: var(--color-border-primary, #272d3b);
    --bd-2: var(--color-border-secondary, #1e2330);
    --brand: #a78bfa;
    --brand-fg: #c4b5fd;
    --brand-soft: rgba(167, 139, 250, 0.14);
    --brand-btn-fg: #0d0a1a;
    --accent: var(--color-text-info, #60a5fa);
    --success: var(--color-text-success, #34d399);
    --danger: var(--color-text-danger, #f87171);
    --warn: var(--color-text-warning, #fbbf24);
    --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --radius: 8px;
  }
  :root[data-theme="light"] {
    --brand: #7c3aed;
    --brand-fg: #6d28d9;
    --brand-soft: rgba(124, 58, 237, 0.10);
    --brand-btn-fg: #ffffff;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg-1); color: var(--fg-1);
    font-family: var(--font); font-size: 13px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .app-shell {
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    position: relative;
  }

  /* Header */
  .header {
    padding: 9px 12px 8px;
    border-bottom: 1px solid var(--bd-1);
    background: var(--bg-2);
    display: flex; flex-direction: column; gap: 7px;
    flex-shrink: 0;
  }
  .header-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .brand-wrap {
    display: flex; align-items: center; gap: 8px; min-width: 0;
  }
  .brand {
    font-weight: 700; font-size: 14px; letter-spacing: 0.02em;
    color: var(--fg-1); white-space: nowrap;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .brand-mark {
    width: 8px; height: 8px; border-radius: 3px;
    background: var(--brand); transform: rotate(45deg); flex-shrink: 0;
  }
  .status-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; color: var(--fg-2);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot.idle { background: var(--fg-3); }
  .dot.done { background: var(--success); }
  .dot.error { background: var(--danger); }
  .dot.stalled { background: var(--warn); }
  .dot.running {
    background: var(--success);
    animation: pulse 1.4s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.65); }
    70% { box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
    100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
  }
  .head-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

  .session-row { display: flex; align-items: center; gap: 6px; }
  select {
    flex: 1; min-width: 0;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 4px 8px; font-size: 12px; font-family: var(--font);
    outline: none;
  }
  select:focus, input:focus, textarea:focus { border-color: var(--brand); }

  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    background: transparent; color: var(--fg-2);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 3px 8px; font-size: 11.5px; cursor: pointer;
    white-space: nowrap; transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .btn:hover:not(:disabled) { background: var(--bg-3); color: var(--fg-1); }
  .btn.active { background: var(--brand-soft); color: var(--brand-fg); border-color: var(--brand); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary {
    background: var(--brand); color: var(--brand-btn-fg);
    border-color: transparent; font-weight: 600; padding: 4px 12px;
  }
  .btn-primary:hover:not(:disabled) { background: var(--brand); filter: brightness(1.08); color: var(--brand-btn-fg); }
  .btn-danger {
    color: var(--danger); border-color: var(--danger);
  }
  .btn-danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.14); color: var(--danger); }

  /* Collapsible secondary bar */
  .manage-bar {
    display: none; flex-direction: column; gap: 6px;
    padding: 6px 12px; background: var(--bg-2);
    border-bottom: 1px solid var(--bd-2); flex-shrink: 0;
  }
  .manage-top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; flex-wrap: wrap;
  }
  .manage-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rename-row {
    display: none; align-items: center; gap: 6px;
  }
  .rename-row input {
    flex: 1; min-width: 0;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 3px 8px; font-family: var(--font); font-size: 12px; outline: none;
  }
  .chk-label {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11.5px; color: var(--fg-2); cursor: pointer; user-select: none;
  }
  .chk-label input { accent-color: var(--brand); margin: 0; }

  /* Multi-Agent running chips */
  .agents-bar {
    display: none; align-items: center; gap: 6px;
    padding: 5px 12px; background: var(--bg-1);
    border-bottom: 1px solid var(--bd-2);
    overflow-x: auto; flex-shrink: 0;
  }
  .agent-chip {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 2px 9px; border-radius: 999px;
    background: var(--bg-2); border: 1px solid var(--bd-1);
    color: var(--fg-2); font-size: 11px; cursor: pointer; white-space: nowrap;
  }
  .agent-chip:hover { border-color: var(--brand); color: var(--fg-1); }
  .agent-chip.active {
    background: var(--brand-soft); border-color: var(--brand); color: var(--brand-fg);
  }
  .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
  .chip-dot.stalled { background: var(--warn); }
  .chip-meta { color: var(--fg-3); font-size: 10.5px; }

  /* Compact Stats Strip */
  .stats-bar {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 5px 12px; background: var(--bg-1);
    border-bottom: 1px solid var(--bd-2);
    font-size: 11px; color: var(--fg-2); flex-shrink: 0;
  }
  .stat-item { display: inline-flex; align-items: center; gap: 3px; }
  .stat-item b { color: var(--fg-1); font-weight: 600; }
  .stat-item.muted { color: var(--fg-3); }
  .stat-sep { color: var(--bd-1); }
  .stat-tag.readonly {
    font-size: 10.5px; padding: 0 6px; border-radius: 4px;
    background: var(--bg-3); color: var(--fg-2);
  }
  .ctx-meter {
    display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
    color: var(--fg-3); font-size: 10.5px;
  }
  .ctx-track {
    width: 44px; height: 4px; border-radius: 99px;
    background: var(--bg-3); overflow: hidden; display: inline-block;
  }
  .ctx-fill { display: block; height: 100%; background: var(--brand); border-radius: 99px; }
  .ctx-meter.warn .ctx-fill { background: var(--warn); }
  .ctx-meter.warn .ctx-text { color: var(--warn); }
  .ctx-meter.danger .ctx-fill { background: var(--danger); }
  .ctx-meter.danger .ctx-text { color: var(--danger); }

  .error-banner {
    display: none; padding: 6px 12px; font-size: 12px;
    background: rgba(248, 113, 113, 0.12); color: var(--danger);
    border-bottom: 1px solid var(--danger); flex-shrink: 0;
  }

  /* Timeline */
  .timeline {
    flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 16px;
    display: block;
  }
  .empty-state {
    margin: 56px auto; text-align: center; max-width: 280px;
  }
  .empty-mark {
    font-size: 18px; font-weight: 700; letter-spacing: 0.04em;
    color: var(--brand-fg); margin-bottom: 6px;
  }
  .empty-desc { color: var(--fg-3); font-size: 12px; }
  .notice-banner {
    text-align: center; font-size: 11px; color: var(--fg-3);
    padding: 3px 8px; border-radius: 6px; background: var(--bg-2);
    margin-bottom: 8px;
  }

  .card {
    border: 1px solid var(--bd-1); border-radius: var(--radius);
    background: var(--bg-2); overflow: hidden;
    margin-bottom: 8px;
  }
  .card-user { border-left: 2.5px solid var(--accent); }
  .card-reasoning { border-left: 2.5px solid var(--brand); }
  .card-text { border-left: 2.5px solid var(--success); }
  .card-tool { border-left: 2.5px solid var(--bd-1); background: var(--bg-1); }
  .card-tool.is-running { border-left-color: var(--warn); }
  .card-tool.is-err, .card-error { border-left: 2.5px solid var(--danger); }
  .card-live { border-color: var(--brand); background: var(--bg-2); }

  .card-head {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; font-size: 11.5px; list-style: none;
  }
  .card-head::-webkit-details-marker { display: none; }
  .card-head.clickable { cursor: pointer; user-select: none; }
  .card-head.clickable:hover { background: var(--bg-3); }

  .tag {
    font-weight: 600; font-size: 11px; padding: 1px 6px; border-radius: 4px;
    white-space: nowrap; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
  }
  .tag-user { background: rgba(96, 165, 250, 0.15); color: var(--accent); }
  .tag-reason { background: var(--brand-soft); color: var(--brand-fg); }
  .tag-text { background: rgba(52, 211, 153, 0.15); color: var(--success); }
  .tag-tool { background: var(--bg-3); color: var(--fg-2); }
  .tag-run { background: rgba(251, 191, 36, 0.15); color: var(--warn); }
  .tag-err { background: rgba(248, 113, 113, 0.16); color: var(--danger); }
  .tag-live { background: var(--brand-soft); color: var(--brand-fg); }

  .summary-preview {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--fg-2); font-size: 11.5px;
  }
  .card-actions {
    display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex-shrink: 0;
  }
  .meta { color: var(--fg-3); font-size: 10.5px; white-space: nowrap; }
  .icon-btn, .mini-copy {
    background: transparent; border: 1px solid transparent; border-radius: 4px;
    color: var(--fg-3); font-size: 10.5px; padding: 1px 5px; cursor: pointer;
  }
  .icon-btn:hover, .mini-copy:hover {
    color: var(--fg-1); background: var(--bg-3); border-color: var(--bd-1);
  }

  .card-body {
    padding: 8px 10px 10px; border-top: 1px solid var(--bd-2);
    font-size: 12.5px; word-break: break-word;
  }
  .pre-wrap { white-space: pre-wrap; }
  .reasoning-text {
    color: var(--fg-2); font-size: 12px; line-height: 1.6;
    background: var(--bg-1);
  }
  .mono, .code-block { font-family: var(--mono); font-size: 11.5px; }
  .code-block {
    margin: 0; padding: 7px 8px; overflow-x: auto; white-space: pre-wrap;
    color: var(--fg-2); background: var(--bg-2); border: 1px solid var(--bd-2);
    border-radius: 6px; max-height: 240px;
  }

  /* Merged tool details */
  .tool-body { display: flex; flex-direction: column; gap: 8px; }
  .file-pills { display: flex; flex-wrap: wrap; gap: 5px; }
  .file-pill {
    font-family: var(--mono); font-size: 11px;
    background: var(--brand-soft); color: var(--brand-fg);
    border: 1px solid transparent; border-radius: 5px;
    padding: 2px 7px; cursor: pointer;
  }
  .file-pill:hover { border-color: var(--brand); }
  .tool-sec-head {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 10.5px; color: var(--fg-3); margin-bottom: 3px;
  }
  .tool-pending { font-size: 11.5px; color: var(--warn); }

  /* Markdown */
  .md-body { line-height: 1.6; }
  .md-p { margin: 0 0 7px; }
  .md-p:last-child { margin-bottom: 0; }
  .md-h { margin: 10px 0 5px; font-weight: 600; line-height: 1.35; }
  .md-h:first-child { margin-top: 0; }
  .md-h1 { font-size: 15px; }
  .md-h2 { font-size: 14px; }
  .md-h3 { font-size: 13px; }
  .md-h4 { font-size: 12.5px; color: var(--fg-2); }
  .md-list { margin: 4px 0 8px; padding-left: 18px; }
  .md-list li { margin-bottom: 2px; }
  .md-quote {
    margin: 6px 0; padding: 4px 10px;
    border-left: 2.5px solid var(--brand); color: var(--fg-2);
    background: var(--bg-1); border-radius: 0 5px 5px 0;
  }
  .md-hr { border: 0; border-top: 1px solid var(--bd-1); margin: 8px 0; }
  .md-inline-code {
    font-family: var(--mono); font-size: 11.5px;
    background: var(--bg-3); padding: 1px 4px; border-radius: 4px;
  }
  .md-link { color: var(--brand-fg); text-decoration: underline; }
  .md-code-wrap {
    margin: 6px 0; border: 1px solid var(--bd-1); border-radius: 6px; overflow: hidden;
    background: var(--bg-1);
  }
  .md-code-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 3px 8px; background: var(--bg-3); font-size: 10.5px; color: var(--fg-3);
  }
  .md-pre {
    margin: 0; padding: 8px 10px; overflow-x: auto;
    font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
  }
  .md-table-wrap { overflow-x: auto; margin: 6px 0; }
  .md-table {
    border-collapse: collapse; width: 100%; font-size: 11.5px;
  }
  .md-table th, .md-table td {
    border: 1px solid var(--bd-1); padding: 4px 8px; text-align: left;
  }
  .md-table th { background: var(--bg-3); font-weight: 600; }

  /* Live stream & spinners */
  .live-block { margin-bottom: 8px; }
  .live-block:last-child { margin-bottom: 0; }
  .live-label { font-size: 10.5px; color: var(--brand-fg); margin-bottom: 3px; font-weight: 600; }
  .live-tool {
    display: flex; align-items: center; gap: 6px;
    font-size: 11.5px; color: var(--fg-2); margin-top: 4px;
  }
  .cursor {
    display: inline-block; width: 6px; height: 12px; margin-left: 2px;
    background: var(--brand); vertical-align: -2px;
    animation: blink 0.9s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .running-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; border-radius: var(--radius);
    background: var(--bg-2); border: 1px dashed var(--brand);
    color: var(--brand-fg); font-size: 12px;
  }
  .spinner, .spinner-sm {
    border: 2px solid var(--brand); border-top-color: transparent;
    border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
  .spinner { width: 12px; height: 12px; }
  .spinner-sm { width: 9px; height: 9px; border-width: 1.5px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Composer */
  .composer {
    border-top: 1px solid var(--bd-1); background: var(--bg-2);
    padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 6px;
    flex-shrink: 0;
  }
  .cwd-row {
    display: none; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-2);
  }
  .cwd-row input {
    flex: 1; min-width: 0;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 3px 8px; font-family: var(--mono); font-size: 11.5px; outline: none;
  }
  textarea {
    width: 100%; min-height: 44px; max-height: 120px; resize: vertical;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 6px 8px; font-family: var(--font); font-size: 12.5px; outline: none;
  }
  .composer-actions {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
  }
  .composer-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .cwd-hint {
    font-size: 11px; color: var(--fg-3); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }

  /* Toast */
  .toast {
    position: absolute; bottom: 72px; left: 50%; transform: translateX(-50%) translateY(8px);
    background: var(--bg-3); color: var(--fg-1); border: 1px solid var(--bd-1);
    padding: 4px 12px; border-radius: 999px; font-size: 11.5px;
    opacity: 0; pointer-events: none; transition: opacity 0.16s, transform 0.16s;
    z-index: 20;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
<div class="app-shell">
  <div class="header">
    <div class="header-row">
      <div class="brand-wrap">
        <span class="brand"><span class="brand-mark"></span>LilaS</span>
        <span class="status-pill">
          <span id="status-dot" class="dot idle"></span>
          <span id="status-label">加载中…</span>
        </span>
      </div>
      <div class="head-actions">
        <button id="btn-stop" type="button" class="btn btn-danger" style="display:none;">停止</button>
        <button id="btn-toggle-reason" type="button" class="btn">展开思考</button>
        <button id="btn-toggle-tools" type="button" class="btn">工具</button>
        <button id="btn-refresh" type="button" class="btn" title="刷新">↻</button>
      </div>
    </div>
    <div class="session-row">
      <select id="session-select"></select>
      <button id="btn-more" type="button" class="btn" title="会话筛选与管理">⋯</button>
    </div>
  </div>

  <div id="manage-bar" class="manage-bar">
    <div class="manage-top">
      <div class="manage-group">
        <label class="chk-label" title="跨所有项目显示全部会话与运行中分身">
          <input id="chk-all-projects" type="checkbox" />
          全部项目
        </label>
        <label class="chk-label" title="只展示本插件发起的 Mode A 会话">
          <input id="chk-plugin-only" type="checkbox" checked />
          仅插件
        </label>
        <label class="chk-label" title="包含桌面端历史会话（只读）">
          <input id="chk-include-desktop" type="checkbox" />
          含桌面
        </label>
        <label class="chk-label" title="显示已隐藏会话">
          <input id="chk-show-hidden" type="checkbox" />
          已隐藏
        </label>
      </div>
      <div class="manage-group">
        <button id="btn-rename-session" type="button" class="btn">重命名</button>
        <button id="btn-pin-session" type="button" class="btn">置顶</button>
        <button id="btn-hide-session" type="button" class="btn">隐藏</button>
      </div>
    </div>
    <div id="rename-row" class="rename-row">
      <input id="rename-input" maxlength="60" placeholder="输入会话别名（留空恢复默认标题）" />
      <button id="btn-rename-save" type="button" class="btn btn-primary">保存</button>
      <button id="btn-rename-cancel" type="button" class="btn">取消</button>
    </div>
  </div>

  <div id="agents-bar" class="agents-bar"></div>
  <div id="stats-bar" class="stats-bar"></div>
  <div id="error-banner" class="error-banner"></div>
  <div id="timeline" class="timeline"></div>

  <div class="composer">
    <div id="cwd-row" class="cwd-row">
      <span>目录</span>
      <input id="cwd-input" list="cwd-datalist" placeholder="输入工作目录绝对路径…" />
      <datalist id="cwd-datalist"></datalist>
    </div>
    <textarea id="task-input" placeholder="继续当前会话… (Ctrl+Enter)"></textarea>
    <div class="composer-actions">
      <div class="composer-left">
        <label class="chk-label">
          <input id="chk-new-session" type="checkbox" />
          新会话
        </label>
        <span id="cwd-hint" class="cwd-hint"></span>
      </div>
      <div style="display:flex;gap:6px;">
        <button id="btn-send-neon" type="button" class="btn" style="display:none;">发回 Neon</button>
        <button id="btn-send-task" type="button" class="btn btn-primary">发送</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>
</div>
<script type="module">${jsCode}</script>
</body>
</html>
`;

const outPath = path.join(outDir, "app.html");
fs.writeFileSync(outPath, html, "utf8");
console.log(`Built ${outPath} (${Buffer.byteLength(html, "utf8")} bytes)`);
