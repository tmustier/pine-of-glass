import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import piCachemire from "../../extensions/pi-cachemire/index.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";
import { ANTHROPIC, billed, payload } from "./event-fixtures.ts";

function installModel(session: HostedExtension["session"]) {
  let calls = 0;
  session.agent.streamFunction = async (model, context, options) => {
    await options?.onPayload?.(payload(context.messages.map((m) => JSON.stringify(m))), model);
    const message = calls === 0
      ? billed(ANTHROPIC, 100, 0, 10_000)
      : billed(ANTHROPIC, 100, 10_000 + 100 * calls);
    calls++;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
}

async function setup(cancel: boolean) {
  const project = new IsolatedProject();
  project.writeProjectConfig("settings", { compaction: { enabled: false, keepRecentTokens: 1 } });
  project.writeUserConfig("auth", { anthropic: { type: "api_key", key: "fixture-never-sent" } });
  const events: string[] = [];
  const fixture: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", (event) => {
      events.push(event.type);
      if (cancel) return { cancel: true };
      return { compaction: {
        summary: "A compacted conversation.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } };
    });
    pi.on("session_compact", (event) => { events.push(event.type); });
    pi.on("session_compact_failed", (event) => { events.push(event.type); });
  };
  const host = await hostExtension([piCachemire, fixture], { project, model: ANTHROPIC, reason: "new" });
  installModel(host.session);
  await host.session.prompt("Remember this older conversation. ".repeat(20));
  return { ...host, project, events };
}

test("a cancelled compaction leaves later calls classified as ordinary calls", async () => {
  const host = await setup(true);
  try {
    await assert.rejects(host.session.compact(), /Compaction cancelled/);
    assert.deepEqual(host.events, ["session_before_compact", "session_compact_failed"]);
    await host.session.prompt("Continue normally.");
    await host.session.prompt("And continue once more.");
    await host.session.prompt("/cache");
    const ledger = host.ui.notifications.at(-1)!;
    assert.doesNotMatch(ledger, /summarizer|compaction/, ledger);
    assert.doesNotMatch(host.ui.widgetLines("pi-cachemire")!.join("\n"), /compaction/);
  } finally {
    await host.dispose();
    host.project.dispose();
  }
});

test("/reload keeps the post-compaction warning", async () => {
  const host = await setup(false);
  try {
    await host.session.compact();
    assert.match(host.ui.widgetLines("pi-cachemire")!.join("\n"), /cache stale after compaction/);
    await host.session.reload();
    assert.match(host.ui.widgetLines("pi-cachemire")!.join("\n"), /cache stale after compaction/);
  } finally {
    await host.dispose();
    host.project.dispose();
  }
});

test("reopening a compacted session names compaction as the next call's cause", async () => {
  const first = await setup(false);
  const { project, session } = first;
  let reopened: HostedExtension | undefined;
  try {
    await session.compact();
    await first.dispose();
    reopened = await hostExtension(piCachemire, {
      project, model: ANTHROPIC, sessionManager: session.sessionManager, reason: "resume",
    });
    installModel(reopened.session);
    assert.match(reopened.ui.widgetLines("pi-cachemire")!.join("\n"), /cache stale after compaction/);
    await reopened.session.prompt("Continue after reopening.");
    await reopened.session.prompt("/cache");
    assert.match(reopened.ui.notifications.at(-1)!, /miss.*compaction/);
  } finally {
    if (reopened) await reopened.dispose();
    project.dispose();
  }
});

test("moving to a branch from before the compaction clears the warning", async () => {
  const host = await setup(false);
  try {
    const beforeCompaction = host.session.sessionManager.getLeafId()!;
    await host.session.compact();
    assert.match(host.ui.widgetLines("pi-cachemire")!.join("\n"), /cache stale after compaction/);
    await host.session.navigateTree(beforeCompaction, { summarize: false });
    assert.doesNotMatch(host.ui.widgetLines("pi-cachemire")!.join("\n"), /compaction/);
  } finally {
    await host.dispose();
    host.project.dispose();
  }
});
