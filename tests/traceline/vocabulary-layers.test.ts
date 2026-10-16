// Vocabulary layers (design language §9.10), hosted through Pi's SDK: the user's and the
// trusted project's pi-traceline.json, and layers other extensions send on Pi's event bus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { ToolRowDataLike } from "../../extensions/_lib/chat.ts";
import piTraceline from "../../extensions/pi-traceline/index.ts";
import { recordFacts } from "../../extensions/pi-traceline/records.ts";
import { VOCABULARY_CHANNEL } from "../../extensions/pi-traceline/vocabulary-layers.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";

const row = (command: string, output: string): ToolRowDataLike => ({
  toolName: "bash",
  args: { command },
  result: { content: [{ type: "text", text: output }], isError: false },
});
const labels = (comp: ToolRowDataLike) => recordFacts(comp).map(({ verb, datum }) => `${verb} ${datum}`);
const apply = () => row("kubectl apply -f web.yaml", "deployment.apps/web configured\n");
const rebase = () => row("git rebase origin/main", "Successfully rebased and updated refs/heads/fix.\n");
const silentMerge = () => row("gh pr merge 120 --squash", "(no output)");

const kubectl = (verb: string) => ({
  id: "kubectl.apply",
  commands: ["kubectl apply"],
  unless: ["--dry-run"],
  records: [{ output: String.raw`^(?<name>\S+/\S+) (?:created|configured)$`, verb, datum: "{name}" }],
  examples: [
    { command: "kubectl apply -f web.yaml", output: "deployment.apps/web configured\n", records: [`${verb} deployment.apps/web`] },
    { command: "kubectl apply -f web.yaml", output: "deployment.apps/web unchanged\n", records: [] },
  ],
});

async function hosted(
  project: IsolatedProject,
  check: (host: HostedExtension) => void | Promise<void>,
  options: { factory?: ExtensionFactory; projectTrusted?: boolean } = {},
): Promise<void> {
  const host = await hostExtension(options.factory ?? piTraceline, { project, projectTrusted: options.projectTrusted });
  try {
    await check(host);
  } finally {
    await host.dispose();
  }
}

test("a user's entry adds a record; without it the row stays plain", async () => {
  const project = new IsolatedProject();
  try {
    await hosted(project, () => assert.deepEqual(labels(apply()), []));
    project.writeUserConfig("pi-traceline", { vocabulary: [kubectl("applied")] });
    await hosted(project, (host) => {
      assert.deepEqual(labels(apply()), ["applied deployment.apps/web"]);
      assert.deepEqual(labels(row("kubectl apply --dry-run=client -f web.yaml", "deployment.apps/web configured\n")), []);
      assert.deepEqual(host.ui.notifications, []);
    });
  } finally {
    project.dispose();
  }
});

test("the project replaces an entry by id and turns built-ins off", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { vocabulary: [kubectl("applied")] });
    project.writeProjectConfig("pi-traceline", { vocabulary: [kubectl("rolled out")], disableVocabulary: ["git.rebase"] });
    await hosted(project, (host) => {
      assert.deepEqual(labels(apply()), ["rolled out deployment.apps/web"]);
      assert.deepEqual(labels(rebase()), []);
      assert.deepEqual(labels(row("git commit -m x", "[main a4f21c9] x\n")), ["committed a4f21c9"]);
      assert.deepEqual(host.ui.notifications, []);
    });
  } finally {
    project.dispose();
  }
});

test("an untrusted project's vocabulary is left out, and the user is told", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { vocabulary: [kubectl("applied")] });
    project.writeProjectConfig("pi-traceline", { vocabulary: [kubectl("rolled out")], disableVocabulary: ["git.rebase"] });
    await hosted(project, (host) => {
      assert.deepEqual(labels(apply()), ["applied deployment.apps/web"]);
      assert.deepEqual(labels(rebase()), ["rebased fix"]);
      assert.deepEqual(host.ui.notifications, ["traceline vocabulary left out:\n.pi/pi-traceline.json: left out: you told Pi not to trust this project"]);
    }, { projectTrusted: false });
  } finally {
    project.dispose();
  }
});

test("a project inside home is named from the project, the user's file from home", async () => {
  const project = new IsolatedProject();
  try {
    process.env.HOME = dirname(project.dir);
    const broken = { ...kubectl("applied"), examples: [] };
    project.writeProjectConfig("pi-traceline", { vocabulary: [broken] });
    mkdirSync(join(dirname(project.dir), ".pi", "agent"), { recursive: true });
    writeFileSync(join(dirname(project.dir), ".pi", "agent", "pi-traceline.json"), JSON.stringify({ vocabulary: [broken] }));
    await hosted(project, (host) => assert.deepEqual(host.ui.notifications, [
      "traceline vocabulary left out:\n~/.pi/agent/pi-traceline.json: kubectl.apply: needs examples\n.pi/pi-traceline.json: kubectl.apply: needs examples",
    ]));
  } finally {
    project.dispose();
  }
});

