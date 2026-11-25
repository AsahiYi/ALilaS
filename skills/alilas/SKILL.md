---
name: alilas
description: Delegate coding, auditing, or verification subtasks to ALilaS (multi-engine better-subagent for Antigravity supporting agy, DSH, Claude Code, and Codex CLI) with per-run model selection, live ring/TPS/token telemetry, project isolation, and stall recovery.
---

# ALilaS (`better-subagent`) Delegation Guide

Use the `alilas_alilas` MCP server tools whenever heavy implementation, batch scripting, auditing, or verification should be delegated to **ALilaS** while streaming live reasoning and telemetry into Antigravity.

## Workflow

1. **Discover Models (`alilas_list_models`, optional)**:
   - View installed engines (`agy`, `dsh`, `claude`, `codex`), native Antigravity models, and user-defined custom upstream profiles.
2. **Start (`alilas_start_task`)**:
   - Provide `task` (background, target absolute paths, boundaries, acceptance criteria) and `cwd` (current workspace root).
   - Optionally pass `driver`, `model`, `effort`, `profile_id`, and `permission_mode` (`"auto"` or `"readonly"`). Concurrent sessions never conflict.
   - Keep `timeout_sec: 0` (no hard wall-clock kill) and `idle_timeout_sec: 180`.
3. **Focus Side Pane (`alilas_open_pane`)**:
   - Call `alilas_open_pane(session_id, cwd)` so the right-hand ALilaS pane locks onto the active project.
4. **Heartbeat Wait & Self-Heal (`alilas_wait_task` / `alilas_stop_task`)**:
   - Wait in 90-second chunks (`alilas_wait_task(run_id, wait_sec=90)`).
   - On `[STALLED]`, verify and call `alilas_stop_task(run_id)` to kill the process tree before re-dispatching.
   - On upstream refusal/truncation alerts (0 tool calls), start a fresh session with objective technical phrasing.
5. **Verify & Deliver**:
   - Independently check syntax, diffs, and test results before summarizing to the user.
