// Slack Web API — an optional operator channel beside Telegram. Every visitor maps to
// one THREAD in a configured channel: the first message starts it, everything after is
// a reply in it, and an operator answers by replying in the thread. A bot can't delete
// an operator's Slack messages, so retention of Slack's copies is the workspace's own
// retention setting, not this file's job.
//
// `fetchImpl` is injectable so the flow is testable without hitting Slack.
import type { FetchLike } from "./telegram";

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method} failed: ${code}`);
  }
}

/** The thread's root is gone (Slack's retention deleted it, or someone did by hand). */
const THREAD_GONE = new Set(["thread_not_found", "message_not_found", "invalid_thread_ts"]);
export const isThreadGone = (e: unknown) => e instanceof SlackError && THREAD_GONE.has(e.code);

/** JSON for chat.postMessage; form-encoded for the file methods, which don't take JSON. */
async function call<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown> | URLSearchParams,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const form = body instanceof URLSearchParams;
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": form
        ? "application/x-www-form-urlencoded"
        : "application/json; charset=utf-8",
    },
    body: form ? body.toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000), // don't let a stalled Slack hang the Worker
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new SlackError(method, json.error ?? String(res.status));
  return json;
}

/** Slack reads `&`, `<` and `>` as markup: a visitor typing `<!channel>` must not ping. */
export const escapeSlack = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack's `<@U…>`, `<#C…|name>` and `<!…>` references as words. A bare user id has no
 * name the bot could look up without another scope, so it reads as "@teammate". */
function plainReference(kind: string, id: string, label: string | undefined): string {
  if (kind === "#") return `#${label ?? "channel"}`;
  if (label) return label;
  if (kind === "@") return "@teammate";
  return `@${id}`; // <!here>, <!channel>, <!everyone>
}

/** An operator's Slack text as the visitor should read it: links and mentions as text,
 * entities decoded. */
export function slackToPlain(text: string): string {
  return text
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<([@#!])([^|>]*)(?:\|([^>]*))?>/g, (_, kind: string, id: string, label?: string) =>
      plainReference(kind, id, label),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Start a visitor's thread with a root message; its `ts` is the thread's id. */
export async function slackStartThread(
  token: string,
  channel: string,
  text: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const r = await call<{ ts: string }>(token, "chat.postMessage", { channel, text }, fetchImpl);
  return r.ts;
}

/** Reply in a visitor's thread. Thread replies notify only the thread's followers, so
 * routine mirrors stay quiet; the handoff alert is the loud one. */
export async function slackPost(
  token: string,
  channel: string,
  threadTs: string,
  text: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  await call(token, "chat.postMessage", { channel, thread_ts: threadTs, text }, fetchImpl);
}

export const HANDBACK_ACTION = "handback";

/**
 * The LOUD handoff alert: `<!channel>` so operators are notified, broadcast to the
 * channel so it isn't buried in the thread, and a button that hands the conversation
 * back to the AI (Slack doesn't run slash commands in threads, so there is no `/done`).
 * The button's value is the thread's `ts`, which is how the click finds the session.
 */
export async function slackHandoffAlert(
  token: string,
  channel: string,
  threadTs: string,
  message: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const text = `<!channel> ${message}`;
  await call(
    token,
    "chat.postMessage",
    {
      channel,
      thread_ts: threadTs,
      reply_broadcast: true,
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: HANDBACK_ACTION,
              text: { type: "plain_text", text: "Hand back to AI" },
              value: threadTs,
            },
          ],
        },
      ],
    },
    fetchImpl,
  );
}

/** Upload a visitor's screenshot into their thread: reserve an upload URL, send the
 * bytes, then complete it into the channel and thread. */
export async function slackUploadImage(
  token: string,
  channel: string,
  threadTs: string,
  image: Blob,
  filename: string,
  comment: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { upload_url, file_id } = await call<{ upload_url: string; file_id: string }>(
    token,
    "files.getUploadURLExternal",
    new URLSearchParams({ filename, length: String(image.size) }),
    fetchImpl,
  );
  const sent = await fetchImpl(upload_url, {
    method: "POST",
    body: image,
    signal: AbortSignal.timeout(20_000), // longer than call(): this one carries a file
  });
  if (!sent.ok) throw new SlackError("upload", String(sent.status));
  const done = new URLSearchParams({
    files: JSON.stringify([{ id: file_id, title: filename }]),
    channel_id: channel,
    thread_ts: threadTs,
  });
  if (comment) done.set("initial_comment", comment);
  await call(token, "files.completeUploadExternal", done, fetchImpl);
}

/**
 * Slack's v0 request signature: HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the
 * app's signing secret. Rejects anything more than 5 minutes off, so a captured request
 * can't be replayed. `subtle.verify` compares in constant time.
 */
export async function verifySlackRequest(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
  const hex = signature.startsWith("v0=") ? signature.slice(3) : "";
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const mac = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
}

// ── event parsing (pure) ─────────────────────────────────────────────────────
export interface SlackReply {
  threadTs: string;
  text: string;
  userId?: string;
}

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

/**
 * A person's reply in a thread of our channel, or null: the bot's own posts (`bot_id`),
 * edits, deletions, joins and other subtypes, root messages, other channels, empty text.
 */
export function parseThreadReply(event: unknown, channelId: string): SlackReply | null {
  const e = event as SlackMessageEvent | null;
  if (!e || e.type !== "message") return null;
  // A reply also sent to the channel ("thread_broadcast") is still a reply.
  if ((e.subtype && e.subtype !== "thread_broadcast") || e.bot_id) return null;
  if (e.channel !== channelId) return null;
  if (!e.thread_ts || e.thread_ts === e.ts) return null;
  const text = e.text?.trim();
  if (!text) return null;
  return { threadTs: e.thread_ts, text, userId: e.user };
}

interface SlackActionsPayload {
  type?: string;
  channel?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
}

/** The thread `ts` of a "Hand back to AI" click in our channel, or null. */
export function parseHandback(payload: unknown, channelId: string): string | null {
  const p = payload as SlackActionsPayload | null;
  if (p?.type !== "block_actions" || p.channel?.id !== channelId) return null;
  return p.actions?.find((a) => a.action_id === HANDBACK_ACTION)?.value || null;
}
