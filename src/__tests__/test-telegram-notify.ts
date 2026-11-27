import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isQuotaExhaustedError, isRateLimitError } from "../retry-errors.js";
import { composeLimitsMessage, limitsNotificationsTold, notifyLimits, resetLimitsNotifications } from "../telegram-notify.js";

let failures = 0;
function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`ok - ${name}`);
    return;
  }
  failures += 1;
  console.error(`not ok - ${name}${detail ? ` (${detail})` : ""}`);
}

const rateLimit = composeLimitsMessage({
  kind: "waiting",
  reason: "rate-limit",
  waitMs: 12 * 60_000,
  detail: "429 rate_limit_error retry-after 720",
  model: "anthropic/claude-fable-5-2",
  attempt: 2,
  maxAttempts: 5,
}) ?? "";

ok("a rate-limit wait says when the retry comes", rateLimit.includes("⏳ Rate limit on"));
ok("it names the model", rateLimit.includes("anthropic/claude-fable-5-2"));
ok("it names the attempt", rateLimit.includes("attempt 2/5"));
ok("it shows the wait in minutes", rateLimit.includes("Retrying in 12m"));
ok("it keeps the provider wording", rateLimit.includes("retry-after 720"));

const spentQuota = composeLimitsMessage({
  kind: "waiting",
  reason: "rate-limit",
  waitMs: 60_000,
  detail: "Your credit balance is too low to access the Anthropic API",
  model: "anthropic/claude-fable-5-2",
}) ?? "";

ok("a spent quota is not reported as a rate limit", spentQuota.includes("🚫 Out of credits"));
ok("and it says waiting will not help", spentQuota.includes("Waiting will not help"));

const outOfBalance = composeLimitsMessage({
  kind: "gave-up",
  reason: "error",
  detail: "402 Payment Required: insufficient_quota",
}) ?? "";
ok("a quota error that is not classified as a rate limit still notifies", outOfBalance.includes("Out of credits"));

const gaveUp = composeLimitsMessage({
  kind: "gave-up",
  reason: "rate-limit",
  detail: "429 too many requests",
  model: "anthropic/claude-fable-5-2",
}) ?? "";
ok("giving up on a rate limit is reported once as the terminal failure", gaveUp.includes("⛔ Rate limit, no more retries"));
ok("the terminal failure carries the error text", gaveUp.includes("429 too many requests"));

ok(
  "network and overload waits do not reach the phone",
  composeLimitsMessage({ kind: "waiting", reason: "network", waitMs: 5_000 }) === undefined
    && composeLimitsMessage({ kind: "waiting", reason: "overloaded", waitMs: 5_000 }) === undefined,
);

ok("a wait that is not going to happen sends nothing", composeLimitsMessage({ kind: "waiting", reason: "rate-limit", waitMs: 0 }) === undefined);

ok("a long provider message is cut", (composeLimitsMessage({
  kind: "waiting",
  reason: "rate-limit",
  waitMs: 1_000,
  detail: "x".repeat(900),
}) ?? "").length < 400);

ok("quota wording is recognised", [
  "Insufficient Balance",
  "insufficient_quota",
  "You exceeded your current quota, please check your plan and billing details",
  "credit balance is too low",
  "HTTP 402 Payment Required",
].every(isQuotaExhaustedError));

ok("a plain rate limit is not called a quota problem", !isQuotaExhaustedError("HTTP 429 rate_limit_error"));
ok("both matchers leave unrelated errors alone", !isRateLimitError("500 internal server error"));

// With no telegram-notification.json there is no chat: this must resolve quietly.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = "/nonexistent-agent-dir";
resetLimitsNotifications();
await notifyLimits({ kind: "waiting", reason: "rate-limit", waitMs: 1_000, period: "p1" });
ok("a missing token file is silent, not fatal", !limitsNotificationsTold());

// One message per retry period: the extension retries for as long as the
// provider refuses, and every attempt must not become a phone notification.
const agentDir = await mkdtemp(join(tmpdir(), "limits-wait-"));
await writeFile(join(agentDir, "telegram-notification.json"), JSON.stringify({ botToken: "1:abc", chatId: "1" }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const sentTexts: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  sentTexts.push(String(init?.body ?? ""));
  return new Response("{}", { status: 200 });
}) as typeof globalThis.fetch;

const wait = (period: string, waitMs = 60_000) => ({ kind: "waiting" as const, reason: "rate-limit", waitMs, period });

resetLimitsNotifications();
await notifyLimits(wait("period-a"));
ok("the first wait of a retry period is reported", sentTexts.length === 1);
await notifyLimits(wait("period-a"));
await notifyLimits(wait("period-a"));
ok("later waits of the same period stay quiet", sentTexts.length === 1);

await notifyLimits(wait("period-b"));
ok("a new retry period is reported again", sentTexts.length === 2);

resetLimitsNotifications();
await notifyLimits(wait("period-c"));
ok("after a request completes, the next period reports again", sentTexts.length === 3);

resetLimitsNotifications();
await notifyLimits({ kind: "waiting", reason: "network", waitMs: 3_000, period: "period-d" });
ok("a network wait does not use up the period's message", !limitsNotificationsTold());
await notifyLimits(wait("period-d"));
ok("the rate limit in that same period still gets reported", sentTexts.length === 4);

globalThis.fetch = realFetch;
if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall telegram-notify checks passed");
