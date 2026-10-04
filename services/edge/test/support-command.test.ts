import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import {
  kAvailability,
  type AvailabilityConfig,
  type AvailabilityOverride,
} from "../src/availability";
import { mergeTenantConfig } from "../src/store";
import { supportCommand } from "../src/support-command";
import type { Env } from "../src/types";

const config: AvailabilityConfig = {
  timezone: "America/Denver",
  hours: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
};
const now = Date.parse("2026-10-05T16:00:00Z"); // Mon 10:00 MDT
const ctx = {
  supportChannelId: "C1",
  config: config as AvailabilityConfig | undefined,
  override: null as AvailabilityOverride | null,
  now,
};
const run = (text: string, over: Partial<typeof ctx> = {}, channelId = "C1") =>
  supportCommand({ text, userId: "U9", channelId }, { ...ctx, ...over });

describe("/support", () => {
  test("on: online for four hours, said in the channel", () => {
    const out = run("on");
    expect(out.write).toEqual({ online: true, until: now + 4 * 60 * 60_000 });
    expect(out.reply.response_type).toBe("in_channel");
    expect(out.reply.text).toBe("<@U9> is on support until 2:00 PM Mountain Time.");
  });

  test("off: offline until the next opening", () => {
    const out = run("off");
    expect(out.write).toEqual({ online: false, until: Date.parse("2026-10-06T15:00:00Z") });
    expect(out.reply.response_type).toBe("in_channel");
    expect(out.reply.text).toBe(
      "<@U9> is off support. Back on the hours from Tuesday, 9:00 AM Mountain Time.",
    );
  });

  test("off with no opening in two weeks: 24 hours", () => {
    const out = run("off", { config: { ...config, hours: [] } });
    expect(out.write).toEqual({ online: false, until: now + 24 * 60 * 60_000 });
  });

  test("status, with no argument or 'status': from the hours", () => {
    for (const text of ["", "  ", "status"]) {
      const out = run(text);
      expect(out.write).toBeUndefined();
      expect(out.reply.response_type).toBe("in_channel");
      expect(out.reply.text).toBe("Support is online (support hours) until 5:00 PM Mountain Time.");
    }
  });

  test("status while toggled off", () => {
    const out = run("", { override: { online: false, until: Date.parse("2026-10-06T15:00:00Z") } });
    expect(out.reply.text).toBe(
      "Support is offline (toggled) until Tuesday, 9:00 AM Mountain Time.",
    );
  });

  test("the wrong channel changes nothing, privately", () => {
    const out = run("on", {}, "C2");
    expect(out.write).toBeUndefined();
    expect(out.reply).toEqual({
      response_type: "ephemeral",
      text: "Use /support in the support channel.",
    });
  });

  test("an unknown argument gets usage, privately", () => {
    const out = run("maybe");
    expect(out.write).toBeUndefined();
    expect(out.reply.response_type).toBe("ephemeral");
    expect(out.reply.text).toBe("Usage: /support on, /support off, or /support for the status.");
  });

  test("no hours configured, privately", () => {
    const out = run("on", { config: undefined });
    expect(out.write).toBeUndefined();
    expect(out.reply).toEqual({
      response_type: "ephemeral",
      text: "Support availability isn't configured.",
    });
  });
});

async function sign(secret: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)),
  );
  return "v0=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slackEnv(): Env {
  const kv = new Map<string, string>();
  return {
    KRISPY_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      list: async () => ({ keys: [], list_complete: true }),
    },
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_CHANNEL_ID: "C1",
    SLACK_SIGNING_SECRET: "sig",
  } as unknown as Env;
}

describe("POST /api/slack/commands", () => {
  const body = "command=%2Fsupport&text=on&user_id=U9&channel_id=C1";
  const call = async (env: Env, signature?: string) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return worker.fetch(
      new Request("https://edge.test/api/slack/commands", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": ts,
          "x-slack-signature": signature ?? (await sign("sig", ts, body)),
        },
        body,
      }),
      env,
    );
  };

  test("a bad signature is refused and nothing is stored", async () => {
    const env = slackEnv();
    const res = await call(env, "v0=" + "0".repeat(64));
    expect(res.status).toBe(403);
    expect(await env.KRISPY_KV.get(kAvailability("self"))).toBeNull();
  });

  test("a signed /support on stores the toggle and answers in the channel", async () => {
    const env = slackEnv();
    await mergeTenantConfig(env, "self", { availability: config });
    const res = await call(env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { response_type: string }).response_type).toBe("in_channel");
    const stored = JSON.parse((await env.KRISPY_KV.get(kAvailability("self")))!);
    expect(stored.online).toBe(true);
  });
});
