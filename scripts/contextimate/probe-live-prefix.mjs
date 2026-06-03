#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let model = 'openai-codex/gpt-5.5';
let cwd = process.cwd();
let outputDir = '/tmp/pi-contextimate-prefix-probe';
let prompt = 'Reply exactly: ok';
let piBin = 'pi';
let extra = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--model') model = args[++i];
  else if (arg === '--cwd') cwd = args[++i];
  else if (arg === '--output-dir') outputDir = args[++i];
  else if (arg === '--prompt') prompt = args[++i];
  else if (arg === '--pi') piBin = args[++i];
  else if (arg === '--') { extra = args.slice(i + 1); break; }
  else if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node scripts/contextimate/probe-live-prefix.mjs [--model PROVIDER/MODEL] [--cwd DIR] [--output-dir DIR] [--prompt TEXT] [-- --extra-pi-flags]\n\nRuns a tiny live Pi request with a payload-capture extension and prints sanitized payload sizes plus provider input usage. Full payload JSON is captured under output-dir; treat it as sensitive.`);
    process.exit(0);
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.mkdirSync(outputDir, { recursive: true });
const base = path.join(outputDir, stamp);
const sessions = `${base}-sessions`;
fs.mkdirSync(sessions, { recursive: true });
const captureExt = new URL('./payload-capture.ts', import.meta.url).pathname;
const cmd = [
  '--model', model,
  '--thinking', 'off',
  '-e', captureExt,
  '--session-dir', sessions,
  '--session-id', `prefix-probe-${stamp}`,
  ...extra,
  '-p', prompt,
];
const env = { ...process.env, PI_CONTEXTIMATE_PAYLOAD_CAPTURE: base };
const proc = spawnSync(piBin, cmd, { cwd, env, encoding: 'utf8', timeout: 180000 });
fs.writeFileSync(`${base}.stdout.txt`, proc.stdout || '');
fs.writeFileSync(`${base}.stderr.txt`, (proc.stderr || '').replace(/npm_[A-Za-z0-9_-]+/g, 'npm_[REDACTED]'));
if (proc.status !== 0) {
  console.error(`pi exited ${proc.status}; see ${base}.stderr.txt`);
  process.exit(proc.status || 1);
}
const payloadPath = `${base}.payloads.jsonl`;
if (!fs.existsSync(payloadPath)) throw new Error(`No payload capture at ${payloadPath}`);
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8').trim().split('\n').at(-1));
let usage;
for (const file of fs.readdirSync(sessions, { recursive: true })) {
  const full = path.join(sessions, file.toString());
  if (!full.endsWith('.jsonl') || !fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const m = o.message || {};
      if (m.role === 'assistant' && m.usage) usage = m.usage;
    } catch {}
  }
}
const inputTotal = usage ? (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : null;
const summary = {
  model,
  cwd,
  artifacts: { base, sessions, payloadPath, stdout: `${base}.stdout.txt`, stderr: `${base}.stderr.txt` },
  payload: {
    keys: Object.keys(payload),
    instructionsChars: typeof payload.instructions === 'string' ? payload.instructions.length : JSON.stringify(payload.instructions ?? '').length,
    inputChars: JSON.stringify(payload.input ?? null).length,
    toolsCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    toolsChars: JSON.stringify(payload.tools ?? []).length,
  },
  usage,
  inputTotal,
};
fs.writeFileSync(`${base}.summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('WARNING: payload captures can contain sensitive prompt/tool data; do not commit output-dir artifacts.');
