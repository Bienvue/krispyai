import { describe, expect, test } from "bun:test";
import {
  escapeSlack,
  HANDBACK_ACTION,
  isThreadGone,
  parseHandback,
  parseThreadReply,
  slackHandoffAlert,
  slackPost,
  slackStartThread,
  slackToPlain,
  slackUploadImage,
  SlackError,
  verifySlackRequest,
} from "../src/slack";

/** Records every call; answers Slack-shaped JSON from `reply(url, body)`. */
function recorder(reply: (url: string, body: unknown) => unknown = () => ({ ok: true })) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const body =
      typeof raw === "string"
        ? raw.startsWith("{")
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw))
        : raw;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const out = reply(url, body);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

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

describe("verifySlackRequest", () => {
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);
  const body = '{"type":"event_callback"}';

  test("a correct signature passes", async () => {
    expect(await verifySlackRequest("sig", ts, await sign("sig", ts, body), body, now)).toBe(true);
  });
  test("a wrong secret, a tampered body or a missing header fails", async () => {
    expect(await verifySlackRequest("sig", ts, await sign("other", ts, body), body, now)).toBe(
      false,
    );
    expect(await verifySlackRequest("sig", ts, await sign("sig", ts, body), body + " ", now)).toBe(
      false,
    );
    expect(await verifySlackRequest("sig", null, await sign("sig", ts, body), body, now)).toBe(
      false,
    );
    expect(await verifySlackRequest("sig", ts, "v0=nothex", body, now)).toBe(false);
  });
  test("a timestamp more than 5 minutes off fails (replay)", async () => {
    const old = String(now / 1000 - 301);
    expect(await verifySlackRequest("sig", old, await sign("sig", old, body), body, now)).toBe(
      false,
    );
  });
});

describe("text in and out of Slack", () => {
  test("escapeSlack stops a visitor's text from pinging anyone", () => {
    expect(escapeSlack("<!channel> & <@U1> hi")).toBe("&lt;!channel&gt; &amp; &lt;@U1&gt; hi");
  });
  test("slackToPlain turns Slack markup back into what the operator typed", () => {
    expect(slackToPlain("Tom &amp; Jerry &lt;3")).toBe("Tom & Jerry <3");
    expect(slackToPlain("see <https://help.example.com/a|the article>")).toBe(
      "see the article (https://help.example.com/a)",
    );
    expect(slackToPlain("see <https://help.example.com/a>")).toBe("see https://help.example.com/a");
    expect(slackToPlain("mail <mailto:a@b.co|a@b.co>")).toBe("mail a@b.co");
    expect(slackToPlain("&amp;lt;")).toBe("&lt;"); // decoded once, not twice
  });
  test("slackToPlain turns mentions into readable words, not raw markup", () => {
    expect(slackToPlain("<@U0123> can you take this?")).toBe("@teammate can you take this?");
    expect(slackToPlain("see <#C0123|general>")).toBe("see #general");
    expect(slackToPlain("<!here> heads up")).toBe("@here heads up");
    expect(slackToPlain("ask <!subteam^S1|@support>")).toBe("ask @support");
    expect(slackToPlain("on <!date^1700000000^{date}|Nov 14>")).toBe("on Nov 14");
  });
});

