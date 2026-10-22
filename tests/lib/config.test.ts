import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configPaths } from "../../extensions/_lib/config.ts";
import { loadContextimateConfig } from "../../extensions/pi-contextimate/heuristic-config.ts";
import piMeantime from "../../extensions/pi-meantime/index.ts";
import { hostExtension, IsolatedProject } from "../harness/extension-host.ts";

const names = ["pi-contextimate", "pi-traceline", "pi-cachemire", "pi-meantime"];

test("family config paths follow Pi's default, custom and home-relative agent directories", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const project = new IsolatedProject();
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    for (const name of names) {
      assert.deepEqual(configPaths(name, project.dir), [
        join(project.home, ".pi", "agent", `${name}.json`),
        join(project.dir, ".pi", `${name}.json`),
      ]);
    }
    for (const directory of [join(project.home, "custom-agent"), "~/custom-agent"]) {
      process.env.PI_CODING_AGENT_DIR = directory;
      for (const name of names) {
        assert.deepEqual(configPaths(name, project.dir), [
          join(project.home, "custom-agent", `${name}.json`),
          join(project.dir, ".pi", `${name}.json`),
        ]);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    project.dispose();
  }
});

test("custom agent config replaces the default file and keeps project and explicit override precedence", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousExtra = process.env.PI_CONTEXTIMATE_CONFIG;
  const project = new IsolatedProject();
  try {
    const agent = join(project.home, "custom-agent");
    mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    delete process.env.PI_CONTEXTIMATE_CONFIG;
    project.writeUserConfig("pi-contextimate", { defaults: { label: "wrong directory", textDenominator: 99 } });
    writeFileSync(join(agent, "pi-contextimate.json"), JSON.stringify({ defaults: { label: "custom agent" } }));
    assert.deepEqual(loadContextimateConfig(project.dir).defaults, { label: "custom agent" });
    project.writeProjectConfig("pi-contextimate", { defaults: { label: "project" } });
    assert.deepEqual(loadContextimateConfig(project.dir).defaults, { label: "project" });
    const extra = join(project.home, "explicit.json");
    writeFileSync(extra, JSON.stringify({ defaults: { label: "explicit" } }));
    process.env.PI_CONTEXTIMATE_CONFIG = extra;
    assert.deepEqual(loadContextimateConfig(project.dir).defaults, { label: "explicit" });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousExtra === undefined) delete process.env.PI_CONTEXTIMATE_CONFIG;
    else process.env.PI_CONTEXTIMATE_CONFIG = previousExtra;
    project.dispose();
  }
});

test("Meantime enables through the active agent config rather than the default directory", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const project = new IsolatedProject();
  try {
    const agent = join(project.home, "custom-agent");
    mkdirSync(agent);
    process.env.PI_CODING_AGENT_DIR = agent;
    project.writeUserConfig("pi-meantime", { enabled: false });
    writeFileSync(join(agent, "pi-meantime.json"), JSON.stringify({ enabled: true }));
    const host = await hostExtension(piMeantime, { project, reason: "new" });
    try {
      assert.ok(host.session.extensionRunner.getCommand("pace"));
      await host.session.prompt("/pace");
      assert.match(host.ui.notifications[0]!, /no timed model calls yet/);
    } finally {
      await host.dispose();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    project.dispose();
  }
});
