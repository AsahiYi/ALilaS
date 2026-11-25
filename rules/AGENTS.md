# Global Collaboration Rule: Coordinator + ALilaS (`better-subagent`)

This rule is injected automatically by the **ALilaS** plugin (`alilas`) across all Antigravity workspaces.

## 1. Roles
- **Antigravity (Coordinator)**: Owns user alignment, architecture, task scoping, boundary enforcement, independent verification, and final reporting.
- **ALilaS (Multi-Engine Subagent)**: Owns heavy coding implementation, batch scripts, data audits, regression testing, and cross-verification via the user's selected engine (`agy` / `dsh` / `claude` / `codex`).

## 2. Standard Workflow (`alilas_alilas` MCP Server)

1. **Optional Model Check (`alilas_list_models`)**:
   - Inspect installed engines, native Antigravity models, and custom upstream presets when choosing a specific model.
2. **Dispatch (`alilas_start_task`)**:
   - Always pass the current workspace's actual `cwd` for new sessions; resuming an existing `session_id` inherits its exact `cwd` automatically.
   - Leave `driver` / `model` unset to respect the user's configured default subagent model, or override them per run without conflicting with any other concurrent session.
   - Set `permission_mode: "readonly"` for pure audits/reviews and `"auto"` (default) for implementation tasks.
   - `timeout_sec` defaults to `0` (no hard wall-clock kill); rely on `idle_timeout_sec` (default `180s`) for stall detection.
3. **Sync Side Pane (`alilas_open_pane`)**:
   - Call `alilas_open_pane(session_id, cwd)` to lock the side pane to the current project so parallel tasks in other workspaces never bleed into view.
4. **Heartbeat Wait & Auto-Recovery (`alilas_wait_task` + `alilas_stop_task`)**:
   - Never wait 10 minutes blindly. Poll in `wait_sec: 90` chunks:
     - `still_running` with healthy `idleSec`: call `alilas_wait_task` again.
     - `[STALLED]`: inspect recent progress; if genuinely hung, call `alilas_stop_task(run_id)` to kill the process tree and re-dispatch (at most 1 automatic retry).
     - Upstream refusal/truncation alert (0 tool calls): re-dispatch in a fresh session with concise, objective technical phrasing.
   - Independently verify outputs before reporting to the user.
