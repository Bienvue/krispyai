import { afterEach, describe, expect, test } from "bun:test";
import { SessionDO } from "../src/session-do";
import {
  DO_INTERNAL_HEADER,
  doInternalSecret,
  kConversationSession,
  kHandoffSession,
  kSessionToThread,
  kThreadToSession,
} from "../src/store";
import type { Env } from "../src/types";

const DAY = 24 * 60 * 60_000;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A conversation object over Map-backed storage and KV, with Telegram recorded. */
function setup(extra: Partial<Env> = {}) {
  const kv = new Map<string, string>();
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => void store.set(k, v),
    deleteAll: async () => {
      store.clear();
    },
    list: async ({ prefix }: { prefix?: string } = {}) =>
      new Map([...store].filter(([key]) => !prefix || key.startsWith(prefix))),
    setAlarm: async (t: number | Date) => void (alarm = typeof t === "number" ? t : t.getTime()),
    deleteAlarm: async () => void (alarm = null),
    getAlarm: async () => alarm,
  };
  const state = {
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    storage: {
      ...storage,
      transaction: async (run: (tx: typeof storage) => unknown) => run(storage),
    },
  } as unknown as DurableObjectState;
  const env = {
    KRISPY_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
    ...extra,
  } as unknown as Env;
  const telegram: { method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    telegram.push({ method: String(url).split("/").pop()!, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
  const session = new SessionDO(state, env);
  const headers = { [DO_INTERNAL_HEADER]: doInternalSecret(env) };
  const post = (path: string, body: unknown) =>
    session.fetch(
      new Request(`https://do${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  const get = (path: string) => session.fetch(new Request(`https://do${path}`, { headers }));
  return {
    session,
    post,
    get,
    kv,
    store,
    telegram,
    alarm: () => alarm,
    clearAlarm: storage.deleteAlarm,
  };
}

/** A self-host conversation with a Telegram topic, its last message at `lastTs`. */
async function conversation(s: ReturnType<typeof setup>, lastTs: number) {
  await s.post("/context", { tenantId: "self", sessionId: "s1" });
  s.kv.set(kSessionToThread("self", "s1"), "42");
  s.kv.set(kThreadToSession("self", 42), "s1");
  s.kv.set(kHandoffSession("self", "s1"), "1");
  s.kv.set(kConversationSession("self", "s1"), "1");
  await s.post("/log", {
    messages: [{ role: "visitor", text: "I was charged twice", ts: lastTs }],
  });
}

describe("conversation retention", () => {
  test("off by default: nothing is scheduled or deleted", async () => {
    const s = setup();
    await conversation(s, Date.now() - 400 * DAY);
    await s.session.alarm();
    expect(s.store.get("log")).toBeDefined();
    expect(s.kv.size).toBe(4);
    expect(s.telegram).toEqual([]);
  });

  test("each message moves the deletion to its retention after it", async () => {
    // One alarm serves every timer; push the 24-hour archive past it to see the deadline.
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30", AUTO_ARCHIVE_HOURS: "10000" });
    const ts = Date.now();
    await conversation(s, ts);
    expect(s.alarm()).toBe(ts + 30 * DAY);
    await s.post("/log", {
      messages: [{ role: "ai", text: "A teammate will reply.", ts: ts + DAY }],
    });
    expect(s.alarm()).toBe(ts + 31 * DAY);
  });

  test("before the deadline the alarm keeps the conversation", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30" });
    await conversation(s, Date.now() - 29 * DAY);
    await s.session.alarm();
    expect(s.store.get("log")).toBeDefined();
    expect(s.telegram).toEqual([]);
  });

  test("past the deadline it deletes the topic, the index and the storage", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30" });
    await conversation(s, Date.now() - 31 * DAY);
    await s.session.alarm();
    expect(s.telegram).toEqual([
      { method: "deleteForumTopic", body: { chat_id: "-100123", message_thread_id: 42 } },
    ]);
    expect(s.kv.size).toBe(0);
    expect(s.store.size).toBe(0);
    expect(s.alarm()).toBeNull();
  });

  test("a Telegram failure doesn't keep the rest", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30" });
    await conversation(s, Date.now() - 31 * DAY);
    globalThis.fetch = (async () =>
      Response.json({ ok: false, description: "not enough rights" })) as unknown as typeof fetch;
    await s.session.alarm();
    expect(s.kv.size).toBe(0);
    expect(s.store.size).toBe(0);
  });

  test("uploaded media in R2 goes with the conversation", async () => {
    const deleted: string[] = [];
    const s = setup({
      CONVERSATION_RETENTION_DAYS: "30",
      MEDIA: { delete: async (key: string) => void deleted.push(key) } as unknown as R2Bucket,
    });
    await conversation(s, Date.now() - 31 * DAY);
    s.store.set("media:record:m1", {
      role: "visitor",
      text: "Sent an image",
      ts: 1,
      media: { id: "m1" },
    });
    await s.session.alarm();
    expect(deleted).toEqual(["media/self/s1/m1"]);
    expect(s.store.size).toBe(0);
  });

  test("a conversation never handed off has no topic to delete", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30" });
    await s.post("/context", { tenantId: "self", sessionId: "s2" });
    await s.post("/log", {
      messages: [{ role: "visitor", text: "hi", ts: Date.now() - 31 * DAY }],
    });
    await s.session.alarm();
    expect(s.telegram).toEqual([]);
    expect(s.store.size).toBe(0);
  });

  test("Telegram being unreachable doesn't keep the rest", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30" });
    await conversation(s, Date.now() - 31 * DAY);
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await s.session.alarm();
    expect(s.kv.size).toBe(0);
    expect(s.store.size).toBe(0);
  });

  test("a message arriving during the deletion keeps the conversation", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30" });
    await conversation(s, Date.now() - 31 * DAY);
    globalThis.fetch = (async () => {
      await s.post("/log", { messages: [{ role: "visitor", text: "still there?" }] });
      return Response.json({ ok: true, result: true });
    }) as unknown as typeof fetch;
    await s.session.alarm();
    const log = s.store.get("log") as { text: string }[];
    expect(log.at(-1)?.text).toBe("still there?");
  });

  test("an inbox read arms retention on a conversation that went quiet before it was set", async () => {
    const s = setup({ CONVERSATION_RETENTION_DAYS: "30", AUTO_ARCHIVE_HOURS: "10000" });
    const ts = Date.now() - 5 * DAY;
    await conversation(s, ts);
    // As a conversation from before the setting: no timer at all.
    await s.clearAlarm();
    expect(s.alarm()).toBeNull();
    await s.get("/summary");
    expect(s.alarm()).toBe(ts + 30 * DAY);
  });

  test("a retention of 0, a negative number or nonsense means off", async () => {
    for (const days of ["0", "-1", "abc"]) {
      const s = setup({ CONVERSATION_RETENTION_DAYS: days });
      await conversation(s, Date.now() - 400 * DAY);
      await s.session.alarm();
      expect(s.store.get("log")).toBeDefined();
    }
  });
});
