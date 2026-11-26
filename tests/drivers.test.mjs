import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as agy from "../server/drivers/agy.mjs";
import * as claude from "../server/drivers/claude.mjs";
import * as codex from "../server/drivers/codex.mjs";
import * as dsh from "../server/drivers/dsh.mjs";
import { createProfileStore } from "../server/profiles.mjs";
import { createTimelineStore } from "../server/timeline_store.mjs";
import { parseSessionFile } from "../server/dsh_reader.mjs";
import zlib from "node:zlib";

test("agy driver parses real stream-json NDJSON events accurately", () => {
  const events = [];
  const parser = agy.createParser((e) => events.push(e));
  parser.onStdoutLine(
    JSON.stringify({
      event: "init",
      conversation_id: "conv-123",
      init: { model: "gemini-4-neon-high", cwd: "/repo" },
    }),
  );
  parser.onStdoutLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-123",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        thinking_delta: "Plan step 1",
        text_delta: "Done!",
      },
    }),
  );
  parser.onStdoutLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "conv-123",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        duration_seconds: 2.0,
        usage: {
          input_tokens: 10000,
          output_tokens: 200,
          thinking_tokens: 100,
          cache_read_tokens: 8000,
          total_tokens: 18300,
        },
      },
    }),
  );
  parser.onStdoutLine(
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "conv-123",
        status: "SUCCESS",
        response: "Done!",
        duration_seconds: 2.5,
      },
    }),
  );

  assert.equal(events.find((e) => e.type === "session")?.sessionId, "conv-123");
  assert.equal(events.find((e) => e.type === "reasoning_commit")?.text, "Plan step 1");
  assert.equal(events.find((e) => e.type === "text_commit")?.text, "Done!");
  assert.equal(events.find((e) => e.type === "usage")?.usage.totalTokens, 18300);
  assert.equal(events.find((e) => e.type === "final")?.text, "Done!");

  // Ensure agy driver does not emit conflicting --effort when model suffix already encodes effort
  if (agy.resolveCommand()) {
    const inv = agy.buildInvocation({
      task: "ping",
      cwd: os.tmpdir(),
      model: "gemini-3.8-flash-low",
      effort: "high",
      permissionMode: "readonly",
    });
    assert.equal(inv.args.includes("--effort"), false);
    assert.equal(inv.args.includes("plan"), true);
  }
});

test("claude driver parses stream-json with partial deltas, tool_use, tool_result, and usage", () => {
  const events = [];
  const parser = claude.createParser((e) => events.push(e));
  parser.onStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "cl-1", model: "claude-sonnet-4-6" }));
  parser.onStdoutLine(
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Inspecting code" } },
    }),
  );
  parser.onStdoutLine(
    JSON.stringify({
      type: "assistant",
      session_id: "cl-1",
      message: {
        content: [
          { type: "thinking", thinking: "Inspecting code" },
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test" } },
        ],
        usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 400 },
      },
    }),
  );
  parser.onStdoutLine(
    JSON.stringify({
      type: "user",
      session_id: "cl-1",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "All tests passed", is_error: false }],
      },
    }),
  );
  parser.onStdoutLine(JSON.stringify({ type: "result", session_id: "cl-1", result: "All green!", duration_ms: 1500 }));

  assert.equal(events.find((e) => e.type === "session")?.sessionId, "cl-1");
  assert.equal(events.find((e) => e.type === "reasoning_delta")?.text, "Inspecting code");
  assert.equal(events.find((e) => e.type === "tool_start")?.toolName, "Bash");
  assert.equal(events.find((e) => e.type === "tool_end")?.resultText, "All tests passed");
  assert.equal(events.find((e) => e.type === "final")?.text, "All green!");
});

test("codex driver parses exec --json thread, reasoning, command_execution, agent_message, and usage", () => {
  const events = [];
  const parser = codex.createParser((e) => events.push(e));
  parser.onStdoutLine(JSON.stringify({ type: "thread.started", thread_id: "th-99" }));
  parser.onStdoutLine(JSON.stringify({ type: "turn.started" }));
  parser.onStdoutLine(JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "Check git diff" } }));
  parser.onStdoutLine(JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "git status" } }));
  parser.onStdoutLine(
    JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "command_execution", status: "completed", exit_code: 0, aggregated_output: "clean" },
    }),
  );
  parser.onStdoutLine(JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Repo is clean." } }));
  parser.onStdoutLine(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 60 },
    }),
  );

  assert.equal(events.find((e) => e.type === "session")?.sessionId, "th-99");
  assert.equal(events.find((e) => e.type === "reasoning_commit")?.text, "Check git diff");
  assert.equal(events.find((e) => e.type === "tool_start")?.toolName, "shell");
  assert.equal(events.find((e) => e.type === "tool_end")?.resultText, "clean");
  assert.equal(events.find((e) => e.type === "usage")?.usage.cacheReadTokens, 1000);
  assert.equal(events.find((e) => e.type === "usage")?.usage.inputTokens, 200);
  assert.equal(events.find((e) => e.type === "final")?.text, "Repo is clean.");
});

