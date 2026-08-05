#!/usr/bin/env node
// Provider-exact token checks for pi-contextimate (issue #8).
//
// Takes a captured provider payload (from probe-live-prefix.mjs / payload-capture.ts) and
// builds a matrix of minimal counting requests — baseline, system-only, all-tools, and
// per-tool — so users can get *provider-exact* token numbers for the static prefix, for
// individual tools (including lazy-loaded MCP servers/skills whose hot-path footprint the
// estimator cannot see), and tune their contextimate heuristic denominators from evidence.
//
// Honesty contract: payload sections are passed through **byte-identical** — this script
// never reshapes tools or the system prompt, so what gets counted is exactly what pi sent
// (the same payloads contextimate's estimates model). This no-reshaping property is
// unit-tested in tests/contextimate/provider-check.test.ts.
//
// Network execution is explicit (--live) and never happens in tests:
//   - anthropic: POST /v1/messages/count_tokens — free, exact.
//   - openai:    POST /v1/responses with max_output_tokens=16, store=false — NOT free
//                (tiny cost per probe); usage.input_tokens is exact.
//
// Adding another provider = one more entry in PROVIDERS below (build + execute + notes);
// no contextimate changes needed.
//
// Usage:
//   node scripts/contextimate/check-provider-tokens.mjs --payload /tmp/probe/<x>.payloads.jsonl
//     [--provider anthropic|openai] [--tools read,bash] [--model <id>] [--live] [--json]
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const MINIMAL_USER_TEXT = "hi";

// ---------------------------------------------------------------------------------------
// Payload loading / detection (pure).

export function detectPayloadKind(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (Array.isArray(payload.input) || typeof payload.instructions === "string") return "openai-responses";
  if (Array.isArray(payload.messages)) return "anthropic";
  return undefined;
}

export function parsePayloadFile(text) {
  const trimmed = text.trim();
  const candidates = [];
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    candidates.push(JSON.parse(trimmed));
  } else {
    for (const line of trimmed.split("\n")) {
      const lineTrimmed = line.trim();
      if (lineTrimmed.length === 0) continue;
      candidates.push(JSON.parse(lineTrimmed));
    }
  }
  // The first captured payload of a run carries the full static prefix; later ones add
  // session messages. Use the first recognizable one.
  for (const candidate of candidates) {
    const kind = detectPayloadKind(candidate);
    if (kind) return { kind, payload: candidate };
  }
  throw new Error("no recognizable provider payload found (expected an Anthropic Messages or OpenAI Responses body)");
}

function selectTools(payloadTools, onlyNames) {
  const tools = Array.isArray(payloadTools) ? payloadTools : [];
  if (!onlyNames || onlyNames.length === 0) return tools;
  const wanted = new Set(onlyNames);
  return tools.filter((tool) => wanted.has(tool?.name ?? tool?.function?.name));
}

export function jsonSha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// ---------------------------------------------------------------------------------------
// Request builders (pure; unit-tested). Sections pass through byte-identical.

export function buildAnthropicExactCountRequest(payload, options = {}) {
  const model = options.model ?? payload.model;
  if (!model) throw new Error("payload has no model; pass --model");
  if (!Array.isArray(payload.messages)) throw new Error("payload has no messages array");
  const body = { model, messages: payload.messages };
  for (const key of ["system", "tools", "tool_choice", "thinking", "output_config", "cache_control"]) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  return { id: "exact", label: "exact captured prompt", body };
}

export function buildAnthropicCountRequests(payload, options = {}) {
  const model = options.model ?? payload.model;
  if (!model) throw new Error("payload has no model; pass --model");
  const messages = [{ role: "user", content: MINIMAL_USER_TEXT }];
  const tools = selectTools(payload.tools, options.tools);
  const requests = [{ id: "baseline", label: "baseline (minimal message only)", body: { model, messages } }];
  if (payload.system !== undefined) {
    requests.push({ id: "system", label: "system prompt", body: { model, system: payload.system, messages } });
  }
  if (tools.length > 0) {
    requests.push({ id: "tools", label: `all tools (${tools.length})`, body: { model, tools, messages } });
    for (const tool of tools) {
      requests.push({ id: `tool:${tool.name}`, label: `tool ${tool.name}`, body: { model, tools: [tool], messages } });
    }
  }
  const full = { model, messages };
  if (payload.system !== undefined) full.system = payload.system;
  if (tools.length > 0) full.tools = tools;
  requests.push({ id: "full", label: "full static prefix (system + tools)", body: full });
  return requests;
}

