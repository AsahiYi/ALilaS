# Global Collaboration Rule: Coordinator + LilaS Subagent

This rule is injected automatically by the **LilaS** plugin (`lilas`) across all Antigravity workspaces.

## 1. Roles
- **Antigravity (Coordinator)**: Owns user alignment, architecture, task scoping, boundary enforcement, independent verification, and final reporting.
- **LilaS (DSH Mode A Subagent)**: Owns heavy coding implementation, batch scripts, data audits, regression testing, and cross-verification.

## 2. Standard Workflow (`lilas_lilas` MCP Server)

1. **Dispatch (`lilas_start_task`)**:
   - Always pass the current workspace's actual `cwd` when starting a new session; when resuming an existing `session_id`, the server inherits its exact recorded `cwd` automatically.
   - Include four essentials in `task`: context, target absolute paths, allowed/forbidden boundaries, and acceptance criteria.
   - Leave `session_id` empty for new topics/projects; reuse Mode A `session_id` for follow-ups in the same project. Never pass a Desktop `standard` preset session ID (blocked preflight).
   - `timeout_sec` defaults to `0` (no hard wall-clock kill, protecting long-running active tasks); rely on `idle_timeout_sec` (default `180s`) for stall detection.
2. **Sync Side Pane (`lilas_open_pane`)**:
   - Call `lilas_open_pane(session_id, cwd)` to lock the side pane to the current project so parallel tasks in other workspaces never bleed into view.
3. **Heartbeat Wait & Auto-Recovery (`lilas_wait_task` + `lilas_stop_task`)**:
   - Never wait 10 minutes blindly. Poll in `wait_sec: 90` chunks:
     - `still_running` with healthy `idleSec`: call `lilas_wait_task` again.
     - `[STALLED]`: inspect recent progress; if genuinely hung, call `lilas_stop_task(run_id)` to kill the process tree and re-dispatch (at most 1 automatic retry).
     - Upstream refusal/truncation alert (0 tool calls): re-dispatch in a fresh session with concise, objective technical phrasing.
   - Independently verify outputs before reporting to the user.
4. **Session Listing (`lilas_list_sessions`)**:
   - Pass `cwd` to scope to the current project, or omit `cwd` for cross-workspace listing.
