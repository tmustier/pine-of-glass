#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

let piModule = process.env.PI_CODING_AGENT_MODULE;
if (piModule) {
  piModule = pathToFileURL(piModule).href;
} else {
  try {
    piModule = import.meta.resolve('@earendil-works/pi-coding-agent');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 });
    if (npmRoot.error) throw npmRoot.error;
    assert.equal(npmRoot.status, 0, npmRoot.stderr);
    const requireGlobal = createRequire(path.join(npmRoot.stdout.trim(), 'pog-evaluator.cjs'));
    piModule = pathToFileURL(requireGlobal.resolve('@earendil-works/pi-coding-agent')).href;
  }
}
const { parseSessionEntries, migrateSessionEntries, buildSessionContext, convertToLlm } = await import(piModule);

const args = process.argv.slice(2);
const roots = [];
let output = '/tmp/pi-contextimate-transcript-eval/results.json';
let dedupe = true;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--root') roots.push(args[++i]);
  else if (arg === '--output') output = args[++i];
  else if (arg === '--no-dedupe') dedupe = false;
  else if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node scripts/contextimate/evaluate-transcripts.mjs [--root DIR ...] [--output FILE] [--no-dedupe]\n\nReplays the historical June 2026 session-growth baselines against recorded Pi JSONL provider usage.\nThis does not validate static startup prefix/tool schemas because historical sessions do not store provider payloads.`);
    process.exit(0);
  }
}
if (roots.length === 0) roots.push(path.join(os.homedir(), '.pi/agent/sessions'));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && fs.statSync(p).size > 1024) out.push(p);
  }
  return out;
}
function countTextContent(content) {
  if (typeof content === 'string') return content.length;
  let sum = 0;
  for (const block of content) {
    if (block.type === 'text') sum += (block.text || '').length;
    else if (block.type === 'image') sum += `[image:${block.mimeType || 'unknown'}:${(block.data || '').length} chars]`.length;
  }
  return sum;
}
function inputTokens(usage) { return (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0); }
function median(xs){ if(!xs.length)return null; const a=xs.slice().sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function quantile(xs,q){ if(!xs.length)return null; const a=xs.slice().sort((x,y)=>x-y); const idx=Math.min(a.length-1,Math.max(0,Math.ceil(q*a.length)-1)); return a[idx]; }
function mean(xs){ return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null; }
function summarizeRows(rows, estKey) {
  const diffs = rows.map(r => r.actual - r[estKey]);
  const intercept = median(diffs) || 0;
  const errors = rows.map(r => (intercept + r[estKey]) - r.actual);
  const abs = errors.map(Math.abs);
  const ape = rows.map((r,i) => r.actual > 0 ? Math.abs(errors[i]) / r.actual : 0);
  return { intercept, mae: mean(abs), medianAbs: median(abs), p90Abs: quantile(abs, .9), meanAbsPct: mean(ape), medianAbsPct: median(ape), p90AbsPct: quantile(ape, .9), bias: mean(errors) };
}
function aggregate(groupRows, estimator) {
  const totalTurns = groupRows.reduce((s,r)=>s+r.turns,0);
  return {
    transcripts: groupRows.length,
    turns: totalTurns,
    medianTranscriptMae: median(groupRows.map(r=>r[estimator].mae).filter(Number.isFinite)),
    weightedTurnMae: totalTurns ? groupRows.reduce((s,r)=>s + (r[estimator].mae || 0)*r.turns,0)/totalTurns : null,
    medianTranscriptMape: median(groupRows.map(r=>r[estimator].meanAbsPct).filter(Number.isFinite)),
  };
}
const files = roots.flatMap(root => walk(root));
const results = [];
let scanned = 0, withUsage = 0, single = 0, failed = 0;
const seen = new Set();
for (const file of files) {
  scanned++;
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch { failed++; continue; }
  if (dedupe) {
    const hash = crypto.createHash('sha1').update(source).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
  }
  let entries;
  try { entries = parseSessionEntries(source); migrateSessionEntries(entries); } catch { failed++; continue; }
  const models = []; let usageCount = 0;
  for (const e of entries) {
    if (e.type === 'model_change') models.push([e.provider, e.modelId]);
    if (e.type === 'message' && e.message?.role === 'assistant' && e.message.usage && inputTokens(e.message.usage) > 0) usageCount++;
  }
  const unique = [...new Set(models.map(m => JSON.stringify(m)))].map(s => JSON.parse(s));
  if (!usageCount) continue;
  withUsage++;
  if (unique.length !== 1) continue;
  single++;
  const [provider, model] = unique[0];
  let denomHistorical = 4;
  if (provider.toLowerCase().includes('anthropic')) {
    denomHistorical = /claude.*4[-.]?[78]|4[-.]?[78].*claude/.test(model.toLowerCase()) ? 2.6 : 3.5;
  }
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
  const rows = [];
  let contextFailures = 0;
  for (const e of entries) {
    if (e.type !== 'message' || !e.message || e.message.role !== 'assistant' || !e.message.usage) continue;
    const actual = inputTokens(e.message.usage);
    if (!(actual > 0)) continue;
    try {
      const ctx = buildSessionContext(entries, e.parentId, byId);
      const br = { thinkingChars: 0, toolOutputChars: 0, messageChars: 0, messageCount: ctx.messages.length };
      for (const message of convertToLlm(ctx.messages)) {
        if (message.role === 'toolResult') { br.toolOutputChars += countTextContent(message.content); continue; }
        if (message.role === 'assistant') {
          for (const block of message.content) {
            if (block.type === 'thinking') {
              // Historical baseline only: the current extension never prices opaque signatures as text.
              let text = block.thinkingSignature || block.thinking;
              if (block.thinkingSignature) {
                try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* opaque signature */ }
              }
              br.thinkingChars += text.length;
            } else if (block.type === 'toolCall') br.messageChars += JSON.stringify({ id: block.id, name: block.name, arguments: block.arguments }, null, 2).length;
            else br.messageChars += countTextContent([block]);
          }
          continue;
        }
        br.messageChars += countTextContent(message.content);
      }
      const chars = br.thinkingChars + br.toolOutputChars + br.messageChars;
      rows.push({ actual, chars, historical: Math.ceil(chars / denomHistorical), single4: Math.ceil(chars / 4) });
    } catch { contextFailures++; }
  }
  if (rows.length < 2) continue;
  results.push({ file, provider, model, denomHistorical, turns: rows.length, contextFailures, historical: summarizeRows(rows, 'historical'), single4: summarizeRows(rows, 'single4') });
}
const byModel = {};
for (const r of results) (byModel[`${r.provider}/${r.model}`] ||= []).push(r);
const summary = { scanned, withUsage, single, evaluated: results.length, failed, note: 'Historical June 2026 baselines, not the current estimator. Static startup prefix/tool schemas are not evaluated; one intercept per transcript absorbs static prefix.', byModel: {} };
for (const [key, arr] of Object.entries(byModel)) {
  summary.byModel[key] = { historical: aggregate(arr, 'historical'), single4: aggregate(arr, 'single4'), betterHistoricalCount: arr.filter(r=>r.historical.mae<r.single4.mae).length, betterSingle4Count: arr.filter(r=>r.single4.mae<r.historical.mae).length, equalCount: arr.filter(r=>Math.abs(r.historical.mae-r.single4.mae)<1e-9).length };
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${output}`);
