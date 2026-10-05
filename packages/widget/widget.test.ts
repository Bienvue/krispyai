import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./widget.js", import.meta.url), "utf8");

function productionColorHelpers() {
  const start = source.indexOf('var BRAND_INK = "#24212e";');
  const end = source.indexOf("// Shared avatar gate", start);
  if (start < 0 || end < 0) throw new Error("widget color helpers not found");
  // Evaluate the exact trusted helper slice from widget.js so this test cannot
  // drift into a separately reimplemented contrast algorithm.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
  const factory = new Function(
    `${source.slice(start, end)}; return { contrastRatio, readableForeground };`,
  ) as () => {
    contrastRatio: (first: string, second: string) => number;
    readableForeground: (background: string) => string;
  };
  return factory();
}

describe("widget visual contract", () => {
  test("the production foreground helper prefers brand ink, then strongest black or white", () => {
    const { contrastRatio, readableForeground } = productionColorHelpers();
    const cases = [
      ["#ffd447", "#24212e"],
      ["#f176a4", "#24212e"],
      ["#17131f", "#ffffff"],
      ["#777777", "#000000"],
    ] as const;

    for (const [background, expected] of cases) {
      expect(readableForeground(background)).toBe(expected);
      expect(contrastRatio(background, expected)).toBeGreaterThanOrEqual(4.5);
    }
    expect(readableForeground("not-a-color")).toBe("#24212e");
  });

  test("open and close share one transform/opacity transition with a reduced-motion exit", () => {
    expect(source).toContain("display:flex;visibility:hidden;opacity:0;pointer-events:none;");
    expect(source).toContain("transition:opacity .2s ease,transform .34s");
    expect(source).toContain("visibility:visible;opacity:1;pointer-events:auto");
    expect(source).toContain(
      "animation:none!important;transition:none!important;transform:none!important",
    );
  });

  test("existing public classes and embedder controls remain present", () => {
    for (const className of [
      "panel",
      "hd",
      "log",
      "att",
      "ft",
      "in",
      "pop",
      "btn",
      "bic",
      "brule",
      "blabel",
      "dot",
      "online",
    ]) {
      expect(source).toContain(`class="${className}`);
    }
    for (const method of ["open", "close", "toggle", "isOpen", "unread"]) {
      expect(source).toContain(`${method}:`);
    }
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain('aria-expanded="false"');
  });

  test("human handoff does not require the visitor to submit contact details", () => {
    expect(source).not.toContain("DEFAULT_CONTACT_FORM");
    expect(source).not.toContain("else if (res.handoff) showForm");
    expect(source).toContain("if (res.form) showForm(res.form)");
  });

  test("app-only tenants do not advertise Telegram-backed screenshot upload", () => {
    expect(source).toContain("c.capabilities.attachments === false");
    expect(source).toContain("if (!attachmentsEnabled) return;");
  });

  test("Buttr floats without a badge fill unless a tenant supplies one", () => {
    expect(source).toContain("--k-launcher:transparent;");
    expect(source).not.toContain("--k-launcher:var(--k-primary)");
    expect(source).toContain("var lc = clampColor(th.launcherColor);");
    expect(source).toContain('host.style.setProperty("--k-launcher", lc)');
    expect(source).toContain('panel.classList.toggle("kfill", launcherHasFill)');
    expect(source).toContain('launcher.classList.toggle("kfill", launcherHasFill)');
    expect(source).toContain("padding:7px;border-radius:0;background:transparent");
  });

  test('data-avatar="none" never requests buttr.png before the theme loads', () => {
    expect(source).toContain('avatar: (script && script.getAttribute("data-avatar")) || ""');
    const boot = source.slice(source.indexOf('if (cfg.avatar === "none") {'));
    expect(boot.slice(0, boot.indexOf("} else {"))).not.toContain("setButtr");
  });

  test("pill width follows the intrinsic label instead of a flex-shrunk button", () => {
    expect(source).toContain("Math.ceil(pillLabel.scrollWidth + 87)");
    expect(source).not.toContain("Math.max(116, pillBtn.scrollWidth)");
  });

  test("coarse pointers get comfortable header controls without resizing desktop controls", () => {
    expect(source).toContain(".hd .mute,.hd .x,.att .attx{");
    expect(source).toContain("width:34px;height:34px;");
    expect(source).toContain("@media (pointer:coarse){.hd .mute,.hd .x{width:44px;height:44px}}");
  });

  test("media bubbles keep their full height inside the scrollable message log", () => {
    expect(source).toContain(
      ".msg.kmedia{flex-shrink:0;max-width:min(84%,290px);padding:7px;overflow:hidden}",
    );
  });

  test("boot config revalidates without creating one-off cache-buster URLs", () => {
    const start = source.indexOf('"/api/widget/config?t="');
    const end = source.indexOf(".then(function (r)", start);
    const bootFetch = source.slice(start, end);
    expect(bootFetch).toContain('{ cache: "no-cache" }');
    expect(bootFetch).not.toContain("Date.now()");
  });

  test("reconnect sync compares raw text, preserving markdown and duplicates", () => {
    expect(source).toContain("d.dataset.krispyText = String(text)");
    expect(source).toContain("el.dataset.krispyText ?? el.textContent");
    expect(source).toContain("counts[key] = (counts[key] || 0) + 1");
    expect(source).toContain("if (counts[key]) counts[key] -= 1");
  });
});

