// `/support on|off|status` from the support channel: what to store and what to say.
// Pure; the route verifies Slack's signature, reads KV, and writes `write` back.
import {
  availabilityAt,
  formatInZone,
  nextOpening,
  TOGGLE_OFF_FALLBACK_MS,
  TOGGLE_ON_MS,
  type AvailabilityConfig,
  type AvailabilityOverride,
} from "./availability";

export interface SupportReply {
  response_type: "in_channel" | "ephemeral";
  text: string;
}

/** The time alone when it's later the same local day, with the weekday otherwise. */
function when(ms: number, now: number, timeZone: string): string {
  const day = (t: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(t);
  return formatInZone(ms, timeZone, day(ms) !== day(now));
}

const say = (text: string): SupportReply => ({ response_type: "in_channel", text });
const tell = (text: string): SupportReply => ({ response_type: "ephemeral", text });

export function supportCommand(
  input: { text: string; userId: string; channelId: string },
  ctx: {
    supportChannelId: string;
    config: AvailabilityConfig | undefined;
    override: AvailabilityOverride | null;
    now: number;
  },
): { reply: SupportReply; write?: AvailabilityOverride } {
  if (input.channelId !== ctx.supportChannelId)
    return { reply: tell("Use /support in the support channel.") };
  const { config, now } = ctx;
  if (!config) return { reply: tell("Support availability isn't configured.") };

  const arg = input.text.trim().toLowerCase();
  const tz = config.timezone;
  if (arg === "on") {
    const until = now + TOGGLE_ON_MS;
    return {
      reply: say(`<@${input.userId}> is on support until ${when(until, now, tz)}.`),
      write: { online: true, until },
    };
  }
  if (arg === "off") {
    const until = nextOpening(config, now) ?? now + TOGGLE_OFF_FALLBACK_MS;
    return {
      reply: say(
        `<@${input.userId}> is off support. Back on the hours from ${formatInZone(until, tz)}.`,
      ),
      write: { online: false, until },
    };
  }
  if (arg === "" || arg === "status") {
    const a = availabilityAt(config, ctx.override, now);
    const state = a.online ? "online" : "offline";
    const why = a.source === "toggle" ? "toggled" : "support hours";
    const until = a.changesAt === null ? "" : ` until ${when(a.changesAt, now, tz)}`;
    return { reply: say(`Support is ${state} (${why})${until}.`) };
  }
  return { reply: tell("Usage: /support on, /support off, or /support for the status.") };
}
