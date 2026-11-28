import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as agy from "../server/drivers/agy.mjs";
import * as claude from "../server/drivers/claude.mjs";
import * as codex from "../server/drivers/codex.mjs";
import * as direct from "../server/drivers/direct.mjs";
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

test("dsh parseProvidersFromYaml preserves input capabilities & custom reasoningEfforts map", () => {
  const sampleYaml = `
- id: llm-pi-ai
  config:
    providers:
      custom-up:
        displayName: "Custom Upstream"
        apiKeyEnv: CUSTOM_UP_KEY
        api: openai-responses
        baseURL: https://up.example.com/v1
        models:
          - id: text-only-model
            name: TextOnly
            contextWindow: 128000
            maxTokens: 16384
            input:
              - text
            reasoningEfforts:
              off: null
              low: minimal
              medium: medium
              high: xhigh
          - id: vision-model
            name: VisionOne
            contextWindow: 1000000
            input: [text, image]
            reasoningEfforts:
              low: low
              high: high
`;
  const providers = dsh.parseProvidersFromYaml(sampleYaml);
  assert.equal(providers.length, 1);
  const [m1, m2] = providers[0].models;
  assert.deepEqual(m1.inputs, ["text"]);
  assert.deepEqual(m1.effortMap, { off: null, low: "minimal", medium: "medium", high: "xhigh" });
  assert.deepEqual(m1.efforts, ["low", "medium", "high"]);
  assert.deepEqual(m2.inputs, ["text", "image"]);
  assert.equal(m2.contextWindow, 1000000);
});