describe("conversation retention", () => {
  // The exact expireTranscript from widget.js, run against a saved transcript.
  function expire(saved: { c: string; t?: string; ts?: number }[], days: unknown, opened = false) {
    const start = source.indexOf("  function expireTranscript(days) {");
    const end = source.indexOf("  // The retention period from the last widget config", start);
    if (start < 0 || end < 0) throw new Error("expireTranscript not found");
    const store = new Map([["krispy_msgs_self", JSON.stringify(saved)]]);
    const localStorage = { removeItem: (k: string) => void store.delete(k) };
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-type-assertion
    const run = new Function(
      "savedMsgs",
      "history",
      "opened",
      "localStorage",
      `var MSG_KEY = "krispy_msgs_self";${source.slice(start, end)}; expireTranscript(${JSON.stringify(days)}); return { savedMsgs, history };`,
    ) as (...args: unknown[]) => { savedMsgs: unknown[]; history: unknown[] };
    const history = [{ role: "user", content: "hi" }];
    const result = run(saved, history, opened, localStorage);
    return { ...result, stored: store.has("krispy_msgs_self") };
  }
  const DAY = 24 * 60 * 60 * 1000;

  test("a transcript older than the retention period is forgotten before the chat opens", () => {
    const old = [{ c: "me", t: "charged twice", ts: Date.now() - 31 * DAY }];
    expect(expire(old, 30)).toEqual({ savedMsgs: [], history: [], stored: false });
  });

  test("a recent transcript, no retention, an open chat or untimed messages are kept", () => {
    const recent = [{ c: "me", t: "hello", ts: Date.now() - DAY }];
    const old = [{ c: "me", t: "hello", ts: Date.now() - 31 * DAY }];
    expect(expire(recent, 30).stored).toBe(true);
    expect(expire(old, undefined).stored).toBe(true);
    expect(expire(old, 0).stored).toBe(true);
    expect(expire(old, 30, true).stored).toBe(true);
    expect(expire([{ c: "me", t: "hello" }], 30).stored).toBe(true);
  });

  test("boot expires the transcript from the last config's period, before the AI context is rebuilt", () => {
    const boot = source.indexOf("  var RETENTION_KEY");
    expect(boot).toBeGreaterThan(source.indexOf("  function expireTranscript(days) {"));
    expect(boot).toBeLessThan(source.indexOf("  // Rebuild the AI context"));
    expect(source).toContain("expireTranscript(localStorage.getItem(RETENTION_KEY));");
    expect(source).toContain("localStorage.setItem(RETENTION_KEY, String(days));");
  });
});
