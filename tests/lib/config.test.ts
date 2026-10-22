import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadContextimateConfig } from "../../extensions/pi-contextimate/heuristic-config.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

test("config follows the active agent directory and preserves override precedence", (t) => {
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousExtra = process.env.PI_CONTEXTIMATE_CONFIG;
  const project = new IsolatedProject();
  t.after(() => {
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousExtra === undefined) delete process.env.PI_CONTEXTIMATE_CONFIG;
    else process.env.PI_CONTEXTIMATE_CONFIG = previousExtra;
    project.dispose();
  });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CONTEXTIMATE_CONFIG;
  project.writeUserConfig("pi-contextimate", { defaults: { label: "default", textDenominator: 99 } });
  assert.equal(loadContextimateConfig(project.dir).defaults?.label, "default");

  const agent = join(project.home, "custom-agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "pi-contextimate.json"), JSON.stringify({ defaults: { label: "custom agent" } }));
  for (const directory of [agent, "~/custom-agent"]) {
    process.env.PI_CODING_AGENT_DIR = directory;
    assert.deepEqual(loadContextimateConfig(project.dir).defaults, { label: "custom agent" });
  }
  project.writeProjectConfig("pi-contextimate", { defaults: { label: "project" } });
  assert.deepEqual(loadContextimateConfig(project.dir).defaults, { label: "project" });
  const extra = join(project.home, "explicit.json");
  writeFileSync(extra, JSON.stringify({ defaults: { label: "explicit" } }));
  process.env.PI_CONTEXTIMATE_CONFIG = extra;
  assert.deepEqual(loadContextimateConfig(project.dir).defaults, { label: "explicit" });
});

test("Meantime enables through the active agent config rather than the default directory", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const project = new IsolatedProject();
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    project.dispose();
  });
  const agent = join(project.home, "custom-agent");
  mkdirSync(agent);
  process.env.PI_CODING_AGENT_DIR = agent;
  project.writeUserConfig("pi-meantime", { enabled: false });
  writeFileSync(join(agent, "pi-meantime.json"), JSON.stringify({ enabled: true }));
  const host = await hostExtension(piMeantime, { project, reason: "new" });
  try {
    assert.ok(host.session.extensionRunner.getCommand("pace"), "the custom config must enable /pace");
    await host.session.prompt("/pace");
    assert.match(host.ui.notifications[0]!, /no timed model calls yet/);
  } finally {
    await host.dispose();
  }
});
