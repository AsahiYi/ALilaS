---
name: alilas
description: Delegate coding, auditing, or verification subtasks to ALilaS (multi-engine better-subagent for Antigravity supporting agy, DSH, Claude Code, and Codex CLI) with per-run model selection, live ring/TPS/token telemetry, project isolation, and stall recovery.
---

# ALilaS (`better-subagent`) Delegation Guide

Use the `alilas_alilas` MCP server tools whenever heavy implementation, batch scripting, auditing, or verification should be delegated to **ALilaS** while streaming live reasoning and telemetry into Antigravity.

## Workflow

1. **Pre-Flight Grounding**:
   - Do trivial 1–3 step lookups directly instead of delegating.
   - Before dispatching, verify exact file paths, real environment/service names, and OS shell dialect (e.g., PowerShell 5.1 vs bash) so the subagent never wastes turns guessing.
2. **Discover Models (`alilas_list_models`, optional)**:
   - View installed engines (`agy`, `dsh`, `claude`, `codex`), native Antigravity models, and user-defined custom upstream profiles.
3. **Start (`alilas_start_task`)**:
   - Keep `task` tight and concrete (~200–800 chars, single objective): verified absolute paths, exact edits/boundaries, one verification command, and a stop-on-block rule (stop after 3 identical failures and report).
   - Explicitly note headless execution authorization so workspace coordinator rules (e.g., "ask before editing") do not cause hesitation.
   - Optionally pass `driver`, `model`, `effort` (leave default for hard tasks; use `"medium"` only for straightforward mechanical subtasks), `profile_id`, and `permission_mode` (`"auto"` or `"readonly"`). Concurrent sessions never conflict.
   - Keep `timeout_sec: 0` (no hard wall-clock kill) and `idle_timeout_sec: 180`.
4. **Focus Side Pane (`alilas_open_pane`)**:
   - Call `alilas_open_pane(session_id, cwd)` so the right-hand ALilaS pane locks onto the active project.
5. **Heartbeat Wait, Loop Interception & Self-Heal (`alilas_wait_task` / `alilas_stop_task`)**:
   - Wait in 90-second chunks (`alilas_wait_task(run_id, wait_sec=90)`).
   - If the subagent loops on the same failing tool/shell error ≥3 times, stop it (`alilas_stop_task`), fix the missing context, and re-dispatch.
   - On `[STALLED]`, verify and call `alilas_stop_task(run_id)` to kill the process tree before re-dispatching.
   - On upstream refusal/truncation alerts (0 tool calls), start a fresh session with objective technical phrasing.
6. **Verify & Deliver**:
   - Independently check syntax, diffs, and test results before summarizing to the user.
