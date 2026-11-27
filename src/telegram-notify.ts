import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { isQuotaExhaustedError } from "./retry-errors.js";
import { state } from "./state.js";

/**
 * Telegram notifications for the two failures that stop work for reasons money
 * or a clock can explain: a provider rate limit, and a quota that is spent.
 *
 * The bot token is the one the telegram-notification extension already uses, so
 * there is one place to configure it. Everything here is best effort: a
 * notification must never delay a retry, fail a request, or throw into the
 * stream. Turn it off with PI_LIMITS_WAIT_TELEGRAM=0 or "limitsWaitTelegram":
 * false in the same file.
 */

const CONFIG_FILE = "telegram-notification.json";
const TIMEOUT_MS = 8_000;

export type LimitsEvent = {
  /** "waiting" is a planned retry; "gave-up" is the terminal failure. */
  kind: "waiting" | "gave-up";
  /** The retry period this event belongs to. One message per period, on its first wait. */
  period?: string;
  reason: string;
  /** What the provider said. */
  detail?: string;
  waitMs?: number;
  model?: string;
  attempt?: number | null;
  maxAttempts?: number | null;
};

/**
 * One message per retry period, not per retry. The extension retries for as long
 * as the provider keeps refusing, so a message for every attempt would flood the
 * phone: the first wait of a period reports it, the rest of that period is
 * silent, and the next period reports again.
 */
let toldPeriod: string | undefined;
let toldSomething = false;

/** Called when a request completes: whatever was being reported is over. */
export function resetLimitsNotifications(): void {
  toldPeriod = undefined;
  toldSomething = false;
}

/** Whether this period has already been reported. */
export function limitsNotificationsTold(): boolean {
  return toldSomething;
}

function agentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), ".pi", "agent");
  if (dir === "~") return homedir();
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

function disabled(): boolean {
  const value = (process.env.PI_LIMITS_WAIT_TELEGRAM ?? "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

type Chat = { botToken: string; chatId: string };

async function readChat(): Promise<Chat | undefined> {
  try {
    const raw = await readFile(join(agentDir(), CONFIG_FILE), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config.limitsWaitTelegram === false) return undefined;
    const botToken = typeof config.botToken === "string" ? config.botToken.trim() : "";
    const chatId = config.chatId === undefined ? "" : String(config.chatId).trim();
    return botToken && chatId ? { botToken, chatId } : undefined;
  } catch {
    return undefined;
  }
}

/** "hienaa-a2b", or the directory name for a session without a name. */
function sessionLabel(): string {
  const ctx = state.sharedCtx;
  if (!ctx) return hostname();
  try {
    const name = ctx.sessionManager.getSessionName();
    if (name) return name;
    return basename(ctx.cwd) || ctx.cwd;
  } catch {
    return hostname();
  }
}

function minutes(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  if (total < 60) return `${total}s`;
  const value = Math.round(total / 60);
  if (value < 60) return `${value}m`;
  return `${Math.floor(value / 60)}h${String(value % 60).padStart(2, "0")}m`;
}

function clock(deadline: number): string {
  return new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The provider's wording, cut to something a phone notification can show. */
function detailText(detail: string | undefined): string {
  const flat = (detail ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= 300 ? flat : `${flat.slice(0, 299)}…`;
}

export function composeLimitsMessage(event: LimitsEvent): string | undefined {
  const detail = detailText(event.detail);
  const quota = isQuotaExhaustedError(`${event.reason} ${detail}`);
  const model = event.model ? ` · ${event.model}` : "";
  const attempt = event.attempt && event.maxAttempts ? ` · attempt ${event.attempt}/${event.maxAttempts}` : "";
  const head = `${sessionLabel()}${model}${attempt}`;

  if (quota) {
    // Waiting does not refill a balance, so say so instead of promising a retry.
    return [
      `🚫 Out of credits on ${head}`,
      detail,
      "Waiting will not help: the account needs credit or a higher plan.",
    ].filter(Boolean).join("\n");
  }
  if (event.reason !== "rate-limit") return undefined;
  if (event.kind === "gave-up") {
    return [`⛔ Rate limit, no more retries on ${head}`, detail].filter(Boolean).join("\n");
  }
  const waitMs = event.waitMs ?? 0;
  if (waitMs <= 0) return undefined;
  const until = clock(Date.now() + waitMs);
  return [`⏳ Rate limit on ${head}`, `Retrying in ${minutes(waitMs)}, at ${until}.`, detail].filter(Boolean).join("\n");
}

/** Send the one notification of this retry period, if it has not been sent yet. */
export async function notifyLimits(event: LimitsEvent): Promise<void> {
  if (disabled()) return;
  const period = event.period ?? "unknown";
  if (toldSomething && toldPeriod === period) return;
  const text = composeLimitsMessage(event);
  if (!text) return;

  const chat = await readChat();
  if (!chat) return;
  toldPeriod = period;
  toldSomething = true;
  try {
    await fetch(`https://api.telegram.org/bot${chat.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat.chatId,
        text,
        disable_notification: false,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The phone is not the work: a failed notification is not a failed request.
  }
}

/** Fire and forget, for callers on the retry path. */
export function notifyLimitsInBackground(event: LimitsEvent): void {
  void notifyLimits(event).catch(() => {});
}
