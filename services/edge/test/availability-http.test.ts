import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import { FALLBACK_REPLY } from "../src/chat";
import { SessionDO } from "../src/session-do";
import { kAvailability } from "../src/availability";
import { mergeTenantConfig } from "../src/store";
import type { Env } from "../src/types";

function fakeEnv(extra: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  return {
    KRISPY_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [], list_complete: true }),
    },
    TENANT_SYNC_SECRET: "sync",
    ...extra,
  } as unknown as Env;
}

const hours = {
  timezone: "America/Denver",
  hours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
};
const get = (env: Env) => worker.fetch(new Request("https://edge.test/api/availability"), env);

describe("GET /api/availability", () => {
  test("unconfigured: online is null", async () => {
    const res = await get(fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: null, nextOnlineAt: null });
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("configured: only online and nextOnlineAt", async () => {
    const env = fakeEnv();
    await mergeTenantConfig(env, "self", {
      availability: { ...hours, hours: [{ days: [1], start: "09:00", end: "09:01" }] },
    });
    const body = (await (await get(env)).json()) as Record<string, unknown>;
    // eslint-disable-next-line unicorn/no-array-sort -- keys() is a fresh array
    expect(Object.keys(body).sort()).toEqual(["nextOnlineAt", "online"]);
    expect(typeof body.online).toBe("boolean");
  });

  test("an unexpired toggle off wins over open hours", async () => {
    const env = fakeEnv();
    await mergeTenantConfig(env, "self", { availability: hours });
    await env.KRISPY_KV.put(
      kAvailability("self"),
      JSON.stringify({ online: false, until: Date.now() + 60_000 }),
    );
    const body = (await (await get(env)).json()) as { online: boolean; nextOnlineAt: string };
    expect(body.online).toBe(false);
    expect(typeof body.nextOnlineAt).toBe("string");
  });
});

const post = (env: Env, availability: unknown) =>
  worker.fetch(
    new Request("https://edge.test/api/tenant/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant-sync-secret": "sync" },
      body: JSON.stringify({ tenantId: "self", config: { availability } }),
    }),
    env,
  );

describe("POST /api/tenant/config with availability", () => {
  test("a valid config is stored", async () => {
    expect((await post(fakeEnv(), hours)).status).toBe(200);
  });
  test("an invalid one is refused", async () => {
    const res = await post(fakeEnv(), { ...hours, timezone: "Mars/Olympus" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_availability" });
  });
});

// ── the chat route, end to end ───────────────────────────────────────────────
function fakeDOState(): DurableObjectState {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (k: string) => store.get(k),
    put: async (k: string, v: unknown) => void store.set(k, v),
    setAlarm: async (t: number | Date) => void (alarm = typeof t === "number" ? t : t.getTime()),
    deleteAlarm: async () => void (alarm = null),
    getAlarm: async () => alarm,
  };
  return {
    acceptWebSocket: () => {},
    getWebSockets: () => [],
    storage: {
      ...storage,
      transaction: async (run: (tx: typeof storage) => Promise<unknown>) => run(storage),
    },
  } as unknown as DurableObjectState;
}

function wireSessionNS(env: Env): Env {
  const dos = new Map<string, SessionDO>();
  (env as { SESSION: unknown }).SESSION = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        let d = dos.get(name);
        if (!d) {
          d = new SessionDO(fakeDOState(), env);
          dos.set(name, d);
        }
        return d.fetch(input instanceof Request ? input : new Request(String(input), init));
      },
    }),
  };
  return env;
}

describe("the chat route with availability", () => {
  test("the bot telling a visitor nobody is online isn't treated as a prompt leak", async () => {
    const env = wireSessionNS(
      fakeEnv({ SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL_ID: "C1", SLACK_SIGNING_SECRET: "sig" }),
    );
    // Closed every day, so the turn's instructions say nobody is online.
    await mergeTenantConfig(env, "self", {
      availability: { timezone: "America/Denver", hours: [{ days: [1], start: "09:00", end: "09:01" }], holidays: [] },
    });
    await env.KRISPY_KV.put(
      kAvailability("self"),
      JSON.stringify({ online: false, until: Date.now() + 60 * 60_000 }),
    );
    const echo =
      "No teammate is online right now. If you hand off, say when to expect a reply and offer the email form if one is configured.";
    (env as { AI: unknown }).AI = { run: async () => ({ response: echo }) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ ok: true, ts: "1.1" })) as unknown as typeof fetch;
    try {
      const res = await worker.fetch(
        new Request("https://edge.test/api/chat", {
          method: "POST",
          body: JSON.stringify({ sessionId: "s", tenantId: "self", message: "anyone there?" }),
        }),
        env,
      );
      const body = (await res.json()) as { reply: string };
      expect(body.reply).not.toBe(FALLBACK_REPLY);
      expect(body.reply).toContain("No teammate is online right now.");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
