// The record vocabulary format (design language §9.10): entries are plain data, and an
// entry loads only when each of its examples yields exactly its records with the entry
// alone. The built-ins pass that check when records.ts loads; this suite pins what the
// check accepts and how the parser treats bad entries.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN_ENTRIES, parseVocabulary } from "../../extensions/pi-traceline/records.ts";
import { BUILT_IN_VOCABULARY } from "../../extensions/pi-traceline/vocabulary.ts";

test("every built-in entry loads, so every built-in example holds", () => {
  assert.deepEqual(BUILT_IN_ENTRIES.map(({ id }) => id), BUILT_IN_VOCABULARY.map(({ id }) => id));
});

test("built-in code does not travel with an entry's data", () => {
  // The same data without the built-ins' code fails exactly the examples code proves:
  // the remote on a deletion, quiet success and observed state, a decoded tag.
  const { entries, problems } = parseVocabulary(BUILT_IN_VOCABULARY);
  assert.deepEqual(problems.map((problem) => problem.split(":")[0]), ["git.push.delete", "git.worktree.remove", "gh.pr.merge", "gh.release.create"]);
  assert.equal(entries.length, BUILT_IN_VOCABULARY.length - 4);
});

const valid = {
  id: "kubectl.apply",
  commands: ["kubectl apply"],
  unless: ["--dry-run"],
  records: [{ output: String.raw`^(?<name>\S+/\S+) (?:created|configured)$`, verb: "applied", datum: "{name}" }],
  examples: [
    { command: "kubectl apply -f web.yaml", output: "deployment.apps/web configured\n", records: ["applied deployment.apps/web"] },
    { command: "kubectl apply -f web.yaml", output: "deployment.apps/web unchanged\n", records: [] },
    { command: "kubectl apply --dry-run=client -f web.yaml", output: "deployment.apps/web configured (dry run)\n", records: [] },
  ],
};

test("an entry loads only when each example yields exactly its records", () => {
  const loaded = parseVocabulary([valid]);
  assert.deepEqual([loaded.entries.map(({ id }) => id), loaded.problems], [["kubectl.apply"], []]);
  const wrongDatum = { ...valid, id: "wrong.datum", records: [{ ...valid.records[0], datum: "web" }] };
  const tooEager = { ...valid, id: "too.eager", records: [{ ...valid.records[0], output: String.raw`^(?<name>\S+/\S+) \w+$` }] };
  const noDryRun = { ...valid, id: "no.dry.run", unless: [], records: [{ ...valid.records[0], output: String.raw`^(?<name>\S+/\S+) (?:created|configured)` }] };
  const onlyNearMisses = { ...valid, id: "only.near.misses", examples: valid.examples.slice(1) };
  assert.deepEqual(parseVocabulary([wrongDatum, tooEager, noDryRun, onlyNearMisses]), {
    entries: [],
    problems: [
      "wrong.datum: example 1 should yield applied deployment.apps/web but yields applied web",
      "too.eager: example 2 should yield nothing but yields applied deployment.apps/web",
      "no.dry.run: example 3 should yield nothing but yields applied deployment.apps/web",
      "only.near.misses: needs an example that yields a record",
    ],
  });
});

test("a bad entry is reported and left out whole; the rest still parse", () => {
  const { entries, problems } = parseVocabulary([
    valid,
    { ...valid, id: "kubectl.apply" },
    { ...valid, id: "bad.pattern", records: [{ output: "(unclosed", verb: "applied", datum: "x" }] },
    { ...valid, id: "bad.datum", records: [{ ...valid.records[0], datum: "{missing}" }] },
    { ...valid, id: "bad.option", unless: ["dry-run"] },
    { ...valid, id: "bad.tone", records: [{ ...valid.records[0], tone: "error" }] },
    { ...valid, id: "no.examples", examples: [] },
    { ...valid, id: "no.commands", commands: [] },
    { ...valid, id: undefined },
  ]);
  assert.deepEqual(entries.map((entry) => entry.id), ["kubectl.apply"]);
  assert.deepEqual(problems.map((problem) => problem.split(":")[0]), [
    "kubectl.apply",
    "bad.pattern",
    "bad.datum",
    "bad.option",
    "bad.tone",
    "no.examples",
    "no.commands",
    "entry 9",
  ]);
  assert.match(problems[2]!, /\{missing\} names no group/);
  assert.deepEqual(parseVocabulary({ entries: [valid] }), { entries: [], problems: ["vocabulary must be a list of entries"] });
});

test("a parsed entry keeps its commands, options and rules", () => {
  const [entry] = parseVocabulary([{ ...valid, commands: ["kubectl apply", "kubectl create"], requires: ["--filename", "-f", "-k"] }]).entries;
  assert.deepEqual(entry?.commands, [["kubectl", "apply"], ["kubectl", "create"]]);
  assert.deepEqual(entry?.requires, { long: ["--filename"], short: "fk" });
  assert.deepEqual(entry?.unless, { long: ["--dry-run"], short: "" });
  assert.deepEqual(entry?.records.map(({ verb, datum, tone, opaque }) => ({ verb, datum, tone, opaque })), [{ verb: "applied", datum: "{name}", tone: "success", opaque: false }]);
  assert.equal(entry?.code, undefined);
});