export function buildOpenAIResponsesProbes(payload, options = {}) {
  const model = options.model ?? payload.model;
  if (!model) throw new Error("payload has no model; pass --model");
  const input = [{ role: "user", content: [{ type: "input_text", text: MINIMAL_USER_TEXT }] }];
  const base = { model, input, max_output_tokens: 16, store: false, stream: false };
  const tools = selectTools(payload.tools, options.tools);
  const requests = [{ id: "baseline", label: "baseline (minimal message only)", body: { ...base } }];
  if (payload.instructions !== undefined) {
    requests.push({ id: "system", label: "instructions (system prompt)", body: { ...base, instructions: payload.instructions } });
  }
  if (tools.length > 0) {
    requests.push({ id: "tools", label: `all tools (${tools.length})`, body: { ...base, tools } });
    for (const tool of tools) {
      const name = tool?.name ?? tool?.function?.name ?? "unnamed";
      requests.push({ id: `tool:${name}`, label: `tool ${name}`, body: { ...base, tools: [tool] } });
    }
  }
  const full = { ...base };
  if (payload.instructions !== undefined) full.instructions = payload.instructions;
  if (tools.length > 0) full.tools = tools;
  requests.push({ id: "full", label: "full static prefix (instructions + tools)", body: full });
  return requests;
}

// ---------------------------------------------------------------------------------------
// Result math (pure; unit-tested).

// Providers add a fixed tool-block overhead once per request whenever any tool is
// present (Anthropic: roughly 300 tokens of injected tool-use instructions). A tiny
// probe is dominated by it, so raw per-tool marginals wildly overstate small tools.
// With counts for >=2 individual tools plus the all-tools count, the overhead is
// solvable: count(tool_i) = baseline + F + t_i and count(all) = baseline + F + Σt_i
// give F = (Σ(count_i − baseline) − (count_all − baseline)) / (N − 1).
export function computeToolOverhead(requests, counts) {
  const baseline = counts.baseline;
  const all = counts.tools;
  if (baseline === undefined || all === undefined) return undefined;
  const toolRequests = requests.filter((request) => request.id.startsWith("tool:"));
  if (toolRequests.length < 2) return undefined;
  let sum = 0;
  for (const request of toolRequests) {
    const count = counts[request.id];
    if (count === undefined) return undefined;
    sum += count - baseline;
  }
  return Math.max(0, Math.round((sum - (all - baseline)) / (toolRequests.length - 1)));
}

export function summarizeCounts(requests, counts) {
  const baseline = counts.baseline ?? 0;
  const toolOverhead = computeToolOverhead(requests, counts);
  const rows = requests.map(({ id, label, body }) => {
    const tokens = counts[id];
    const marginal = id === "baseline" || tokens === undefined ? undefined : tokens - baseline;
    let chars;
    if (id === "system") chars = JSON.stringify(body.system ?? body.instructions ?? "").length - 2;
    else if (id.startsWith("tool")) chars = JSON.stringify(body.tools).length;
    // Net = marginal minus the once-per-request tool overhead, the number comparable to
    // contextimate's per-tool estimates and the honest basis for chars/token.
    let netTokens = marginal;
    if (marginal !== undefined && toolOverhead !== undefined && id.startsWith("tool")) {
      netTokens = Math.max(0, marginal - toolOverhead);
    }
    const charsPerToken = chars !== undefined && netTokens ? chars / netTokens : undefined;
    return { id, label, tokens, marginal, netTokens, chars, charsPerToken };
  });
  return { rows, toolOverhead };
}

