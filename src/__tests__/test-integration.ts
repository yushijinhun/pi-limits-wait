import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import limitsWaitExtension, { disableModelRuntimeInterception } from "../index.js";

// Unlike the runtime-level suite, drive a real session and its extension runner:
// settings -> fallback -> same-model retry -> turn_end metadata -> next turn,
// then thinking levels across model selection and fallback.
const root = mkdtempSync(join(tmpdir(), "limits-wait-integration-"));
const savedEnv = { ...process.env };
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PI_LIMITS_WAIT_")) delete process.env[key];
  }
  const agentDir = join(root, "agent");
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_LIMITS_WAIT_RETRY_INTERVAL = "0";
  process.env.PI_LIMITS_WAIT_MAX_RETRY = "1";
  process.env.PI_LIMITS_WAIT_PROBE_INTERVAL = "0";
  mkdirSync(agentDir, { recursive: true });
  const writeSettings = (fallbackReasoning?: ModelThinkingLevel) => writeFileSync(join(agentDir, "limits-wait.json"), JSON.stringify({
    "fallback-models": [
      { provider: "fallback", modelname: "fixture", "reasoning effort": fallbackReasoning },
      { provider: "primary", modelname: "fixture" },
    ],
  }));
  writeSettings();

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
  });
  // Calls are traced as provider[:reasoning]; each fails with its provider's next queued error.
  const calls: string[] = [];
  const contexts: string[] = [];
  const failures = { primary: [] as string[], fallback: [] as string[] };
  for (const provider of ["primary", "fallback"] as const) {
    runtime.registerProvider(provider, {
      api: "openai-completions", baseUrl: "https://fixture.invalid", apiKey: "dummy-key",
      models: [{
        id: "fixture", name: provider, reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000, maxTokens: 256,
      }],
      streamSimple(model, context, options) {
        calls.push(options?.reasoning ? `${provider}:${options.reasoning}` : provider);
        contexts.push(JSON.stringify(context));
        const failure = failures[provider].shift();
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: failure ? [] : [{ type: "text", text: "integration recovered" }],
          stopReason: failure ? "error" : "stop", timestamp: Date.now(),
          ...(failure ? { errorMessage: failure } : {}),
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          if (failure) stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
  }
  const primary = runtime.getModel("primary", "fixture");
  assert.ok(primary);
  const settingsManager = SettingsManager.inMemory({
    // Pi switches to this level on every model change. No step below selects it,
    // so it appears in a trace only when a stale or reset level is sent.
    defaultThinkingLevel: "medium", retry: { enabled: false }, compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [limitsWaitExtension],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(root);
  ({ session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime: runtime, model: primary, thinkingLevel: "off",
    resourceLoader, settingsManager, sessionManager, tools: [],
  }));
  await session.bindExtensions({});
  await session.prompt("Healthy startup turn");
  assert.deepEqual(calls, ["primary"], "a healthy startup model wins even when listed after the fallback");
  assert.equal(session.model?.provider, "primary");
  calls.length = 0;
  failures.primary.push("HTTP 429 retry-after 60");
  failures.fallback.push("integration transient unknown failure");
  await session.prompt("First integration turn");
  assert.deepEqual(calls, ["primary", "fallback", "fallback"]);
  assert.equal(session.model?.provider, "fallback", "successful fallback becomes the session model");
  assert.equal(session.getLastAssistantText(), "integration recovered");
  const summaries = () => sessionManager.getEntries().filter(
    (entry) => entry.type === "custom" && entry.customType === "limits-wait",
  );
  const summary = summaries()[0];
  assert.ok(summary?.type === "custom");
  assert.deepEqual(summary.data, {
    totalWaitingTime: 0,
    reasons: ["HTTP 429 retry-after 60", "integration transient unknown failure"],
    retries_total: 2,
  }, "turn_end records both immediate fallback and zero-wait retry exactly once");

  await session.prompt("Second integration turn");
  assert.deepEqual(calls, ["primary", "fallback", "fallback", "fallback"],
    "next turn stays on fallback while the explicit primary deadline is active");
  assert.equal(summaries().length, 1, "healthy turns do not duplicate retry metadata");
  const nextContext = contexts.at(-1);
  assert.ok(nextContext);
  assert.ok(nextContext.includes("integration recovered"), "successful response enters next-turn context");
  assert.ok(!nextContext.includes("integration transient unknown failure"));
  assert.ok(!nextContext.includes("retries_total"), "retry summaries stay outside model context");
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 3,
    "failed attempts never become extra assistant turns");

  await session.setModel(primary);
  assert.equal(session.thinkingLevel, "medium", "Pi applies its default thinking level on model selection");
  session.setThinkingLevel("off");
  calls.length = 0;
  await session.prompt("Thinking off");
  assert.deepEqual(calls, ["primary"], "a thinking change after model selection applies to the next request");

  for (const configured of [undefined, "high", "off"] as const) {
    writeSettings(configured);
    // A manual selection also clears the limit remembered for primary.
    await session.setModel(primary);
    session.setThinkingLevel("low");
    failures.primary.push("HTTP 429 retry-after 60");
    calls.length = 0;
    await session.prompt("Thinking during fallback");
    const level = configured ?? "low";
    assert.deepEqual(calls, ["primary:low", level === "off" ? "fallback" : `fallback:${level}`],
      "a fallback uses the request's thinking level unless its entry configures one");
    assert.equal(session.model?.provider, "fallback");
    assert.equal(session.thinkingLevel, level, "Pi keeps the fallback request's thinking level after switching");
  }
  console.log("✅ SDK session fallback, retry, summary lifecycle, next-turn context and thinking levels");
} finally {
  session?.dispose();
  disableModelRuntimeInterception();
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
}
