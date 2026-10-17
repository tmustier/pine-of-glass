// Request accounting through Pi's SDK and the summaries' public request interface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isJsonObject } from "../../extensions/_lib/boundary.ts";
import piTraceline from "../../extensions/pi-traceline/index.ts";
import { gistFor } from "../../extensions/pi-traceline/summaries.ts";
import { summaryCostStatus, SUMMARY_ENTRY, SUMMARY_USAGE_ENTRY } from "../../extensions/pi-traceline/summary-usage.ts";
import { hostExtension, IsolatedProject, type HostedExtension } from "../harness/extension-host.ts";
import { assistantMessage, expectGolden } from "../helpers.ts";
import { PROVIDER, REPORTED_USAGE, summaryModel, type Asked } from "./summary-fixtures.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

async function withSummaries(reply: string | Error | undefined, check: (host: HostedExtension, asked: Asked[][]) => Promise<void>) {
  const project = new IsolatedProject();
  const asked: Asked[][] = [];
  project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
  const host = await hostExtension((pi) => {
    summaryModel(pi, asked, reply);
    piTraceline(pi);
  }, { project });
  try { await check(host, asked); }
  finally { await host.dispose(); project.dispose(); }
}

for (const { label, reply, saved } of [
  { label: "a complete batch", reply: undefined, saved: 2 },
  { label: "a partial batch", reply: '{"1":"one useful gist"}', saved: 1 },
  { label: "an unparsable reply", reply: "not JSON", saved: 0 },
]) {
  test(`${label} records the full request usage once, outside Pi's total`, async () => {
    await withSummaries(reply, async (host, asked) => {
      host.session.sessionManager.appendMessage(assistantMessage([{ type: "text", text: "An earlier agent response." }], { usage: REPORTED_USAGE }));
      const nativeCost = host.session.getSessionStats().cost;
      assert.equal(host.ui.statuses.get("traceline-summaries"), undefined);
      gistFor("command", "first command", true);
      gistFor("thinking", "second item", true);
      await settle();
      assert.equal(asked.length, 1);
      assert.equal(asked[0]?.length, 2);
      assert.equal(host.ui.statuses.get("traceline-summaries"), "summaries $0.013 extra");
      assert.equal(host.session.getSessionStats().cost, nativeCost, "Traceline must not change Pi's own total");
      const entries = host.session.sessionManager.getEntries();
      const requests = entries.filter((entry) => entry.type === "custom" && entry.customType === SUMMARY_USAGE_ENTRY);
      assert.equal(requests.length, 2, "one started and one reported record describe the whole batch");
      assert.ok(requests[0]?.type === "custom" && isJsonObject(requests[0].data));
      assert.ok(requests[1]?.type === "custom" && isJsonObject(requests[1].data));
      assert.equal(requests[0].data.phase, "started");
      assert.equal(requests[1].data.phase, "reported");
      assert.equal(requests[1].data.stopReason, "stop");
      assert.equal(requests[1].data.requestId, requests[0].data.requestId);
      assert.equal(requests[1].data.model, `${PROVIDER}/gist`);
      assert.equal(requests[1].data.items, 2);
      assert.deepEqual(requests[1].data.usage, REPORTED_USAGE);
      const gists = entries.filter((entry) => entry.type === "custom" && entry.customType === SUMMARY_ENTRY);
      assert.equal(gists.length, saved);
      for (const gist of gists) {
        assert.ok(gist.type === "custom" && isJsonObject(gist.data));
        assert.equal(gist.data.requestId, requests[1].data.requestId);
        assert.equal(gist.data.cost, undefined, "a gist must not allocate or duplicate the request's cost");
      }
    });
  });
}

