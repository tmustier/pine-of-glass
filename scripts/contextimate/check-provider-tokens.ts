#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  DEFAULT_PROVIDER_BY_KIND,
  PROVIDERS,
  parsePayloadFile,
  summarizeCounts,
  type BuildOptions,
  type CountRequest,
  type CountMeasurement,
} from "./provider-token-counts.ts";

type Args = BuildOptions & {
  payload?: string;
  provider?: string;
  full: boolean;
  live: boolean;
  json: boolean;
  help: boolean;
};

const HELP = `Usage: pi-contextimate-check-provider-tokens --payload <file> [options]

Count a captured Pi request with a provider's token-count endpoint.
Without --live, print the request plan without making network calls.

Options:
  --provider <name>  anthropic, openai, google, vertex, bedrock, kimi, cohere or zai
  --model <id>       override the captured model
  --tools <a,b>      limit static-section checks to named tools
  --full             count the complete captured request when supported
  --live             call the provider
  --json             emit JSON
  -h, --help         show help

Live calls require --provider so a compatible wire shape is never sent to the wrong service.
Dry runs infer Anthropic, OpenAI, Gemini or Bedrock when the shape is unambiguous.`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cli: {
      const argv = process.argv.slice(2);
      const args: Args = { full: false, live: false, json: false, help: false };
      for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--payload") args.payload = argv[++index];
        else if (arg === "--provider") args.provider = argv[++index];
        else if (arg === "--tools") args.tools = argv[++index]?.split(",").map((name) => name.trim()).filter(Boolean);
        else if (arg === "--model") args.model = argv[++index];
        else if (arg === "--full") args.full = true;
        else if (arg === "--live") args.live = true;
        else if (arg === "--json") args.json = true;
        else if (arg === "--help" || arg === "-h") args.help = true;
        else throw new Error(`unknown argument: ${arg}`);
      }
      if (args.help || !args.payload) {
        console.log(HELP);
        process.exitCode = args.help ? 0 : 2;
        break cli;
      }

      const { kind, payload } = parsePayloadFile(readFileSync(args.payload, "utf8"));
      const providerName = args.provider ?? (args.live ? undefined : DEFAULT_PROVIDER_BY_KIND[kind]);
      if (!providerName) throw new Error(`pass --provider for ${args.live ? "live calls" : `${kind} payloads`}`);
      const provider = PROVIDERS[providerName];
      if (!provider) throw new Error(`unknown provider: ${providerName}`);
      if (!provider.kinds.includes(kind)) throw new Error(`${providerName} does not accept ${kind} payloads`);
      const buildOptions = { model: args.model, tools: args.tools };
      let requests: CountRequest[];
      if (args.full) {
        if (!provider.full) throw new Error(`${providerName} cannot count a complete captured request`);
        requests = [provider.full(payload, buildOptions)];
      } else {
        requests = provider.build(payload, buildOptions);
      }
      if (!args.live) {
        const data = {
          provider: providerName,
          method: provider.method,
          mode: args.full ? "full" : "sections",
          requests: requests.map(({ id, label, body }) => ({ id, label, bodyChars: JSON.stringify(body).length })),
        };
        if (args.json) console.log(JSON.stringify(data, null, 2));
        else {
          console.log(`${providerName}: ${provider.method}`);
          for (const request of data.requests) console.log(`  ${request.id.padEnd(28)} ${String(request.bodyChars).padStart(8)} chars  ${request.label}`);
          console.log("dry run; add --live to call the provider");
        }
        break cli;
      }

      const measurements: CountMeasurement[] = [];
      for (const { body, ...request } of requests) {
        const tokens = await provider.execute(body);
        measurements.push({ ...request, tokens });
        process.stderr.write(`counted ${request.id}: ${tokens}\n`);
      }
      const model = String(args.model ?? payload.model ?? payload.modelId);

      if (args.full) {
        const data = { provider: providerName, model, inputTokens: measurements[0]!.tokens };
        console.log(args.json ? JSON.stringify(data, null, 2) : `${data.inputTokens} input tokens (${providerName}, ${String(data.model)})`);
        break cli;
      }

      const summary = summarizeCounts(measurements);
      if (args.json) {
        console.log(JSON.stringify({ provider: providerName, model, ...summary }, null, 2));
      } else {
        console.log(`\n${providerName} counts (${model}):`);
        console.log(`  ${"section".padEnd(28)} ${"tokens".padStart(8)} ${"marginal".padStart(9)} ${"net".padStart(7)} ${"chars".padStart(9)} ${"chars/tok".padStart(10)}`);
        for (const row of summary.rows) {
          console.log(
            `  ${row.id.padEnd(28)} ${String(row.tokens).padStart(8)} ${String(row.marginal ?? "-").padStart(9)}`
            + ` ${String(row.netTokens ?? "-").padStart(7)} ${String(row.chars ?? "-").padStart(9)}`
            + ` ${row.charsPerToken ? row.charsPerToken.toFixed(2).padStart(10) : "-".padStart(10)}`,
          );
        }
        if (summary.toolOverhead !== undefined) console.log(`\ntool-block overhead: ${summary.toolOverhead} tokens`);
        if (Object.keys(summary.suggestedHeuristic).length > 0) {
          console.log(`suggested heuristic: ${JSON.stringify(summary.suggestedHeuristic)}`);
        }
      }
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