export function suggestDenominators(summary) {
  const byId = Object.fromEntries(summary.rows.map((row) => [row.id, row]));
  const suggestion = {};
  if (byId.system?.charsPerToken) suggestion.textDenominator = Number(byId.system.charsPerToken.toFixed(2));
  if (byId.tools?.charsPerToken) suggestion.toolDenominator = Number(byId.tools.charsPerToken.toFixed(2));
  return suggestion;
}

// ---------------------------------------------------------------------------------------
// Provider registry: add a provider by adding an entry — build() makes the request matrix
// from a captured payload; execute() sends one body and returns the exact input tokens.

export const PROVIDERS = {
  anthropic: {
    detect: (kind) => kind === "anthropic",
    build: buildAnthropicCountRequests,
    exact: buildAnthropicExactCountRequest,
    api: "anthropic-messages",
    exactSource: "anthropic-count-tokens",
    cost: "free (count_tokens endpoint)",
    env: "ANTHROPIC_API_KEY",
    // Credential resolution: ANTHROPIC_API_KEY → x-api-key; otherwise pi's own OAuth
    // token from ~/.pi/agent/auth.json → Bearer (most pi users have no env key).
    resolveCredential() {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) return { apiKey };
      const oauthToken = readPiOAuthAccessToken("anthropic");
      if (oauthToken) return { oauthToken };
      return undefined;
    },
    credentialHint: "set ANTHROPIC_API_KEY, or log into anthropic in pi (/login) so ~/.pi/agent/auth.json has a fresh token",
    async execute(body, { apiKey, oauthToken, fetchImpl = fetch }) {
      const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
      if (apiKey) headers["x-api-key"] = apiKey;
      else if (oauthToken) {
        headers["authorization"] = `Bearer ${oauthToken}`;
        headers["anthropic-beta"] = "oauth-2025-04-20";
      }
      const response = await fetchImpl("https://api.anthropic.com/v1/messages/count_tokens", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`anthropic ${response.status}: ${JSON.stringify(data)}`);
      return data.input_tokens;
    },
  },
  openai: {
    detect: (kind) => kind === "openai-responses",
    build: buildOpenAIResponsesProbes,
    cost: "NOT free — each probe is a real (tiny) request; usage.input_tokens is exact",
    env: "OPENAI_API_KEY",
    // pi's openai-codex OAuth tokens target the ChatGPT backend, not api.openai.com,
    // so a platform API key is the only supported credential here.
    resolveCredential() {
      const apiKey = process.env.OPENAI_API_KEY;
      return apiKey ? { apiKey } : undefined;
    },
    credentialHint: "set OPENAI_API_KEY (pi's openai-codex OAuth token cannot call api.openai.com)",
    async execute(body, { apiKey, fetchImpl = fetch }) {
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`openai ${response.status}: ${JSON.stringify(data)}`);
      return data.usage?.input_tokens;
    },
  },
};

