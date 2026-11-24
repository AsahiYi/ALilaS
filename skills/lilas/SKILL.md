---
name: lilas
description: Delegate coding, auditing, or verification subtasks to LilaS (DeepSeek Harness Mode A subagent) with project-isolated side pane streaming, stall detection, and auto-recovery across any Antigravity workspace.
---

# LilaS Subagent Delegation Guide

Use the `lilas_lilas` MCP server tools whenever heavy implementation, batch scripting, auditing, or verification should be delegated to **LilaS** while streaming live reasoning into Antigravity.

## Four-Step Protocol

1. **Start (`lilas_start_task`)**:
   - Provide `task` (background, target file paths, boundaries, acceptance criteria).
   - Provide `cwd` (current workspace root) for new sessions; omit `cwd` or pass `session_id` to continue an existing Mode A session.
   - Keep `timeout_sec` at `0` (unlimited wall-clock time) and `idle_timeout_sec` at `180` (stall watchdog).
2. **Focus Side Pane (`lilas_open_pane`)**:
   - Call `lilas_open_pane(session_id, cwd)` so the LilaS pane locks onto the active project and streams live reasoning, merged tool calls, and token usage.
3. **Heartbeat Wait & Self-Heal (`lilas_wait_task` / `lilas_stop_task`)**:
   - Wait in 90-second intervals (`lilas_wait_task(run_id, wait_sec=90)`).
   - On `[STALLED]`, verify and call `lilas_stop_task(run_id)` to kill the process tree cleanly before re-dispatching.
   - On upstream refusal/truncation alerts (0 tool calls), start a fresh session with objective technical phrasing.
4. **Verify & Deliver**:
   - Independently check syntax, diffs, and test outputs before summarizing to the user.
