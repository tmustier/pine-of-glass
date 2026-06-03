#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function loadPiCodingAgent() {
  try {
    return await import('@earendil-works/pi-coding-agent');
  } catch {}
  const candidates = [];
  if (process.env.PI_CODING_AGENT_MODULE) candidates.push(process.env.PI_CODING_AGENT_MODULE);
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 });
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    candidates.push(path.join(npmRoot.stdout.trim(), '@earendil-works/pi-coding-agent/dist/index.js'));
    candidates.push(path.join(npmRoot.stdout.trim(), '@earendil-works/pi-coding-agent'));
  }
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {}
  }
  throw new Error('Could not load @earendil-works/pi-coding-agent. Run from a Pi environment or set PI_CODING_AGENT_MODULE=/path/to/dist/index.js.');
}

const {
  parseSessionEntries,
  migrateSessionEntries,
  buildSessionContext,
  convertToLlm,
} = await loadPiCodingAgent();

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
    console.log(`Usage: node scripts/contextimate/evaluate-transcripts.mjs [--root DIR ...] [--output FILE] [--no-dedupe]\n\nEvaluates visible session-growth heuristics against recorded Pi JSONL provider usage.\nThis does not validate static startup prefix/tool schemas because historical sessions do not store provider payloads.`);
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
function safeJson(value) { try { return JSON.stringify(value, null, 2) ?? 'undefined'; } catch (e) { return `[unserializable: ${e?.message ?? String(e)}]`; } }
function countTextContent(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let sum = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') sum += (block.text || '').length;
    else if (block.type === 'image') sum += `[image:${block.mimeType || 'unknown'}:${(block.data || '').length} chars]`.length;
  }
  return sum;
}
function countToolCallContent(block) { return !block || typeof block !== 'object' ? 0 : safeJson({ id: block.id, name: block.name, arguments: block.arguments }).length; }
function countReasoningPayload(value) {
  if (!value) return 0;
  if (typeof value !== 'string') return safeJson(value).length;
  try { return safeJson(JSON.parse(value)).length; } catch { return value.length; }
}
function sessionBreakdownFromMessages(messages) {
  const out = { thinkingChars: 0, toolOutputChars: 0, messageChars: 0, messageCount: messages.length };
  for (const message of convertToLlm(messages)) {
    if (message.role === 'toolResult') { out.toolOutputChars += countTextContent(message.content); continue; }
    if (message.role === 'assistant') {
      for (const block of message.content || []) {
        if (block.type === 'thinking') out.thinkingChars += block.thinkingSignature ? countReasoningPayload(block.thinkingSignature) : (block.thinking || '').length;
        else if (block.type === 'toolCall') out.messageChars += countToolCallContent(block);
        else out.messageChars += countTextContent([block]);
      }
      continue;
    }
    out.messageChars += countTextContent(message.content);
  }
  return out;
}
function sessionChars(b) { return b.thinkingChars + b.toolOutputChars + b.messageChars; }
function inputTokens(usage) { return (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0); }
function currentSessionDenominator(provider, model) {
  const p = (provider || '').toLowerCase();
  const m = (model || '').toLowerCase();
  if (p.includes('anthropic')) {
    if (/claude.*4[-.]?[78]|4[-.]?[78].*claude/.test(m)) return 2.6;
    if (/claude.*4[-.]?[56]|4[-.]?[56].*claude/.test(m)) return 3.5;
    return 3.5;
  }
  return 4;
}
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
function scanModelsAndUsage(entries) {
  const models = []; let usageCount = 0;
  for (const e of entries) {
    if (e.type === 'model_change') models.push([e.provider, e.modelId]);
    if (e.type === 'message' && e.message?.role === 'assistant' && e.message.usage && inputTokens(e.message.usage) > 0) usageCount++;
  }
  const unique = [...new Set(models.map(m => JSON.stringify(m)))].map(s => JSON.parse(s));
  return { unique, usageCount };
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
  if (dedupe) {
    let h; try { h = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'); } catch { h = file; }
    if (seen.has(h)) continue;
    seen.add(h);
  }
  let entries;
  try { entries = parseSessionEntries(fs.readFileSync(file, 'utf8')); migrateSessionEntries(entries); } catch { failed++; continue; }
  const { unique, usageCount } = scanModelsAndUsage(entries);
  if (!usageCount) continue;
  withUsage++;
  if (unique.length !== 1) continue;
  single++;
  const [provider, model] = unique[0];
  const denomCurrent = currentSessionDenominator(provider, model);
  const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
  const rows = [];
  let contextFailures = 0;
  for (const e of entries) {
    if (e.type !== 'message' || !e.message || e.message.role !== 'assistant' || !e.message.usage) continue;
    const actual = inputTokens(e.message.usage);
    if (!(actual > 0)) continue;
    try {
      const ctx = buildSessionContext(entries, e.parentId, byId);
      const br = sessionBreakdownFromMessages(ctx.messages || []);
      const chars = sessionChars(br);
      rows.push({ actual, chars, current: Math.ceil(chars / denomCurrent), single4: Math.ceil(chars / 4) });
    } catch { contextFailures++; }
  }
  if (rows.length < 2) continue;
  results.push({ file, provider, model, denomCurrent, turns: rows.length, contextFailures, current: summarizeRows(rows, 'current'), single4: summarizeRows(rows, 'single4') });
}
const byModel = {};
for (const r of results) (byModel[`${r.provider}/${r.model}`] ||= []).push(r);
const summary = { scanned, withUsage, single, evaluated: results.length, failed, note: 'Static startup prefix/tool schemas are not evaluated; one intercept per transcript absorbs static prefix.', byModel: {} };
for (const [key, arr] of Object.entries(byModel)) {
  summary.byModel[key] = { current: aggregate(arr, 'current'), single4: aggregate(arr, 'single4'), betterCurrentCount: arr.filter(r=>r.current.mae<r.single4.mae).length, betterSingle4Count: arr.filter(r=>r.single4.mae<r.current.mae).length, equalCount: arr.filter(r=>Math.abs(r.current.mae-r.single4.mae)<1e-9).length };
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${output}`);