// Reads pi's locally stored OAuth access token. Local use only — the token is sent to
// the provider's official API endpoint and never printed or written anywhere.
function readPiOAuthAccessToken(provider) {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return undefined;
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const entry = auth?.[provider];
    if (!entry?.access) return undefined;
    if (typeof entry.expires === "number" && entry.expires <= Date.now()) {
      process.stderr.write(`pi ${provider} OAuth token is expired — open pi to refresh it\n`);
      return undefined;
    }
    return entry.access;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// CLI.

function parseArgs(argv) {
  const args = { live: false, json: false, exact: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--payload") args.payload = argv[++i];
    else if (arg === "--provider") args.provider = argv[++i];
    else if (arg === "--tools") args.tools = argv[++i].split(",").map((name) => name.trim()).filter(Boolean);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--live") args.live = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--exact") args.exact = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const HELP = `check-provider-tokens — provider-exact token counts for a captured pi payload

  1. Capture a payload:  node scripts/contextimate/probe-live-prefix.mjs --output-dir /tmp/probe
  2. Copy the single payload path printed by the probe
  3. Dry-run the plan:   node scripts/contextimate/check-provider-tokens.mjs --payload /tmp/probe/CAPTURE.payloads.jsonl
  4. Execute:            ... --live   (anthropic: free count_tokens; openai: tiny real cost)

Options: --payload <file>  --provider anthropic|openai  --tools a,b  --model <id>  --live  --exact  --json

--exact counts the complete captured prompt where the provider offers a count endpoint;
default mode runs controlled static-section ablations.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.payload) {
    console.log(HELP);
    process.exit(args.help ? 0 : 2);
  }
  const { kind, payload } = parsePayloadFile(readFileSync(args.payload, "utf8"));
  const providerName = args.provider ?? Object.keys(PROVIDERS).find((name) => PROVIDERS[name].detect(kind));
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`no provider for payload kind ${kind}; pass --provider (${Object.keys(PROVIDERS).join("|")})`);

  if (args.exact && !provider.exact) throw new Error(`${providerName} has no non-generating exact-count endpoint`);
  const requests = args.exact
    ? [provider.exact(payload, { model: args.model })]
    : provider.build(payload, { tools: args.tools, model: args.model });
  if (!args.live) {
    const plan = requests.map(({ id, label, body }) => ({ id, label, bodyChars: JSON.stringify(body).length }));
    if (args.json) console.log(JSON.stringify({ provider: providerName, mode: "dry-run", plan }, null, 2));
    else {
      console.log(`provider: ${providerName} (${provider.cost})\nplanned requests (dry-run; add --live to execute):`);
      for (const row of plan) console.log(`  ${row.id.padEnd(28)} ${String(row.bodyChars).padStart(8)} body chars  ${row.label}`);
    }
    return;
  }

  const credential = provider.resolveCredential();
  if (!credential) throw new Error(`--live requires credentials: ${provider.credentialHint}`);
  const counts = {};
  for (const request of requests) {
    counts[request.id] = await provider.execute(request.body, credential);
    process.stderr.write(`counted ${request.id}: ${counts[request.id]}\n`);
  }
  if (args.exact) {
    const output = {
      provider: providerName,
      api: provider.api,
      source: provider.exactSource,
      model: args.model ?? payload.model,
      exactTokens: counts.exact,
      capturedPayloadSha256: jsonSha256(payload),
      countRequestSha256: jsonSha256(requests[0].body),
    };
    console.log(args.json ? JSON.stringify(output, null, 2) : `provider-exact captured prompt: ${counts.exact} tokens (${providerName}, model ${output.model})`);
    return;
  }
  const summary = summarizeCounts(requests, counts);
  const suggestion = suggestDenominators(summary);
  if (args.json) {
    console.log(JSON.stringify({ provider: providerName, ...summary, suggestedHeuristic: suggestion }, null, 2));
    return;
  }
  console.log(`\nprovider-exact counts (${providerName}, model ${args.model ?? payload.model}):`);
  console.log(`  ${"section".padEnd(28)} ${"tokens".padStart(8)} ${"marginal".padStart(9)} ${"net".padStart(7)} ${"chars".padStart(9)} ${"chars/tok".padStart(10)}`);
  for (const row of summary.rows) {
    console.log(
      `  ${row.id.padEnd(28)} ${String(row.tokens ?? "-").padStart(8)} ${String(row.marginal ?? "-").padStart(9)}` +
      ` ${String(row.netTokens ?? "-").padStart(7)} ${String(row.chars ?? "-").padStart(9)}` +
      ` ${row.charsPerToken ? row.charsPerToken.toFixed(2).padStart(10) : "-".padStart(10)}`,
    );
  }
  if (summary.toolOverhead !== undefined) {
    console.log(`\n  once-per-request tool-block overhead: ~${summary.toolOverhead} tokens (already removed from 'net' tool rows)`);
  }
  if (Object.keys(suggestion).length > 0) {
    console.log(`\nsuggested contextimate heuristic overrides (settings \u2192 contextimate.rules match for this model):`);
    console.log(`  ${JSON.stringify(suggestion)}`);
  }
  console.log(`\nnote: marginal = section count − baseline; net removes the shared tool-block overhead so small tools are not overstated.`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