test("dsh driver filters child subagent streams and parses stream_probe stderr lines", () => {
  const events = [];
  const parser = dsh.createParser((e) => events.push(e));
  parser.onStdoutLine(JSON.stringify({ type: "session", sessionId: "session-root" }));
  parser.onStderrLine(
    `__LILAS_STREAM__${JSON.stringify({ type: "reasoning_delta", sessionId: "session-child-other", text: "IGNORED" })}`,
  );
  parser.onStderrLine(
    `__LILAS_STREAM__${JSON.stringify({ type: "reasoning_delta", sessionId: "session-root", text: "ROOT_THOUGHT" })}`,
  );
  // Both stream_probe and status report usage for step 1 — must deduplicate to 1 usage event
  parser.onStdoutLine(JSON.stringify({ type: "status", phase: "step_start", turn: 1, step: 1 }));
  parser.onStderrLine(
    `__LILAS_STREAM__${JSON.stringify({ type: "usage", sessionId: "session-root", turn: 1, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } })}`,
  );
  parser.onStdoutLine(
    JSON.stringify({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }),
  );
  parser.onStdoutLine(JSON.stringify({ type: "final", text: "Finished" }));

  const deltas = events.filter((e) => e.type === "reasoning_delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].text, "ROOT_THOUGHT");
  assert.equal(events.filter((e) => e.type === "usage").length, 1);
  assert.equal(events.find((e) => e.type === "final")?.text, "Finished");
});

test("profileStore & timelineStore persist custom profiles, telemetry, and timelines cleanly", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alilas-test-"));
  try {
    const ps = createProfileStore(tmp);
    const prof = ps.upsertCustomProfile({
      name: "My Relay",
      driver: "dsh",
      provider: "relay",
      baseURL: "https://api.example.com/v1",
      apiKeyEnv: "MY_RELAY_KEY",
      model: "deepseek-v4.1-flash",
      contextWindow: 1_000_000,
    });
    assert.equal(prof.apiKeyEnv, "MY_RELAY_KEY");
    ps.recordUsageDelta({
      driver: "agy",
      model: "gemini-4-neon-high",
      effort: "high",
      inputTokens: 8000,
      cacheReadTokens: 40800,
      outputTokens: 1200,
      totalTokens: 50000,
      tps: 118.4,
      ttftSec: 1.42,
      durationSec: 10.1,
      incrementRun: true,
    });
    ps.updateSettings({ idleTimeoutSec: 240, scanDshDesktop: false });
    const snap = ps.getSnapshot();
    assert.equal(snap.telemetry.allTimeTokens, 50000);
    assert.equal(snap.telemetry.allTimeCacheReadTokens, 40800);
    assert.equal(snap.telemetry.lastTps, 118.4);
    assert.equal(snap.telemetry.lastTtftSec, 1.42);
    assert.equal(snap.telemetry.recentCalls.length, 1);
    assert.equal(Object.keys(snap.telemetry.daily).length, 1);
    assert.equal(snap.settings.idleTimeoutSec, 240);
    assert.equal(snap.settings.scanDshDesktop, false);

    const ts = createTimelineStore(tmp);
    const doc = ts.ensure({ sessionId: "conv-abc", driver: "agy", model: "gemini-4-neon-high", cwd: tmp });
    doc.items.push({ kind: "text", seq: "t.0", turn: 1, step: 1, text: "Hello" });
    ts.save(doc);
    const reloaded = createTimelineStore(tmp).load("conv-abc");
    assert.equal(reloaded.items[0].text, "Hello");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("dsh parseProvidersFromYaml extracts multi-provider models, efforts, and apiKeyEnv cleanly", () => {
  const sampleYaml = `
- id: other-service
  config:
    enabled: true
- id: llm-pi-ai
  config:
    providers:
      relay-a:
        displayName: "Relay Alpha"
        apiKeyEnv: RELAY_A_KEY
        api: openai-responses
        baseURL: https://relay-a.example.com/v1
        models:
          - id: cn:deepseek-v4.1-flash
            name: DeepSeek-V4.1-Flash
            contextWindow: 1000000
            maxTokens: 128000
            reasoningEfforts:
              low: {}
              medium: {}
              high: {}
      claude-b:
        apiKeyEnv: CLAUDE_B_KEY
        api: anthropic-messages
        baseURL: https://claude-b.example.com
        models:
          - id: claude-sonnet-4-6
            name: "Claude Sonnet 4.6"
            contextWindow: 200000
`;
  const providers = dsh.parseProvidersFromYaml(sampleYaml);
  assert.equal(providers.length, 2);
  assert.equal(providers[0].key, "relay-a");
  assert.equal(providers[0].displayName, "Relay Alpha");
  assert.equal(providers[0].apiKeyEnv, "RELAY_A_KEY");
  assert.equal(providers[0].models[0].id, "cn:deepseek-v4.1-flash");
  assert.equal(providers[0].models[0].contextWindow, 1000000);
  assert.deepEqual(providers[0].models[0].efforts, ["low", "medium", "high"]);
  assert.equal(providers[1].key, "claude-b");
  assert.equal(providers[1].api, "anthropic-messages");
  assert.equal(providers[1].models[0].name, "Claude Sonnet 4.6");
});

test("dsh_reader preserves full first prompt line instead of DSH truncated fallback title", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alilas-dsh-title-"));
  try {
    const fp = path.join(tmp, "session.v4.jsonl.zstd");
    const fullFirstLine = "【ExampleApp · 双模块对比样板：精准修图 + 完整场景落地与实机抓图】";
    const lines = [
      JSON.stringify({ type: "session", id: "session-title-test", cwd: tmp, createdAt: Date.now() }),
      JSON.stringify({
        type: "user/message",
        seq: 8,
        time: Date.now(),
        data: { content: [{ type: "text", text: `${fullFirstLine}\n第二行补充说明` }] },
      }),
      JSON.stringify({
        type: "session/title",
        seq: 12,
        time: Date.now(),
        data: { title: "【ExampleApp · 双模块对比", source: { kind: "fallback" } },
      }),
    ].join("\n") + "\n";
    fs.writeFileSync(fp, zlib.zstdCompressSync(Buffer.from(lines, "utf8")));
    const parsed = parseSessionFile(fp, { maxItems: 20 });
    assert.equal(parsed.title, fullFirstLine);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