for (const hasTokens of [true, false]) {
  test(`a usable zero-cost reply ${hasTokens ? "with token evidence records a known zero" : "without usage evidence keeps its cost unknown"}`, async () => {
    const project = new IsolatedProject();
    try {
      project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
      const asked: Asked[][] = [];
      const usage = {
        ...(hasTokens ? REPORTED_USAGE : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const host = await hostExtension((pi) => { summaryModel(pi, asked, undefined, 0, usage); piTraceline(pi); }, { project });
      try {
        gistFor("command", "a usable reply", true);
        await settle();
        assert.equal(gistFor("command", "a usable reply", true), "gist 1", "accounting must not discard a usable gist");
        assert.equal(host.ui.statuses.get("traceline-summaries"), hasTokens ? "summaries $0.000 extra" : "summaries cost unknown (extra)");
      } finally { await host.dispose(); }
    } finally { project.dispose(); }
  });
}

test("a transport failure without reported usage remains unknown and is not retried", async () => {
  await withSummaries(new Error("fixture transport failure"), async (host, asked) => {
    gistFor("command", "a failed request", true);
    await settle();
    assert.equal(host.ui.statuses.get("traceline-summaries"), "summaries cost unknown (extra)");
    assert.equal(gistFor("command", "a failed request", true), undefined);
    await settle();
    assert.equal(asked.length, 1);
    const requests = host.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUMMARY_USAGE_ENTRY);
    assert.equal(requests.length, 1);
    assert.ok(requests[0]?.type === "custom" && isJsonObject(requests[0].data));
    assert.equal(requests[0].data.phase, "started");
  });
});

for (const model of [false, "missing-provider/missing-model"]) {
  test(`saved request costs restore without new calls when summaries are ${model === false ? "disabled" : "unavailable"}`, async () => {
    const project = new IsolatedProject();
    try {
      project.writeUserConfig("pi-traceline", { summaries: model === false ? false : { model } });
      const sessionManager = SessionManager.inMemory(project.dir);
      const request = { requestId: "old-request", model: `${PROVIDER}/gist`, items: 2 };
      sessionManager.appendCustomEntry(SUMMARY_USAGE_ENTRY, { ...request, phase: "started" });
      sessionManager.appendCustomEntry(SUMMARY_USAGE_ENTRY, { ...request, phase: "reported", usage: REPORTED_USAGE });
      sessionManager.appendCustomEntry(SUMMARY_ENTRY, { key: "command:old", gist: "a saved gist", requestId: request.requestId });
      const asked: Asked[][] = [];
      const host = await hostExtension((pi) => { summaryModel(pi, asked); piTraceline(pi); }, { project, sessionManager });
      try {
        assert.equal(host.ui.statuses.get("traceline-summaries"), "summaries $0.013 extra");
        await settle();
        assert.deepEqual(asked, []);
        assert.equal(sessionManager.getEntries().filter((entry) => entry.type === "custom").length, 3);
      } finally { await host.dispose(); }
      assert.equal(host.ui.statuses.get("traceline-summaries"), undefined);
    } finally { project.dispose(); }
  });
}

test("a new session clears its predecessor's cost and cannot receive a late bill", async () => {
  const project = new IsolatedProject();
  try {
    project.writeUserConfig("pi-traceline", { summaries: { model: `${PROVIDER}/gist` } });
    const asked: Asked[][] = [];
    const host = await hostExtension((pi) => { summaryModel(pi, asked, undefined, 300); piTraceline(pi); }, { project });
    try {
      gistFor("command", "a request from the previous session", true);
      await new Promise((resolve) => setTimeout(resolve, 280));
      assert.equal(asked.length, 1);
      assert.equal(host.ui.statuses.get("traceline-summaries"), "summaries cost unknown (extra)");
      host.session.sessionManager.newSession();
      await host.session.extensionRunner.emit({ type: "session_start", reason: "new" });
      await settle();
      assert.equal(host.ui.statuses.get("traceline-summaries"), undefined);
      assert.deepEqual(host.session.sessionManager.getEntries().filter((entry) => entry.type === "custom"), []);
    } finally { await host.dispose(); }
  } finally { project.dispose(); }
});

test("summary cost status preserves uncertainty, tiny charges and whole-file costs", () => {
  const session = SessionManager.inMemory();
  const shown: string[] = [];
  assert.equal(summaryCostStatus(session.getEntries()), undefined);
  for (const { label, cost } of [{ label: "known", cost: 0.0127 }, { label: "tiny", cost: 0.00002 }, { label: "reported zero", cost: 0 }]) {
    session.newSession();
    session.appendCustomEntry(SUMMARY_USAGE_ENTRY, { requestId: label, phase: "reported", usage: { ...REPORTED_USAGE, cost: { ...REPORTED_USAGE.cost, total: cost } } });
    shown.push(`${label}: ${summaryCostStatus(session.getEntries())}`);
  }
  session.newSession();
  session.appendCustomEntry(SUMMARY_ENTRY, { key: "old", gist: "legacy gist", cost: 0.004 });
  shown.push(`legacy shares: ${summaryCostStatus(session.getEntries())}`);
  session.appendCustomEntry(SUMMARY_USAGE_ENTRY, { requestId: "new", phase: "reported", usage: REPORTED_USAGE });
  session.appendCustomEntry(SUMMARY_ENTRY, { key: "new", gist: "new gist", requestId: "new", cost: 0.0127 });
  shown.push(`mixed old and new: ${summaryCostStatus(session.getEntries())}`);
  session.newSession();
  session.appendCustomEntry(SUMMARY_USAGE_ENTRY, { requestId: "unknown", phase: "started" });
  shown.push(`unreported: ${summaryCostStatus(session.getEntries())}`);
  session.appendCustomEntry(SUMMARY_USAGE_ENTRY, { requestId: "unknown", phase: "reported", usage: { cost: { total: null } } });
  assert.equal(summaryCostStatus(session.getEntries()), "summaries cost unknown (extra)");
  session.newSession();
  const root = session.appendCustomEntry("unrelated", {});
  session.appendCustomEntry(SUMMARY_USAGE_ENTRY, { requestId: "abandoned", phase: "reported", usage: REPORTED_USAGE });
  session.branch(root);
  session.appendCustomEntry(SUMMARY_USAGE_ENTRY, { requestId: "active", phase: "reported", usage: REPORTED_USAGE });
  shown.push(`including abandoned branch: ${summaryCostStatus(session.getEntries())}`);
  expectGolden("traceline-summary-costs.txt", shown.join("\n"));
});
