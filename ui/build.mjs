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

const logo48Path = path.join(__dirname, "..", "assets", "logo-48.png");
const logoDataUri = fs.existsSync(logo48Path)
  ? `data:image/png;base64,${fs.readFileSync(logo48Path).toString("base64")}`
  : "";

const html = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ALilaS</title>
<style>
  :root {
    --bg-1: var(--color-background-primary, #0e1015);
    --bg-2: var(--color-background-secondary, #151821);
    --bg-3: var(--color-background-tertiary, #1e2230);
    --surface-soft: rgba(255, 255, 255, 0.03);
    --surface-elev: rgba(255, 255, 255, 0.055);
    --fg-1: var(--color-text-primary, #eef0f5);
    --fg-2: var(--color-text-secondary, #9fa8b8);
    --fg-3: var(--color-text-tertiary, #6b7485);
    --bd-1: var(--color-border-primary, #252b39);
    --bd-2: var(--color-border-secondary, #1c212d);
    --brand: #a78bfa;
    --brand-2: #c084fc;
    --brand-fg: #c4b5fd;
    --brand-soft: rgba(167, 139, 250, 0.14);
    --brand-glow: rgba(167, 139, 250, 0.08);
    --brand-btn-fg: #0d0a1a;
    --accent: var(--color-text-info, #60a5fa);
    --success: var(--color-text-success, #34d399);
    --danger: var(--color-text-danger, #f87171);
    --warn: var(--color-text-warning, #fbbf24);
    --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --radius: 9px;
    --heat-0: rgba(148, 163, 184, 0.11);
    --heat-1: rgba(167, 139, 250, 0.30);
    --heat-2: rgba(167, 139, 250, 0.55);
    --heat-3: rgba(167, 139, 250, 0.80);
    --heat-4: #a78bfa;
  }
  :root[data-theme="light"] {
    --surface-soft: rgba(15, 23, 42, 0.025);
    --surface-elev: rgba(15, 23, 42, 0.05);
    --brand: #7c3aed;
    --brand-2: #9333ea;
    --brand-fg: #6d28d9;
    --brand-soft: rgba(124, 58, 237, 0.10);
    --brand-glow: rgba(124, 58, 237, 0.06);
    --brand-btn-fg: #ffffff;
    --heat-0: rgba(100, 116, 139, 0.12);
    --heat-1: rgba(124, 58, 237, 0.24);
    --heat-2: rgba(124, 58, 237, 0.46);
    --heat-3: rgba(124, 58, 237, 0.72);
    --heat-4: #7c3aed;
  }
  * { box-sizing: border-box; }
  /* Clean slim scrollbars everywhere */
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.22); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.4); }

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
    padding: 8px 12px 7px;
    border-bottom: 1px solid var(--bd-1);
    background: var(--bg-2);
    display: flex; flex-direction: column; gap: 6px;
    flex-shrink: 0;
  }
  .header-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .brand-wrap { display: flex; align-items: center; gap: 7px; min-width: 0; }
  .brand {
    font-weight: 700; font-size: 14px; letter-spacing: 0.02em;
    color: var(--fg-1); white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px;
  }
  .brand-icon { width: 18px; height: 18px; border-radius: 5px; object-fit: cover; flex-shrink: 0; }
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
  .dot.running { background: var(--success); animation: pulse 1.4s infinite; }
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
    padding: 4px 8px; font-size: 12px; font-family: var(--font); outline: none;
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
    border-color: transparent; font-weight: 600; padding: 4px 13px;
  }
  .btn-primary:hover:not(:disabled) { background: var(--brand); filter: brightness(1.08); color: var(--brand-btn-fg); }
  .btn-danger { color: var(--danger); border-color: var(--danger); }
  .btn-danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.14); color: var(--danger); }

  /* Collapsible secondary bar */
  .manage-bar {
    display: none; flex-direction: column; gap: 6px;
    padding: 6px 12px; background: var(--bg-2);
    border-bottom: 1px solid var(--bd-2); flex-shrink: 0;
  }
  .manage-top {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  }
  .manage-group { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .rename-row { display: none; align-items: center; gap: 6px; }
  .rename-row input {
    flex: 1; min-width: 0;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 3px 8px; font-family: var(--font); font-size: 12px; outline: none;
  }
  .chk-label {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11.5px; color: var(--fg-2); cursor: pointer; user-select: none; white-space: nowrap;
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
  .agent-chip.active { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-fg); }
  .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
  .chip-dot.stalled { background: var(--warn); }
  .chip-meta { color: var(--fg-3); font-size: 10.5px; }

  /* Compact Telemetry & Gear Strip */
  .stats-bar {
    display: flex; align-items: center; justify-content: space-between;
    gap: 6px; flex-wrap: wrap;
    padding: 4px 10px; background: var(--bg-1);
    border-bottom: 1px solid var(--bd-2);
    font-size: 11px; color: var(--fg-2); flex-shrink: 0;
  }
  .stats-left { display: flex; align-items: center; gap: 5px; min-width: 0; flex-wrap: wrap; }
  .gear-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 6px;
    background: transparent; border: 1px solid transparent;
    color: var(--fg-3); cursor: pointer; padding: 0; flex-shrink: 0;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .gear-btn:hover { background: var(--bg-3); color: var(--fg-1); border-color: var(--bd-1); }
  .stat-driver {
    font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 4px;
    background: var(--brand-soft); color: var(--brand-fg); letter-spacing: 0.03em;
  }
  .stat-item { display: inline-flex; align-items: center; gap: 2px; }
  .stat-item b { color: var(--fg-1); font-weight: 600; }
  .stat-item.muted, .muted { color: var(--fg-3); }

  .telemetry {
    display: inline-flex; align-items: center; gap: 4px; margin-left: auto;
    font-family: var(--mono); font-size: 11px;
  }
  .tel-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: transparent; border: 1px solid transparent; border-radius: 6px;
    padding: 2px 5px; color: var(--fg-2); cursor: pointer;
    font-family: var(--mono); font-size: 11px; white-space: nowrap;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .tel-btn:hover { background: var(--bg-2); border-color: var(--bd-1); color: var(--fg-1); }
  .tel-pct { color: var(--fg-1); font-weight: 700; }
  .tel-val { color: var(--fg-2); }
  .tel-star { color: var(--brand); font-size: 11.5px; line-height: 1; }
  .ring-svg { flex-shrink: 0; }
  .ring-track { fill: none; stroke: var(--bg-3); stroke-width: 2.3; }
  .ring-fill { fill: none; stroke: var(--fg-1); stroke-width: 2.3; stroke-linecap: round; }
  .tel-ring.warn .ring-fill { stroke: var(--warn); }
  .tel-ring.warn .tel-pct { color: var(--warn); }
  .tel-ring.danger .ring-fill { stroke: var(--danger); }
  .tel-ring.danger .tel-pct { color: var(--danger); }
  .bars-svg { fill: var(--brand); flex-shrink: 0; }

  .error-banner {
    display: none; padding: 6px 12px; font-size: 12px;
    background: rgba(248, 113, 113, 0.12); color: var(--danger);
    border-bottom: 1px solid var(--danger); flex-shrink: 0;
  }

  /* Timeline */
  .timeline {
    flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 16px; display: block;
  }
  .empty-state { margin: 52px auto; text-align: center; max-width: 290px; }
  .empty-mark { font-size: 18px; font-weight: 700; letter-spacing: 0.04em; color: var(--brand-fg); margin-bottom: 6px; }
  .empty-desc { color: var(--fg-3); font-size: 12px; }
  .notice-banner {
    text-align: center; font-size: 11px; color: var(--fg-3);
    padding: 4px 8px; border-radius: 6px; background: var(--bg-2); margin-bottom: 8px;
  }

  .card {
    border: 1px solid var(--bd-1); border-radius: var(--radius);
    background: var(--bg-2); overflow: hidden; margin-bottom: 8px;
  }
  .card-user { border-left: 2.5px solid var(--accent); }
  .card-reasoning { border-left: 2.5px solid var(--brand); }
  .card-text { border-left: 2.5px solid var(--success); }
  .card-tool { border-left: 2.5px solid var(--bd-1); background: var(--bg-1); }
  .card-tool.is-running { border-left-color: var(--warn); }
  .card-tool.is-err, .card-error { border-left: 2.5px solid var(--danger); }
  .card-stopped { border-left: 2.5px solid var(--warn); background: var(--bg-2); }
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
  .card-actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; flex-shrink: 0; }
  .meta { color: var(--fg-3); font-size: 10.5px; white-space: nowrap; }
  .icon-btn, .mini-copy {
    background: transparent; border: 1px solid transparent; border-radius: 4px;
    color: var(--fg-3); font-size: 10.5px; padding: 1px 5px; cursor: pointer;
  }
  .icon-btn:hover, .mini-copy:hover { color: var(--fg-1); background: var(--bg-3); border-color: var(--bd-1); }

  .card-body { padding: 8px 10px 10px; border-top: 1px solid var(--bd-2); font-size: 12.5px; word-break: break-word; }
  .pre-wrap { white-space: pre-wrap; }
  .reasoning-text { color: var(--fg-2); font-size: 12px; line-height: 1.6; background: var(--bg-1); }
  .mono, .code-block { font-family: var(--mono); font-size: 11.5px; }
  .code-block {
    margin: 0; padding: 7px 8px; overflow-x: auto; white-space: pre-wrap;
    color: var(--fg-2); background: var(--bg-2); border: 1px solid var(--bd-2);
    border-radius: 6px; max-height: 240px;
  }

  .tool-body { display: flex; flex-direction: column; gap: 8px; }
  .file-pills { display: flex; flex-wrap: wrap; gap: 5px; }
  .file-pill {
    font-family: var(--mono); font-size: 11px;
    background: var(--brand-soft); color: var(--brand-fg);
    border: 1px solid transparent; border-radius: 5px; padding: 2px 7px; cursor: pointer;
  }
  .file-pill:hover { border-color: var(--brand); }
  .tool-sec-head { display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; color: var(--fg-3); margin-bottom: 3px; }
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
  .md-inline-code { font-family: var(--mono); font-size: 11.5px; background: var(--bg-3); padding: 1px 4px; border-radius: 4px; }
  .md-link { color: var(--brand-fg); text-decoration: underline; }
  .md-code-wrap { margin: 6px 0; border: 1px solid var(--bd-1); border-radius: 6px; overflow: hidden; background: var(--bg-1); }
  .md-code-head { display: flex; align-items: center; justify-content: space-between; padding: 3px 8px; background: var(--bg-3); font-size: 10.5px; color: var(--fg-3); }
  .md-pre { margin: 0; padding: 8px 10px; overflow-x: auto; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; }
  .md-table-wrap { overflow-x: auto; margin: 6px 0; }
  .md-table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
  .md-table th, .md-table td { border: 1px solid var(--bd-1); padding: 4px 8px; text-align: left; }
  .md-table th { background: var(--bg-3); font-weight: 600; }

  /* Live stream & spinners */
  .live-block { margin-bottom: 8px; }
  .live-block:last-child { margin-bottom: 0; }
  .live-label { font-size: 10.5px; color: var(--brand-fg); margin-bottom: 3px; font-weight: 600; }
  .live-tool { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-2); margin-top: 4px; }
  .cursor { display: inline-block; width: 6px; height: 12px; margin-left: 2px; background: var(--brand); vertical-align: -2px; animation: blink 0.9s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .running-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; border-radius: var(--radius);
    background: var(--bg-2); border: 1px dashed var(--brand);
    color: var(--brand-fg); font-size: 12px;
  }
  .spinner, .spinner-sm { border: 2px solid var(--brand); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
  .spinner { width: 12px; height: 12px; }
  .spinner-sm { width: 9px; height: 9px; border-width: 1.5px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Ultra-clean Spacious Composer */
  .composer {
    border-top: 1px solid var(--bd-1); background: var(--bg-2);
    padding: 8px 11px 10px; display: flex; flex-direction: column; gap: 7px; flex-shrink: 0;
  }
  .cwd-row { display: none; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-2); }
  .cwd-row input {
    flex: 1; min-width: 0;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 4px 8px; font-family: var(--mono); font-size: 11.5px; outline: none;
  }
  textarea {
    width: 100%; min-height: 44px; max-height: 128px; resize: vertical;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 8px;
    padding: 7px 10px; font-family: var(--font); font-size: 12.5px; outline: none;
  }
  .composer-actions {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .composer-left {
    display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;
  }
  .composer-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

  .model-capsule {
    display: inline-flex; align-items: center; gap: 5px;
    min-width: 0; max-width: 100%;
    background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 999px;
    padding: 3px 10px 3px 8px; font-size: 11.5px; cursor: pointer;
    transition: border-color 0.14s, background 0.14s;
  }
  .model-capsule:hover { border-color: var(--brand); background: var(--bg-3); }
  .cap-dot { color: var(--brand); font-size: 11px; flex-shrink: 0; }
  .cap-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .cap-effort { color: var(--brand-fg); font-size: 10.5px; flex-shrink: 0; opacity: 0.9; }

  /* Standalone Isolated Overlay View (Context / Usage / Settings) */
  .overlay-view {
    display: none; flex-direction: column;
    position: absolute; inset: 0; z-index: 35;
    background: var(--bg-1);
  }
  .overlay-view.open { display: flex; }
  .ov-header {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 14px; background: var(--bg-2); border-bottom: 1px solid var(--bd-1);
    flex-shrink: 0;
  }
  .ov-title {
    display: inline-flex; align-items: center; gap: 7px; min-width: 0;
    font-weight: 700; font-size: 13px; color: var(--fg-1);
  }
  .ov-icon { color: var(--brand); display: inline-flex; align-items: center; flex-shrink: 0; }
  .ov-sub { font-size: 10.5px; color: var(--fg-3); font-family: var(--mono); font-weight: 400; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* IMPORTANT: display:block (never flex-column) on scrollable container so Chromium never crushes child cards */
  .ov-body {
    flex: 1; min-height: 0; overflow-y: auto; padding: 12px 13px 22px;
    display: block;
  }

  /* Refined Dashboard Cards */
  .hero-card {
    background: linear-gradient(155deg, var(--brand-glow) 0%, var(--bg-2) 60%);
    border: 1px solid var(--bd-1); border-radius: 12px;
    padding: 13px 14px; display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 11px;
  }
  .dash-card {
    background: var(--bg-2); border: 1px solid var(--bd-1); border-radius: 11px;
    padding: 12px 13px; display: flex; flex-direction: column; gap: 10px;
    margin-bottom: 11px;
  }
  .hero-card > *, .dash-card > * { flex-shrink: 0; }
  .ov-body > :last-child { margin-bottom: 0; }
  .dash-head {
    display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;
    font-size: 12px; font-weight: 600; color: var(--fg-1);
  }
  .dash-head-sub { font-size: 11px; color: var(--fg-3); font-weight: 400; font-family: var(--mono); }

  .hero-num-row {
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  }
  .hero-big {
    font-family: var(--mono); font-size: 24px; font-weight: 700; letter-spacing: -0.02em;
    color: var(--fg-1); line-height: 1.15;
  }
  .hero-denom { font-family: var(--mono); font-size: 12px; color: var(--fg-3); margin-left: 5px; font-weight: 500; }
  .hero-pct { font-family: var(--mono); font-size: 16px; font-weight: 700; color: var(--brand-fg); }
  .hero-pct.warn { color: var(--warn); }
  .hero-pct.danger { color: var(--danger); }

  .pill-badge {
    font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
    background: var(--brand-soft); color: var(--brand-fg); font-weight: 600;
    white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  }
  .pill-badge.ok { background: rgba(52, 211, 153, 0.14); color: var(--success); }
  .pill-badge.warn { background: rgba(251, 191, 36, 0.16); color: var(--warn); }
  .pill-badge.danger { background: rgba(248, 113, 113, 0.18); color: var(--danger); }

  .meter-track {
    width: 100%; height: 8px; border-radius: 999px; background: var(--bg-3); overflow: hidden;
  }
  .meter-fill {
    height: 100%; border-radius: 999px;
    background: linear-gradient(90deg, var(--brand), var(--brand-2));
    transition: width 0.25s ease;
  }
  .meter-fill.warn { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
  .meter-fill.danger { background: linear-gradient(90deg, #ef4444, #f87171); }

  .hero-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
    font-size: 11px; color: var(--fg-2); font-family: var(--mono);
  }

  .metric-grid-3 {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px;
    padding-top: 6px; border-top: 1px solid var(--bd-2);
  }
  .metric-grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .metric-tile {
    background: var(--surface-soft); border: 1px solid var(--bd-2); border-radius: 9px;
    padding: 9px 10px; display: flex; flex-direction: column; gap: 3px; min-width: 0;
  }
  .metric-tile.flat { background: transparent; border: 0; padding: 2px 0; }
  .m-label { font-size: 10.5px; color: var(--fg-3); display: flex; align-items: center; gap: 5px; }
  .m-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .m-val {
    font-family: var(--mono); font-size: 15px; font-weight: 700; color: var(--fg-1);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .m-unit { font-size: 10.5px; font-weight: 500; color: var(--fg-3); margin-left: 2px; }
  .m-sub { font-size: 10px; color: var(--fg-3); font-family: var(--mono); }

  .stack-bar {
    display: flex; width: 100%; height: 9px; border-radius: 999px; overflow: hidden; background: var(--bg-3);
    gap: 1.5px;
  }
  .stack-in { background: var(--accent); border-radius: 999px 0 0 999px; }
  .stack-cache { background: var(--brand); }
  .stack-out { background: var(--success); border-radius: 0 999px 999px 0; }
  .stack-legend {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
    font-size: 10.5px; color: var(--fg-2); font-family: var(--mono);
  }
  .leg-item { display: flex; flex-direction: column; gap: 1px; }
  .leg-head { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-3); font-family: var(--font); font-size: 10.5px; }
  .leg-dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; }
  .leg-val { font-weight: 600; color: var(--fg-1); font-size: 11.5px; }

  /* Full-width Responsive 16-week Heatmap */
  .heatmap-grid {
    display: grid;
    grid-template-columns: repeat(16, minmax(0, 1fr));
    grid-template-rows: repeat(7, auto);
    grid-auto-flow: column;
    gap: 3px;
    width: 100%;
  }
  .hm-cell {
    aspect-ratio: 1 / 1; width: 100%; border-radius: 2.5px; background: var(--heat-0);
  }
  .hm-cell.l1 { background: var(--heat-1); }
  .hm-cell.l2 { background: var(--heat-2); }
  .hm-cell.l3 { background: var(--heat-3); }
  .hm-cell.l4 { background: var(--heat-4); }
  .hm-legend {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 10px; color: var(--fg-3); font-family: var(--mono);
  }
  .hm-scale { display: inline-flex; align-items: center; gap: 3px; }
  .hm-sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; background: var(--heat-0); }

  /* Ranked Bars & Call List */
  .rank-row {
    display: flex; flex-direction: column; gap: 4px;
    padding: 7px 9px; border-radius: 8px; background: var(--surface-soft); border: 1px solid var(--bd-2);
  }
  .rank-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; }
  .rank-name { font-weight: 600; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank-meta { font-family: var(--mono); font-size: 11px; color: var(--fg-2); white-space: nowrap; }
  .rank-bar { width: 100%; height: 4px; border-radius: 999px; background: var(--bg-3); overflow: hidden; }
  .rank-fill { height: 100%; border-radius: 999px; background: var(--brand); }

  .call-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 7px 9px; border-radius: 8px; background: var(--surface-soft); border: 1px solid var(--bd-2);
    font-size: 11.5px;
  }
  .call-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .call-top { display: flex; align-items: center; gap: 5px; font-weight: 600; color: var(--fg-1); font-size: 11.5px; }
  .call-sub { font-size: 10.5px; color: var(--fg-3); font-family: var(--mono); }
  .call-right { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; font-family: var(--mono); flex-shrink: 0; }
  .call-tps { font-size: 11.5px; font-weight: 700; color: var(--brand-fg); }
  .call-dur { font-size: 10px; color: var(--fg-3); }

  /* Settings View: Embedded Model Selector & Collapsible Advanced Sections */
  .search-input {
    width: 100%; background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 7px;
    padding: 6px 9px; font-size: 12px; font-family: var(--font); outline: none;
  }
  .engine-pills {
    display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  }
  .eng-pill {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-1); border: 1px solid var(--bd-1); border-radius: 999px;
    padding: 3px 8px; font-size: 11px; color: var(--fg-2); cursor: pointer;
    transition: border-color 0.12s, background 0.12s, color 0.12s;
  }
  .eng-pill:hover { border-color: var(--brand); color: var(--fg-1); }
  .eng-pill.active { background: var(--brand-soft); border-color: var(--brand); color: var(--brand-fg); font-weight: 600; }
  .eng-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--success); }
  .eng-dot.off { background: var(--fg-3); opacity: 0.45; }

  /* display:block on scrollable model-list prevents Chromium flex-shrink crushing */
  .model-list { display: block; max-height: 290px; overflow-y: auto; padding-right: 2px; }
  .pop-empty { padding: 16px 10px; text-align: center; color: var(--fg-3); font-size: 11.5px; }

  .pop-group {
    border: 1px solid var(--bd-2); border-radius: 8px; background: var(--bg-1); overflow: hidden;
    margin-bottom: 5px;
  }
  .pop-group:last-child { margin-bottom: 0; }
  .pop-group-head {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    width: 100%; background: transparent; border: 0; padding: 7px 9px;
    color: var(--fg-2); font-size: 11.5px; font-weight: 600; cursor: pointer; text-align: left;
  }
  .pop-group-head:hover { background: var(--surface-elev); color: var(--fg-1); }
  .pop-group-left { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .pop-group-meta { font-size: 10px; color: var(--fg-3); font-weight: 400; display: inline-flex; align-items: center; gap: 5px; }
  .pop-badge { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: var(--bg-3); color: var(--fg-3); }
  .pop-badge.plugin { background: var(--brand-soft); color: var(--brand-fg); }
  .pop-group-list { border-top: 1px solid var(--bd-2); padding: 4px; display: block; }

  .pop-row-wrap { border-radius: 7px; overflow: hidden; margin-bottom: 3px; }
  .pop-row-wrap:last-child { margin-bottom: 0; }
  .pop-row {
    display: flex; align-items: center; justify-content: space-between; gap: 6px;
    width: 100%; background: transparent; border: 0; border-radius: 7px;
    padding: 6px 8px; color: var(--fg-1); font-size: 12px; cursor: pointer; text-align: left;
  }
  .pop-row:hover:not(:disabled) { background: var(--surface-elev); }
  .pop-row.selected { background: var(--brand-soft); color: var(--brand-fg); }
  .pop-row:disabled { opacity: 0.45; cursor: not-allowed; }
  .pop-row-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
  .pop-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  .pop-row-sub { color: var(--fg-3); font-size: 10.5px; flex-shrink: 0; font-family: var(--mono); }
  .pop-row-right { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; color: var(--fg-3); font-size: 11px; }
  .pop-check { color: var(--brand-fg); font-weight: 700; }

  .effort-tray {
    display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap;
    padding: 6px 8px; background: var(--bg-2); border-top: 1px dashed var(--bd-2);
  }
  .effort-chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .effort-chip {
    background: var(--bg-1); color: var(--fg-2);
    border: 1px solid var(--bd-1); border-radius: 5px;
    padding: 2px 8px; font-size: 11px; cursor: pointer;
  }
  .effort-chip:hover { border-color: var(--brand); color: var(--fg-1); }
  .effort-chip.active { background: var(--brand); color: var(--brand-btn-fg); border-color: transparent; font-weight: 600; }
  .default-pin-btn {
    background: transparent; color: var(--fg-3);
    border: 1px solid var(--bd-1); border-radius: 5px;
    padding: 2px 8px; font-size: 10.5px; cursor: pointer; white-space: nowrap;
  }
  .default-pin-btn:hover { color: var(--brand-fg); border-color: var(--brand); }
  .default-pin-btn.is-def { background: var(--brand-soft); color: var(--brand-fg); border-color: var(--brand); }

  details.fold-card {
    display: block;
    background: var(--bg-2); border: 1px solid var(--bd-1); border-radius: 10px; overflow: hidden;
    margin-bottom: 9px;
  }
  details.fold-card > summary {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 12px; font-size: 12px; font-weight: 600; color: var(--fg-1);
    cursor: pointer; user-select: none; list-style: none; line-height: 1.4;
  }
  details.fold-card > summary::-webkit-details-marker { display: none; }
  details.fold-card > summary:hover { background: var(--surface-elev); }
  .fold-body {
    padding: 10px 12px 12px; border-top: 1px solid var(--bd-2);
    display: block;
  }
  .fold-body > * + * { margin-top: 8px; }

  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .form-grid input, .form-grid select, .setting-input {
    width: 100%; background: var(--bg-1); color: var(--fg-1);
    border: 1px solid var(--bd-1); border-radius: 6px;
    padding: 5px 8px; font-size: 11.5px; font-family: var(--font); outline: none;
  }
  .setting-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 12px; color: var(--fg-2);
  }

  .toast {
    position: absolute; bottom: 82px; left: 50%; transform: translateX(-50%) translateY(8px);
    background: var(--bg-3); color: var(--fg-1); border: 1px solid var(--bd-1);
    padding: 5px 13px; border-radius: 999px; font-size: 11.5px;
    opacity: 0; pointer-events: none; transition: opacity 0.16s, transform 0.16s; z-index: 60;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* Compact Luxury Inline Card (conversation stream only; side pane & global untouched) */
  .inline-card { display: none; }
  html.is-inline,
  html.is-inline body {
    height: auto;
    min-height: 0;
    overflow: hidden;
    background: transparent;
  }
  html.is-inline .app-shell {
    height: auto;
    min-height: 0;
    overflow: visible;
    background: transparent;
  }
  html.is-inline .header,
  html.is-inline .manage-bar,
  html.is-inline .agents-bar,
  html.is-inline .stats-bar,
  html.is-inline .error-banner,
  html.is-inline .timeline,
  html.is-inline .composer,
  html.is-inline .overlay-view,
  html.is-inline .toast {
    display: none !important;
  }
  html.is-inline .inline-card {
    display: flex;
    flex-direction: column;
    gap: 9px;
    position: relative;
    overflow: hidden;
    padding: 12px 14px 11px;
    border-radius: 12px;
    border: 1px solid var(--bd-1);
    background:
      radial-gradient(circle at 0% 0%, var(--brand-glow), transparent 56%),
      linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset;
  }
  html.is-inline .inline-card::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1.5px;
    background: linear-gradient(90deg, var(--brand) 0%, rgba(167, 139, 250, 0.22) 55%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  html.is-inline .inline-card.is-running::before {
    background: linear-gradient(90deg, var(--brand) 0%, var(--success) 52%, transparent 100%);
    opacity: 0.95;
  }
  html.is-inline .inline-card.is-error::before {
    background: linear-gradient(90deg, var(--danger) 0%, rgba(248, 113, 113, 0.2) 60%, transparent 100%);
    opacity: 0.9;
  }
  .ic-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
  }
  .ic-id {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    overflow: hidden;
  }
  .ic-brand {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 13.5px;
    letter-spacing: 0.015em;
    color: var(--fg-1);
    flex-shrink: 0;
  }
  .ic-driver {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 5px;
    background: var(--brand-soft);
    color: var(--brand-fg);
    border: 1px solid rgba(167, 139, 250, 0.28);
    flex-shrink: 0;
  }
  .ic-model {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .ic-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .ic-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    background: var(--surface-elev);
    border: 1px solid var(--bd-1);
    color: var(--fg-2);
    white-space: nowrap;
  }
  .ic-status.running {
    background: rgba(52, 211, 153, 0.10);
    border-color: rgba(52, 211, 153, 0.30);
    color: var(--success);
  }
  .ic-status.done {
    background: rgba(52, 211, 153, 0.07);
    border-color: rgba(52, 211, 153, 0.22);
    color: var(--fg-1);
  }
  .ic-status.stalled {
    background: rgba(251, 191, 36, 0.10);
    border-color: rgba(251, 191, 36, 0.32);
    color: var(--warn);
  }
  .ic-status.error {
    background: rgba(248, 113, 113, 0.10);
    border-color: rgba(248, 113, 113, 0.32);
    color: var(--danger);
  }
  .ic-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid var(--bd-1);
    background: transparent;
    color: var(--fg-2);
    font-size: 11px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .ic-btn:hover { background: var(--bg-3); color: var(--fg-1); }
  .ic-btn.danger {
    color: var(--danger);
    border-color: rgba(248, 113, 113, 0.42);
  }
  .ic-btn.danger:hover { background: rgba(248, 113, 113, 0.14); }
  .ic-btn.icon-only { width: 24px; padding: 0; font-size: 12px; }

  .ic-mid {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .ic-proj {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--fg-2);
    background: var(--surface-soft);
    border: 1px solid var(--bd-2);
    border-radius: 5px;
    padding: 1px 6px;
    flex-shrink: 0;
  }
  .ic-title {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--fg-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .ic-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--bd-2);
    font-size: 11px;
    color: var(--fg-3);
    font-variant-numeric: tabular-nums;
  }
  .ic-foot-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
  }
  .ic-counts {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }
  .ic-counts b { color: var(--fg-2); font-weight: 600; margin-left: 2px; }
  .ic-live-phase {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--brand-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ic-err-inline {
    color: var(--warn);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ic-tel {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    color: var(--fg-2);
    font-family: var(--mono);
    font-size: 11px;
  }
  .ic-tel-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .ic-tel-item.warn { color: var(--warn); }
  .ic-tel-item.danger { color: var(--danger); }
  .ic-tel-item .ring-track { fill: none; stroke: var(--bd-1); stroke-width: 2.1; }
  .ic-tel-item .ring-fill { fill: none; stroke: var(--fg-1); stroke-width: 2.1; stroke-linecap: round; }
  .ic-tel-item.warn .ring-fill { stroke: var(--warn); }
  .ic-tel-item.danger .ring-fill { stroke: var(--danger); }
  .ic-tel-item .bars-svg { fill: var(--brand); }
</style>
</head>
<body>
<div class="app-shell">
  <div id="inline-card" class="inline-card" aria-label="ALilaS 实时状态卡">
    <div class="ic-top">
      <div class="ic-id">
        <span class="ic-brand">
          ${logoDataUri ? `<img class="brand-icon" src="${logoDataUri}" alt="ALilaS" />` : ""}
          ALilaS
        </span>
        <span id="ic-driver" class="ic-driver">ALilaS</span>
        <span id="ic-model" class="ic-model"></span>
      </div>
      <div class="ic-right">
        <span id="ic-status" class="ic-status">
          <span id="ic-dot" class="dot idle"></span>
          <span id="ic-status-text">加载中…</span>
        </span>
        <button id="ic-btn-stop" type="button" class="ic-btn danger" style="display:none;">停止</button>
        <button id="ic-btn-refresh" type="button" class="ic-btn icon-only" title="刷新">↻</button>
      </div>
    </div>
    <div class="ic-mid">
      <span id="ic-proj" class="ic-proj" style="display:none;"></span>
      <span id="ic-title" class="ic-title">等待子代理会话…</span>
    </div>
    <div class="ic-foot">
      <div id="ic-foot-left" class="ic-foot-left"></div>
      <div id="ic-tel" class="ic-tel"></div>
    </div>
  </div>
  <div class="header">
    <div class="header-row">
      <div class="brand-wrap">
        <span class="brand">
          ${logoDataUri ? `<img class="brand-icon" src="${logoDataUri}" alt="ALilaS" />` : ""}
          ALilaS
        </span>
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
        <label class="chk-label" title="只展示本插件发起的子代理会话">
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
        <button id="btn-send-neon" type="button" class="btn" style="display:none;" title="将本会话最新回复摘录发回主对话">发回主对话</button>
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
        <button id="btn-model-trigger" type="button" class="model-capsule" title="点击打开设置切换模型与思考强度">
          <span class="cap-dot">✦</span>
          <span id="cap-model-name" class="cap-name">自动模型</span>
          <span id="cap-model-effort" class="cap-effort"></span>
        </button>
      </div>
      <div class="composer-right">
        <label class="chk-label" title="开启全新独立会话">
          <input id="chk-new-session" type="checkbox" />
          新会话
        </label>
        <button id="btn-perm-mode" type="button" class="btn" title="切换自动执行 / 只读审计模式">自动</button>
        <button id="btn-send-task" type="button" class="btn btn-primary">发送</button>
      </div>
    </div>
  </div>

  <!-- Standalone Isolated View Overlay (opens exclusively as Context OR Usage OR Settings) -->
  <div id="overlay-view" class="overlay-view" role="dialog" aria-label="ALilaS 面板">
    <div class="ov-header">
      <span id="ov-title" class="ov-title"></span>
      <button id="btn-close-overlay" type="button" class="btn" title="返回时间线 (Esc)">✕</button>
    </div>
    <div id="ov-body" class="ov-body"></div>
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
