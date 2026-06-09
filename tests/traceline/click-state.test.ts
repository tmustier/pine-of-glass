// The one-shot click state machine — the safety property behind keeping clicks off by
// default (issue #7): arming must be temporary, and *every* path out of an armed state
// must end with mouse reporting disabled so terminal scrolling is never left captured.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { internals } from "../../extensions/pi-traceline/index.ts";

const { setClickHandling, armClickOnce, shouldEnableClicks } = internals;

const g = globalThis as Record<string, unknown>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Mouse-reporting escapes are only written on a TTY. Fake a TTY and intercept exactly the
// mouse-reporting sequences so we can observe enable/disable without polluting test output.
let written: string[] = [];
let originalWrite: typeof process.stdout.write;
let originalIsTTY: boolean | undefined;

before(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  originalIsTTY = process.stdout.isTTY;
  (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith("\x1b[?10")) {
      written.push(chunk);
      return true;
    }
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
});

after(() => {
  process.stdout.write = originalWrite;
  (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = originalIsTTY;
  setClickHandling(false);
});

beforeEach(() => {
  setClickHandling(false);
  written = [];
  delete process.env.PI_TRACELINE_CLICK;
});

const ENABLE = "\x1b[?1000h\x1b[?1006h";
const DISABLE = "\x1b[?1000l\x1b[?1006l";

test("clicks are off by default without the opt-in env", () => {
  g.__tracelineClickEnabled = undefined;
  assert.equal(shouldEnableClicks(), false);
});

test("PI_TRACELINE_CLICK=1 opts into persistent clicks at first evaluation", () => {
  g.__tracelineClickEnabled = undefined;
  process.env.PI_TRACELINE_CLICK = "1";
  assert.equal(shouldEnableClicks(), true);
});

test("arming a one-shot enables reporting; disarming always disables it", () => {
  armClickOnce(60_000);
  assert.equal(shouldEnableClicks(), true);
  assert.equal(g.__tracelineClickOneShot, true);
  assert.deepEqual(written, [ENABLE]);

  setClickHandling(false);
  assert.equal(shouldEnableClicks(), false);
  assert.equal(g.__tracelineClickOneShot, false);
  assert.deepEqual(written, [ENABLE, DISABLE]);
});

test("one-shot TTL expiry disarms and releases the terminal", async () => {
  armClickOnce(30);
  assert.equal(shouldEnableClicks(), true);
  await sleep(90);
  assert.equal(shouldEnableClicks(), false, "TTL must disarm the one-shot");
  assert.deepEqual(written, [ENABLE, DISABLE]);
});

test("re-arming resets the pending TTL instead of stacking timers", async () => {
  armClickOnce(30);
  armClickOnce(120);
  await sleep(70); // first TTL would have fired by now
  assert.equal(shouldEnableClicks(), true, "second arm must supersede the first TTL");
  await sleep(100);
  assert.equal(shouldEnableClicks(), false);
});

test("persistent mode stays on until explicitly disabled", async () => {
  setClickHandling(true);
  assert.equal(shouldEnableClicks(), true);
  assert.equal(g.__tracelineClickOneShot, false);
  await sleep(50);
  assert.equal(shouldEnableClicks(), true, "no TTL in persistent mode");
  setClickHandling(false);
  assert.deepEqual(written, [ENABLE, DISABLE]);
});

test("enable is idempotent: no duplicate escape writes while already armed", () => {
  armClickOnce(60_000);
  armClickOnce(60_000);
  setClickHandling(true);
  assert.deepEqual(written, [ENABLE], "reporting must be enabled exactly once");
  setClickHandling(false);
});
