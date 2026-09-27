// Read-only production post-deploy gate for the edge -> Cloud API token lookup.
// The live Worker can otherwise answer /health while pushToApp silently returns 0.
// Never print PUSH_TOKENS_SECRET or any device tokens.
import { readFileSync } from "node:fs";

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const pushSecret = process.env.PUSH_TOKENS_SECRET;
if (!token || !account || !pushSecret) {
  console.error("✘ push check needs Cloudflare credentials and PUSH_TOKENS_SECRET");
  process.exit(1);
}

const toml = readFileSync(new URL("../services/edge/wrangler.toml", import.meta.url), "utf8");
const productionVars = toml.split("[env.production.vars]\n")[1]?.split(/^\[/m)[0];
const expectedUrl = productionVars?.match(/^PUSH_TOKENS_URL\s*=\s*"([^"]+)"/m)?.[1];
if (!expectedUrl) throw new Error("production PUSH_TOKENS_URL is absent from wrangler.toml");

async function bindings(worker) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/settings`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
  );
  const body = await res.json();
  if (!res.ok || !body.success || !Array.isArray(body.result?.bindings)) {
    throw new Error(`could not inspect ${worker} Worker settings (${res.status})`);
  }
  return body.result.bindings;
}

const [edge, api] = await Promise.all([bindings("krispy-edge"), bindings("krispy-api")]);
const edgeUrl = edge.find((binding) => binding.name === "PUSH_TOKENS_URL");
if (edgeUrl?.text !== expectedUrl) {
  throw new Error("production edge PUSH_TOKENS_URL does not match wrangler.toml");
}
for (const [name, rows] of [
  ["edge", edge],
  ["api", api],
]) {
  if (
    !rows.some((binding) => binding.name === "PUSH_TOKENS_SECRET" && binding.type === "secret_text")
  ) {
    throw new Error(`${name} PUSH_TOKENS_SECRET binding is missing`);
  }
}

const lookup = await fetch(`${expectedUrl}?t=__push_readiness_probe__`, {
  headers: { "x-push-tokens-secret": pushSecret },
  signal: AbortSignal.timeout(10_000),
});
if (!lookup.ok) throw new Error(`Cloud API push token lookup failed (${lookup.status})`);
const body = await lookup.json();
if (!Array.isArray(body.tokens) || body.tokens.length !== 0) {
  throw new Error("Cloud API push token lookup returned an invalid probe response");
}
console.log("✔ hosted push config: edge binding, both secrets, and Cloud API lookup");
