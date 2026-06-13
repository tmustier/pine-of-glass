// Golden renders of all three estimator views. ANSI is stripped and the machine-local
// keybinding hint normalized; what is pinned is row order, wording, alignment, and
// truncation — the things that regress as side effects of unrelated edits.
// Regenerate with UPDATE_GOLDENS=1 npm test and review the diff like code.
import { test } from "node:test";

import { internals } from "../../extensions/pi-contextimate/index.ts";
import type { PrefixSnapshot, ModelSummary } from "../../extensions/pi-contextimate/index.ts";
import {
  expectGolden,
  fakePi,
  fixtureSystemPrompt,
  fixtureSession,
  fixtureContextUsage,
  anthropicModel,
  codexModel,
  plainTheme,
  stripAnsi,
  normalizeKeyHints,
} from "../helpers.ts";

const { buildSnapshot, renderSummary, renderCompact, renderExpanded } = internals;

function fixtureSnapshot(model: ModelSummary): PrefixSnapshot {
  const snapshot = buildSnapshot(
    fakePi(),
    () => fixtureSystemPrompt(),
    undefined,
    () => fixtureContextUsage,
    () => model,
    {},
  );
  snapshot.session = { ...fixtureSession };
  return snapshot;
}

function rendered(lines: string[]): string {
  return normalizeKeyHints(stripAnsi(lines.join("\n")));
}

test("summary view goldens at 80 and 120 columns", () => {
  const snapshot = fixtureSnapshot(anthropicModel);
  expectGolden("contextimate-summary-anthropic-80.txt", rendered(renderSummary(snapshot, plainTheme, 80)));
  expectGolden("contextimate-summary-anthropic-120.txt", rendered(renderSummary(snapshot, plainTheme, 120)));
  expectGolden("contextimate-summary-codex-100.txt", rendered(renderSummary(fixtureSnapshot(codexModel), plainTheme, 100)));
});

test("compact view goldens at 80 and 120 columns", () => {
  const snapshot = fixtureSnapshot(anthropicModel);
  expectGolden("contextimate-compact-anthropic-80.txt", rendered(renderCompact(snapshot, plainTheme, 80)));
  expectGolden("contextimate-compact-anthropic-120.txt", rendered(renderCompact(snapshot, plainTheme, 120)));
  expectGolden("contextimate-compact-codex-100.txt", rendered(renderCompact(fixtureSnapshot(codexModel), plainTheme, 100)));
});

test("expanded view goldens at 80 and 120 columns", () => {
  const snapshot = fixtureSnapshot(anthropicModel);
  expectGolden("contextimate-expanded-anthropic-80.txt", rendered(renderExpanded(snapshot, plainTheme, 80)));
  expectGolden("contextimate-expanded-anthropic-120.txt", rendered(renderExpanded(snapshot, plainTheme, 120)));
  expectGolden("contextimate-expanded-codex-100.txt", rendered(renderExpanded(fixtureSnapshot(codexModel), plainTheme, 100)));
});