test("a replacement is data only: a replaced gh.pr.merge no longer reads quiet success", async () => {
  const project = new IsolatedProject();
  try {
    await hosted(project, () => assert.deepEqual(labels(silentMerge()), ["merged PR #120"]));
    const merged = "✓ Squashed and merged pull request o/r#120 (fix)\n";
    project.writeUserConfig("pi-traceline", {
      vocabulary: [{
        id: "gh.pr.merge",
        commands: ["gh pr merge"],
        records: [{ output: String.raw`merged pull request \S*?#(?<number>\d+)`, verb: "landed", datum: "PR #{number}" }],
        examples: [{ command: "gh pr merge 120 --squash", output: merged, records: ["landed PR #120"] }],
      }],
    });
    await hosted(project, () => {
      assert.deepEqual(labels(row("gh pr merge 120 --squash", merged)), ["landed PR #120"]);
      assert.deepEqual(labels(silentMerge()), []);
    });
  } finally {
    project.dispose();
  }
});

test("a problem leaves out only what it touches and is notified with its layer", async () => {
  const project = new IsolatedProject();
  try {
    const misread = { ...kubectl("applied"), id: "kubectl.rollout", examples: [{ ...kubectl("applied").examples[0]!, records: ["applied web"] }] };
    project.writeUserConfig("pi-traceline", { vocabulary: [kubectl("applied"), misread], disableVocabulary: ["git.rebse"] });
    await hosted(project, (host) => {
      assert.deepEqual(labels(apply()), ["applied deployment.apps/web"]);
      assert.deepEqual(labels(rebase()), ["rebased fix"]);
      assert.deepEqual(host.ui.notifications, [[
        "traceline vocabulary left out:",
        "~/.pi/agent/pi-traceline.json: disableVocabulary names no entry: git.rebse",
        "~/.pi/agent/pi-traceline.json: kubectl.rollout: example 1 should yield applied web but yields applied deployment.apps/web",
      ].join("\n")]);
    });
    project.writeUserConfig("pi-traceline", "{ \"vocabulary\": [ ");
    await hosted(project, (host) => {
      assert.deepEqual(labels(rebase()), ["rebased fix"]);
      assert.equal(host.ui.notifications.length, 1);
      assert.match(host.ui.notifications[0]!, /^traceline vocabulary left out:\n~\/\.pi\/agent\/pi-traceline\.json: is not valid JSON \(/);
    });
  } finally {
    project.dispose();
  }
});

/** What another extension sends on traceline's channel. */
type SentLayer = { source?: string; vocabulary?: ReturnType<typeof kubectl>[]; disableVocabulary?: string[] };

// An extension that sends a layer from its session_start handler, before or after
// traceline's own handler runs, and keeps the bus for later messages.
function withSender(order: "before" | "after", layer: SentLayer) {
  let events: ExtensionAPI["events"] | undefined;
  const sender = (pi: ExtensionAPI) => {
    events = pi.events;
    pi.on("session_start", () => pi.events.emit(VOCABULARY_CHANNEL, layer));
  };
  return {
    factory: (pi: ExtensionAPI) => (order === "before" ? [sender, piTraceline] : [piTraceline, sender]).forEach((factory) => factory(pi)),
    bus: () => events!,
  };
}

for (const order of ["before", "after"] as const) {
  test(`another extension's layer applies when it loads ${order} traceline`, async () => {
    const project = new IsolatedProject();
    try {
      const { factory } = withSender(order, { source: "pi-kubectl", vocabulary: [kubectl("synced")] });
      await hosted(project, (host) => {
        assert.deepEqual(labels(apply()), ["synced deployment.apps/web"]);
        assert.deepEqual(host.ui.notifications, []);
      }, { factory });
    } finally {
      project.dispose();
    }
  });
}

test("a later message from the same source replaces its layer; the user's file still wins", async () => {
  const project = new IsolatedProject();
  try {
    const { factory, bus } = withSender("after", { source: "pi-kubectl", vocabulary: [kubectl("synced")], disableVocabulary: ["git.rebase"] });
    await hosted(project, (host) => {
      const comp = apply();
      assert.deepEqual(labels(comp), ["synced deployment.apps/web"]);
      assert.deepEqual(labels(rebase()), []);
      // The same row reads the new layer: a vocabulary change drops cached facts.
      bus().emit(VOCABULARY_CHANNEL, { source: "pi-kubectl", vocabulary: [kubectl("rolled out")] });
      assert.deepEqual(labels(comp), ["rolled out deployment.apps/web"]);
      assert.deepEqual(labels(rebase()), ["rebased fix"]);
      const broken = { source: "pi-kubectl", vocabulary: [{ ...kubectl("synced"), examples: [] }] };
      bus().emit(VOCABULARY_CHANNEL, broken);
      bus().emit(VOCABULARY_CHANNEL, broken);
      bus().emit(VOCABULARY_CHANNEL, { vocabulary: [kubectl("synced")] });
      assert.deepEqual(labels(comp), []);
      assert.deepEqual(host.ui.notifications, [
        "traceline vocabulary left out:\npi-kubectl: kubectl.apply: needs examples",
        "traceline vocabulary left out:\ntraceline:vocabulary: a layer needs a source name",
      ]);
    }, { factory });
    project.writeUserConfig("pi-traceline", { vocabulary: [kubectl("applied")] });
    await hosted(project, () => assert.deepEqual(labels(apply()), ["applied deployment.apps/web"]), { factory });
  } finally {
    project.dispose();
  }
});