describe("Web API calls", () => {
  test("slackStartThread posts to the channel and returns the ts", async () => {
    const { calls, fetchImpl } = recorder(() => ({ ok: true, ts: "1700000000.000100" }));
    expect(await slackStartThread("xoxb-1", "C1", "Hi · abc123", fetchImpl)).toBe(
      "1700000000.000100",
    );
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]!.headers.authorization).toBe("Bearer xoxb-1");
    expect(calls[0]!.body).toEqual({ channel: "C1", text: "Hi · abc123" });
  });

  test("slackPost replies in the thread", async () => {
    const { calls, fetchImpl } = recorder();
    await slackPost("xoxb-1", "C1", "1.2", "👤 hello", fetchImpl);
    expect(calls[0]!.body).toEqual({ channel: "C1", thread_ts: "1.2", text: "👤 hello" });
  });

  test("a Slack error throws SlackError with the code; thread errors are recognized", async () => {
    const { fetchImpl } = recorder(() => ({ ok: false, error: "thread_not_found" }));
    let caught: unknown;
    try {
      await slackPost("xoxb-1", "C1", "1.2", "x", fetchImpl);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SlackError);
    expect((caught as SlackError).code).toBe("thread_not_found");
    expect(isThreadGone(caught)).toBe(true);
    expect(isThreadGone(new SlackError("chat.postMessage", "ratelimited"))).toBe(false);
    expect(isThreadGone(new Error("network"))).toBe(false);
  });

  test("slackHandoffAlert pings the channel, broadcasts, and carries the hand-back button", async () => {
    const { calls, fetchImpl } = recorder();
    await slackHandoffAlert("xoxb-1", "C1", "1.2", "A visitor needs a human here.", fetchImpl);
    const body = calls[0]!.body as Record<string, any>;
    expect(body.thread_ts).toBe("1.2");
    expect(body.reply_broadcast).toBe(true);
    expect(body.text.startsWith("<!channel> ")).toBe(true);
    const button = body.blocks[1].elements[0];
    expect(button.action_id).toBe(HANDBACK_ACTION);
    expect(button.value).toBe("1.2");
  });

  test("slackUploadImage: get an upload URL, send the bytes, complete into the thread", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("files.getUploadURLExternal")
        ? { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" }
        : url.startsWith("https://files.slack.com")
          ? new Response("OK - 3")
          : { ok: true },
    );
    await slackUploadImage(
      "xoxb-1",
      "C1",
      "1.2",
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      "screenshot.png",
      "The visitor sent a screenshot.",
      fetchImpl,
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/abc",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
    expect(calls[0]!.body).toEqual({ filename: "screenshot.png", length: "3" });
    expect(calls[2]!.body).toEqual({
      files: JSON.stringify([{ id: "F1", title: "screenshot.png" }]),
      channel_id: "C1",
      thread_ts: "1.2",
      initial_comment: "The visitor sent a screenshot.",
    });
  });

  test("a failed byte upload throws before completing", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith("files.getUploadURLExternal")
        ? { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" }
        : new Response("nope", { status: 500 }),
    );
    let threw = false;
    try {
      await slackUploadImage("xoxb-1", "C1", "1.2", new Blob(["x"]), "s.png", "", fetchImpl);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("parseThreadReply", () => {
  const reply = {
    type: "message",
    channel: "C1",
    user: "U9",
    text: " on it ",
    ts: "2.0",
    thread_ts: "1.0",
  };

  test("a person's reply in a thread of our channel", () => {
    expect(parseThreadReply(reply, "C1")).toEqual({ threadTs: "1.0", text: "on it", userId: "U9" });
  });
  test("a reply also sent to the channel still counts", () => {
    expect(parseThreadReply({ ...reply, subtype: "thread_broadcast" }, "C1")).toEqual({
      threadTs: "1.0",
      text: "on it",
      userId: "U9",
    });
  });
  test("ignores bots, subtypes, root messages, other channels and empty text", () => {
    expect(parseThreadReply({ ...reply, bot_id: "B1" }, "C1")).toBeNull();
    expect(parseThreadReply({ ...reply, subtype: "message_changed" }, "C1")).toBeNull();
    expect(parseThreadReply({ ...reply, thread_ts: undefined }, "C1")).toBeNull();
    expect(parseThreadReply({ ...reply, thread_ts: "2.0" }, "C1")).toBeNull();
    expect(parseThreadReply({ ...reply, channel: "C2" }, "C1")).toBeNull();
    expect(parseThreadReply({ ...reply, text: "   " }, "C1")).toBeNull();
    expect(parseThreadReply(null, "C1")).toBeNull();
  });
});

describe("parseHandback", () => {
  const payload = {
    type: "block_actions",
    channel: { id: "C1" },
    actions: [{ action_id: HANDBACK_ACTION, value: "1.0" }],
  };
  test("the hand-back button names its thread", () => {
    expect(parseHandback(payload, "C1")).toBe("1.0");
  });
  test("other actions, payload types and channels are ignored", () => {
    expect(
      parseHandback({ ...payload, actions: [{ action_id: "other", value: "1.0" }] }, "C1"),
    ).toBeNull();
    expect(parseHandback({ ...payload, type: "view_submission" }, "C1")).toBeNull();
    expect(parseHandback({ ...payload, channel: { id: "C2" } }, "C1")).toBeNull();
    expect(parseHandback(null, "C1")).toBeNull();
  });
});
