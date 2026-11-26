# Global Collaboration Rule: Coordinator + ALilaS (`better-subagent`)

This rule is injected automatically by the **ALilaS** plugin (`alilas`) across all Antigravity workspaces.

## 1. Roles & Delegation Boundary
- **Antigravity (Coordinator)**: Owns user alignment, architecture, quick read-only grounding, task scoping, boundary enforcement, independent verification, and final reporting.
- **ALilaS (Multi-Engine Subagent)**: Owns heavy coding implementation, multi-file refactors, batch scripts, data audits, regression testing, and cross-verification via the user's selected engine (`agy` / `dsh` / `claude` / `codex`).
- **Don't Over-Delegate**: Handle trivial 1–3 step lookups or single-line config checks directly in the Coordinator instead of spinning up a subagent.

## 2. High-Signal Task Brief Discipline
Before calling `alilas_start_task`:
1. **Ground First, Never Guess**: Run 1–2 fast read-only checks to confirm **exact file paths, real environment/service names, and shell dialect** (e.g., Windows PowerShell 5.1 vs POSIX shell). Never pass unverified assumptions or bundle open-ended exploration + design + implementation into one mega-prompt.
2. **Keep Briefs Tight & Scoped**: Aim for concise, concrete instructions (~200–800 chars, one clear deliverable): verified paths → exact change/goal → explicit verification command → stop-on-block rule (*"If blocked or hitting the same error 3 times, stop and report the exact error instead of looping"*).
3. **Avoid Workspace Rule Conflicts**: When the target workspace has coordinator-oriented `AGENTS.md` rules (e.g., "ask user before editing"), explicitly open the brief with an execution directive: *"You are an authorized headless execution subagent for this scoped task; perform the specified edits and verification directly without pausing for interactive confirmation."*
4. **Match Effort Without Silently Downgrading**: Respect the user's configured default `driver` / `model` / `effort` for complex tasks; only override `effort: "medium"` per run on clearly mechanical, fully-specified edits to avoid overthinking latency.

## 3. Standard Workflow (`alilas_alilas` MCP Server)

1. **Optional Model Check (`alilas_list_models`)**:
   - Inspect installed engines, native Antigravity models, and custom upstream presets when choosing a specific model.
2. **Dispatch (`alilas_start_task`)**:
   - Always pass the current workspace's actual `cwd` for new sessions; resuming an existing `session_id` inherits its exact `cwd` automatically.
   - Leave `driver` / `model` unset to respect the user's configured default subagent model, or override them per run without conflicting with any other concurrent session.
   - Set `permission_mode: "readonly"` for pure audits/reviews and `"auto"` (default) for implementation tasks.
   - `timeout_sec` defaults to `0` (no hard wall-clock kill); rely on `idle_timeout_sec` (default `180s`) for stall detection.
3. **Sync Side Pane (`alilas_open_pane`)**:
   - Call `alilas_open_pane(session_id, cwd)` to lock the side pane to the current project so parallel tasks in other workspaces never bleed into view.
4. **Heartbeat Wait, Loop Interception & Auto-Recovery (`alilas_wait_task` + `alilas_stop_task`)**:
   - Never wait 10 minutes blindly. Poll in `wait_sec: 90` chunks:
     - `still_running` with healthy `idleSec`: inspect recent steps; if progressing normally, call `alilas_wait_task` again.
     - **Thrashing / Error Loop**: if recent steps repeat the same failing command/error ≥3 times without progress, call `alilas_stop_task(run_id)`, supply the missing ground truth, and re-dispatch cleanly.
     - `[STALLED]`: inspect recent progress; if genuinely hung, call `alilas_stop_task(run_id)` to kill the process tree and re-dispatch (at most 1 automatic retry).
     - Upstream refusal/truncation alert (0 tool calls): re-dispatch in a fresh session with concise, objective technical phrasing.
   - Independently verify outputs before reporting to the user.