test("dsh buildInvocation generates readonly sandbox-policy patch and env in readonly mode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alilas-dsh-ro-"));
  const prevBin = process.env.ALILAS_DSH_BIN;
  try {
    process.env.ALILAS_DSH_BIN = path.join(tmp, "fake-dsh.mjs");
    const inv = dsh.buildInvocation({
      runId: "run-ro-1",
      task: "Audit only",
      cwd: tmp,
      permissionMode: "readonly",
      dataDir: tmp,
      pluginRoot: tmp,
    });
    assert.equal(inv.env.DSH_PERMISSION_MODE, "read-only");
    assert.equal(inv.cleanupPaths.length, 1);
    const patchText = fs.readFileSync(inv.cleanupPaths[0], "utf8");
    assert.match(patchText, /id:\s*sandbox-policy/);
    assert.match(patchText, /mode:\s*"read-only"/);
    assert.match(patchText, /id:\s*approval/);
    assert.match(patchText, /policy:\s*"never"/);
  } finally {
    if (prevBin === undefined) delete process.env.ALILAS_DSH_BIN;
    else process.env.ALILAS_DSH_BIN = prevBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("codex buildInvocation uses -c sandbox_mode=read-only for both fresh and resume readonly runs", () => {
  if (!codex.resolveCommand()) return;
  const fresh = codex.buildInvocation({
    task: "Inspect",
    cwd: os.tmpdir(),
    permissionMode: "readonly",
  });
  assert.ok(fresh.args.includes("sandbox_mode=read-only"));
  const resumed = codex.buildInvocation({
    task: "Continue",
    sessionId: "th-abc",
    cwd: os.tmpdir(),
    permissionMode: "readonly",
  });
  assert.ok(resumed.args.includes("resume"));
  assert.ok(resumed.args.includes("sandbox_mode=read-only"));
});

test("dsh_reader extracts request/context model & window, classifies system-reminder, and detects interrupted runs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alilas-dsh-sys-"));
  try {
    const fp = path.join(tmp, "session.v4.jsonl.zstd");
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: "session", id: "session-sys-1", cwd: tmp, createdAt: now }),
      JSON.stringify({
        type: "request/context",
        seq: 2,
        time: now + 10,
        data: { provider: "myprov", model: "my-128k-model", contextWindow: 128000 },
      }),
      JSON.stringify({
        type: "request/header",
        seq: 3,
        time: now + 15,
        data: { header: { config: { provider: "myprov", model: "my-128k-model", reasoningEffort: "medium" } } },
      }),
      JSON.stringify({
        type: "user/message",
        seq: 4,
        time: now + 20,
        data: { content: [{ type: "text", text: "<system-reminder>\nAvailable skills list...\n</system-reminder>" }] },
      }),
      JSON.stringify({
        type: "user/message",
        seq: 5,
        time: now + 30,
        data: { content: [{ type: "text", text: "Real user task title here" }] },
      }),
      JSON.stringify({ type: "step/start", seq: 6, time: now + 40, data: { step: 1 } }),
    ].join("\n") + "\n";

    fs.writeFileSync(fp, zlib.zstdCompressSync(Buffer.from(lines, "utf8")));
    const parsed = parseSessionFile(fp, { maxItems: 50 });
    assert.equal(parsed.model, "myprov/my-128k-model");
    assert.equal(parsed.effort, "medium");
    assert.equal(parsed.contextWindow, 128000);
    assert.equal(parsed.title, "Real user task title here");
    assert.equal(parsed.interrupted, true);
    const sysItem = parsed.items.find((it) => it.kind === "system");
    assert.ok(sysItem, "expected system-reminder item to be preserved as kind='system'");
    assert.match(sysItem.label, /DSH 系统注入/);

    // Now append turn/end as a new zstd frame (matching real DSH incremental frame appends)
    const endFrame = JSON.stringify({ type: "turn/end", seq: 7, time: now + 50, data: {} }) + "\n";
    fs.appendFileSync(fp, zlib.zstdCompressSync(Buffer.from(endFrame, "utf8")));
    const parsedDone = parseSessionFile(fp, { maxItems: 50 });
    assert.equal(parsedDone.interrupted, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("direct engine executes zero-injection SSE tool loop, respects readonly & vision gating, and persists history", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alilas-direct-e2e-"));
  const sampleFile = path.join(tmp, "hello.txt");
  fs.writeFileSync(sampleFile, "DIRECT_OK_42\n", "utf8");

  const capturedRequests = [];
  let reqCount = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      capturedRequests.push(body);
      reqCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      if (reqCount === 1) {
        // Step 1: stream reasoning + request read_file tool call
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: "Let me read hello.txt." } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read_1",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // Step 2: confirm tool result reached history and reply with final text
        const toolMsg = body.messages.find((m) => m.role === "tool");
        const reply = toolMsg?.content?.includes("DIRECT_OK_42")
          ? "Verified: DIRECT_OK_42"
          : "Missing tool output";
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: reply } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 210, completion_tokens: 12, total_tokens: 222 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const profile = {
      id: "prof-direct-test",
      name: "Mock Direct",
      driver: "direct",
      api: "openai-completions",
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKeyEnv: "",
      model: "mock-model-1",
      contextWindow: 128000,
      maxTokens: 4096,
      inputs: ["text"],
      effort: "medium",
    };

    const inv = direct.buildInvocation({
      task: "Read hello.txt and report its content.",
      cwd: tmp,
      model: profile.model,
      effort: "medium",
      permissionMode: "readonly",
      profile,
      dataDir: tmp,
    });

    const events = [];
    const parser = direct.createParser((e) => events.push(e));
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(inv.cmd, inv.args, {
        cwd: inv.cwd,
        env: inv.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.write(inv.stdinText, "utf8");
      child.stdin.end();
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) parser.onStdoutLine(line);
        }
      });
      child.on("error", reject);
      child.on("close", resolve);
    });

    assert.equal(exitCode, 0);
    assert.equal(capturedRequests.length, 2);

    // Readonly + text-only gating check
    const toolNames = capturedRequests[0].tools.map((t) => t.function.name);
    assert.ok(toolNames.includes("read_file"));
    assert.equal(toolNames.includes("write_file"), false, "readonly must hide write_file");
    assert.equal(toolNames.includes("edit_file"), false, "readonly must hide edit_file");
    assert.equal(toolNames.includes("read_image"), false, "text-only profile must hide read_image");

    assert.equal(events.find((e) => e.type === "reasoning_commit")?.text, "Let me read hello.txt.");
    assert.equal(events.find((e) => e.type === "tool_start")?.toolName, "read_file");
    assert.match(events.find((e) => e.type === "tool_end")?.resultText || "", /DIRECT_OK_42/);
    assert.equal(events.find((e) => e.type === "final")?.text, "Verified: DIRECT_OK_42");

    const sid = events.find((e) => e.type === "session")?.sessionId;
    assert.ok(sid?.startsWith("direct-"));
    const histPath = path.join(tmp, "direct_sessions", `${sid}.json`);
    assert.ok(fs.existsSync(histPath), "direct session history must be persisted");

    // Verify step 2 preserved same-turn reasoning_content for DeepSeek/Kimi compatibility
    const step2Asst = capturedRequests[1].messages.find((m) => m.role === "assistant");
    assert.equal(step2Asst?.reasoning_content, "Let me read hello.txt.");
    // Persisted cross-turn history must strip ephemeral reasoning artifacts
    const persisted = JSON.parse(fs.readFileSync(histPath, "utf8"));
    assert.equal(persisted.messages.some((m) => m.reasoning !== undefined), false);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("direct engine respects reasoningEnabled=false, custom effortMap, Anthropic thinking+signature round-trip & UTF-8 run_command", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alilas-direct-anth-"));
  const anthRequests = [];
  let anthTurn = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url.endsWith("/chat/completions")) {
        // Non-reasoning check: must NOT include reasoning_effort
        assert.equal(Object.prototype.hasOwnProperty.call(body, "reasoning_effort"), false);
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "PLAIN_OK" } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (req.url.endsWith("/messages")) {
        anthRequests.push(body);
        anthTurn++;
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        if (anthTurn === 1) {
          assert.equal(body.thinking?.type, "enabled");
          assert.equal(body.thinking?.budget_tokens, 16384);
          const cmd =
            process.platform === "win32"
              ? "Write-Output '中文输出OK'; [Console]::Error.WriteLine('WARN_STDERR')"
              : "printf '中文输出OK\\n'; printf 'WARN_STDERR\\n' >&2";
          const evs = [
            { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step1 thinking" } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc-123" } },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_cmd_1", name: "run_command" } },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: cmd }) },
            },
            { type: "message_delta", usage: { output_tokens: 30 } },
          ];
          for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          res.end();
        } else {
          const asstMsg = body.messages.find((m) => m.role === "assistant");
          const thinkBlk = asstMsg?.content?.find((b) => b.type === "thinking");
          assert.equal(thinkBlk?.thinking, "Step1 thinking");
          assert.equal(thinkBlk?.signature, "sig-abc-123");
          const trMsg = body.messages[body.messages.length - 1];
          const trText = trMsg?.content?.[0]?.content?.[0]?.text || "";
          assert.match(trText, /中文输出OK/);
          assert.match(trText, /WARN_STDERR/);
          const evs = [
            { type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 0 } } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ANTH_ROUNDTRIP_OK" } },
            { type: "message_delta", usage: { output_tokens: 12 } },
          ];
          for (const e of evs) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          res.end();
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const runDirectWorker = (inv) =>
    new Promise((resolve, reject) => {
      const events = [];
      const parser = direct.createParser((e) => events.push(e));
      const child = spawn(inv.cmd, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.write(inv.stdinText, "utf8");
      child.stdin.end();
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) parser.onStdoutLine(line);
        }
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, events }));
    });

  try {
    // 1) Non-reasoning profile must omit reasoning_effort completely
    const plainInv = direct.buildInvocation({
      task: "Say hi",
      cwd: tmp,
      model: "plain-model",
      effort: "high",
      profile: {
        id: "p-plain",
        driver: "direct",
        api: "openai-completions",
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: "plain-model",
        reasoningEnabled: false,
        effortMap: {},
      },
      dataDir: tmp,
    });
    const rPlain = await runDirectWorker(plainInv);
    assert.equal(rPlain.code, 0);
    assert.equal(rPlain.events.find((e) => e.type === "final")?.text, "PLAIN_OK");

    // 2) Anthropic custom effortMap ("xhigh" -> "16384") + thinking signature round-trip + UTF-8 run_command
    const anthInv = direct.buildInvocation({
      task: "Run command",
      cwd: tmp,
      model: "claude-sonnet-4-6",
      effort: "xhigh",
      profile: {
        id: "p-anth",
        driver: "direct",
        api: "anthropic-messages",
        baseURL: `http://127.0.0.1:${port}`,
        model: "claude-sonnet-4-6",
        maxTokens: 32000,
        reasoningEnabled: true,
        effortMap: { off: "", high: "12288", xhigh: "16384" },
      },
      dataDir: tmp,
    });
    const rAnth = await runDirectWorker(anthInv);
    assert.equal(rAnth.code, 0);
    assert.equal(anthRequests.length, 2);
    assert.equal(rAnth.events.find((e) => e.type === "final")?.text, "ANTH_ROUNDTRIP_OK");
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("discoverDirectModels & probeDirectTools parse upstream metadata and verify 2-turn tool calling", async () => {
  let probeFailMode = false;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: "gpt-6-astra",
              context_length: 256000,
              supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
            },
            { id: "gpt-4o-mini", context_window: 128000 },
          ],
        }),
      );
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      const toolMsg = body.messages?.find((m) => m.role === "tool");
      if (!toolMsg) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: "Calling probe tool",
                  tool_calls: [{ id: "tc_probe", type: "function", function: { name: "read_sample", arguments: "{}" } }],
                },
              },
            ],
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: probeFailMode ? "ignored-output" : `Echo: ${toolMsg.content}`,
                },
              },
            ],
          }),
        );
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseURL = `http://127.0.0.1:${port}/v1`;

  try {
    const disc = await direct.discoverDirectModels({ baseURL, api: "openai-completions" });
    assert.equal(disc.ok, true);
    assert.equal(disc.count, 2);
    const astra = disc.models.find((m) => m.id === "gpt-6-astra");
    const plain = disc.models.find((m) => m.id === "gpt-4o-mini");
    assert.equal(astra.contextWindow, 256000);
    assert.deepEqual(astra.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(plain.reasoningEnabled, false);
    assert.deepEqual(plain.efforts, []);

    const okRes = await direct.probeDirectTools({ baseURL, model: "gpt-6-astra", api: "openai-completions" });
    assert.equal(okRes.ok, true);

    probeFailMode = true;
    const failRes = await direct.probeDirectTools({ baseURL, model: "gpt-6-astra", api: "openai-completions" });
    assert.equal(failRes.ok, false);
  } finally {
    server.close();
  }
});

test("dsh driver preserves non-reasoning models without fabricating reasoningEfforts and accepts custom effort keys", () => {
  const yaml = `
- id: llm-pi-ai
  config:
    providers:
      up1:
        api: openai-responses
        baseURL: https://up1.example.com/v1
        models:
          - id: non-think-model
            name: PlainModel
            contextWindow: 128000
            input: [text]
          - id: flex-think-model
            name: FlexThink
            contextWindow: 256000
            reasoningEfforts:
              none: none
              minimal: minimal
              xhigh: xhigh
`;
  const provs = dsh.parseProvidersFromYaml(yaml);
  const [plain, flex] = provs[0].models;
  assert.equal(plain.hasReasoning, false);
  assert.deepEqual(plain.efforts, []);
  assert.equal(plain.effortMap, null);
  assert.equal(flex.hasReasoning, true);
  assert.deepEqual(flex.efforts, ["none", "minimal", "xhigh"]);
  assert.deepEqual(flex.effortMap, { none: "none", minimal: "minimal", xhigh: "xhigh" });
});
