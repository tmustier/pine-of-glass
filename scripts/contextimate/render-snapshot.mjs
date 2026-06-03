#!/usr/bin/env node
// Lightweight smoke/snapshot helper: opens Pi in tmux, cycles contextimate views,
// and writes the captured pane to /tmp for manual/CI-ish inspection.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const session = `pi-contextimate-render-${Date.now()}`;
const out = `/tmp/${session}.pane.txt`;
const cwd = process.argv[2] || process.cwd();
function run(args, opts={}) { return spawnSync(args[0], args.slice(1), { encoding:'utf8', ...opts }); }
run(['tmux','new-session','-d','-s',session,`cd ${JSON.stringify(cwd)} && pi --model openai-codex/gpt-5.5 --thinking off`]);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
run(['tmux','send-keys','-t',session,'/contextimate compact','Enter']);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
run(['tmux','send-keys','-t',session,'/contextimate expanded','Enter']);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
const cap = run(['tmux','capture-pane','-p','-t',session,'-S','-500']);
fs.writeFileSync(out, cap.stdout || '');
run(['tmux','send-keys','-t',session,'/exit','Enter']);
run(['tmux','kill-session','-t',session]);
console.log(out);
