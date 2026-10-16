// The record vocabulary format (design language §9.10): entries are plain data, and
// each entry's examples are its specification. This suite runs every built-in example
// through the public records interface and pins how the parser treats bad entries.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN_ENTRIES, parseVocabulary, recordFacts } from "../../extensions/pi-traceline/records.ts";

const labels = (command: string, output: string, error: boolean) =>
  recordFacts({ toolName: "bash", args: { command }, result: { content: [{ type: "text", text: output }], isError: error } })
    .map(({ verb, datum }) => `${verb} ${datum}`);

for (const entry of BUILT_IN_ENTRIES) {
  test(`${entry.id}: every example yields exactly its records`, () => {
    assert.ok(entry.examples.some((example) => example.records.length > 0), "an entry shows at least one record it earns");
    for (const example of entry.examples) {
      assert.deepEqual(labels(example.command, example.output, example.error === true), example.records, example.command);
    }
  });
}

const valid = {
  id: "kubectl.apply",
  commands: ["kubectl apply"],
  unless: ["--dry-run"],
  records: [{ output: String.raw`^(?<name>\S+/\S+) (?:created|configured)$`, verb: "applied", datum: "{name}" }],
  examples: [{ command: "kubectl apply -f web.yaml", output: "deployment.apps/web configured\n", records: ["applied deployment.apps/web"] }],
};

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
  const [entry] = parseVocabulary([{ ...valid, commands: ["git checkout", "git switch"], requires: ["--create", "-b", "-c"] }]).entries;
  assert.deepEqual(entry?.commands, [["git", "checkout"], ["git", "switch"]]);
  assert.deepEqual(entry?.requires, { long: ["--create"], short: "bc" });
  assert.deepEqual(entry?.unless, { long: ["--dry-run"], short: "" });
  assert.deepEqual(entry?.records.map(({ verb, datum, tone, opaque }) => ({ verb, datum, tone, opaque })), [{ verb: "applied", datum: "{name}", tone: "success", opaque: false }]);
});
