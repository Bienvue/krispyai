import { expect, test } from "bun:test";
import { SessionDO } from "../src/session-do";
import { DO_INTERNAL_HEADER } from "../src/store";
import type { Env } from "../src/types";

const visitorSecret = "v".repeat(43);

function harness() {
  const values = new Map<string, unknown>();
  const operatorEvents: unknown[] = [];
  const state = {
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      transaction: async (run: (tx: DurableObjectStorage) => Promise<unknown>) =>
        run(state.storage),
      list: async () => new Map(),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      getAlarm: async () => null,
    },
    getWebSockets: (tag?: string) =>
      tag === "operator"
        ? [{ send: (frame: string) => operatorEvents.push(JSON.parse(frame)) }]
        : [],
  } as unknown as DurableObjectState;
  const object = new SessionDO(state, { DO_INTERNAL_SECRET: "identity-test" } as Env);
  const post = (path: string, body: object) =>
    object.fetch(
      new Request(`https://do${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [DO_INTERNAL_HEADER]: "identity-test" },
        body: JSON.stringify(body),
      }),
    );
  const get = (path: string) =>
    object.fetch(
      new Request(`https://do${path}`, { headers: { [DO_INTERNAL_HEADER]: "identity-test" } }),
    );
  return { post, get, operatorEvents };
}

test("a visitor can name only their own existing chat; country is edge-set and write-once", async () => {
  const h = harness();
  const identity = { tenantId: "tenant-a", siteId: "default", sessionId: "session-a" };
  await h.post("/context", { ...identity, countryCode: "IL" });
  await h.post("/call/visitor/register", { ...identity, secret: visitorSecret });

  expect(
    (await h.post("/visitor/identity", { ...identity, visitorSecret: "x".repeat(43), name: "Adi" }))
      .status,
  ).toBe(403);
  expect(
    (
      await h.post("/visitor/identity", {
        ...identity,
        siteId: "another",
        visitorSecret,
        name: "Adi",
      })
    ).status,
  ).toBe(403);
  expect(
    (await h.post("/visitor/identity", { ...identity, visitorSecret, name: "\u202EAdi" })).status,
  ).toBe(400);
  expect(
    (await h.post("/visitor/identity", { ...identity, visitorSecret, name: "Adi Moyal" })).status,
  ).toBe(200);
  await h.post("/context", { ...identity, countryCode: "US" });

  const summary = await (await h.get("/summary")).json();
  const thread = await (await h.get("/log")).json();
  expect(summary.visitorName).toBe("Adi Moyal");
  expect(summary.countryCode).toBe("IL");
  expect(thread.visitorName).toBe("Adi Moyal");
  expect(thread.countryCode).toBe("IL");
  expect(h.operatorEvents).toContainEqual({
    type: "identity",
    visitorName: "Adi Moyal",
    countryCode: "IL",
  });
});
