import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { hostExtension, IsolatedProject } from "./extension-host.ts";

const emptyExtension = (_pi: ExtensionAPI): void => {};

test("hosts sharing one project retain its environment until the last disposal", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const project = new IsolatedProject();
  const observedCwds: string[] = [];
  const parent = await hostExtension((pi) => {
    pi.on("session_start", () => { observedCwds.push(process.cwd()); });
  }, { project });
  const child = await hostExtension(emptyExtension, { project, interactive: false });

  try {
    await parent.start();
    assert.deepEqual(observedCwds, [realpathSync(project.dir)]);
    await parent.dispose();
    assert.equal(process.cwd(), realpathSync(project.dir), "a remaining child must retain the shared environment");
    assert.equal(process.env.HOME, project.home);
  } finally {
    try {
      await child.dispose();
    } finally {
      try {
        await parent.dispose();
      } finally {
        project.dispose();
      }
    }
  }

  assert.equal(process.cwd(), previousCwd);
  assert.equal(process.env.HOME, previousHome);
});

test("concurrent hosts reject a different project before changing the active environment", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const firstProject = new IsolatedProject();
  const secondProject = new IsolatedProject();
  let first: Awaited<ReturnType<typeof hostExtension>> | undefined;
  try {
    const pendingFirst = hostExtension(emptyExtension, { project: firstProject });
    await assert.rejects(
      hostExtension(emptyExtension, { project: secondProject }),
      /different IsolatedProject/,
    );
    assert.equal(process.cwd(), realpathSync(firstProject.dir));
    assert.equal(process.env.HOME, firstProject.home);
    first = await pendingFirst;
  } finally {
    try {
      await first?.dispose();
    } finally {
      firstProject.dispose();
      secondProject.dispose();
    }
  }
  assert.equal(process.cwd(), previousCwd);
  assert.equal(process.env.HOME, previousHome);
});

test("factory failure releases ownership, restores globals, and removes its owned fixture", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  let ownedRoot: string | undefined;

  await assert.rejects(hostExtension(() => {
    ownedRoot = dirname(process.cwd());
    throw new Error("factory failed");
  }), /factory failed/);

  assert.equal(process.cwd(), previousCwd);
  assert.equal(process.env.HOME, previousHome);
  assert.ok(ownedRoot);
  assert.equal(existsSync(ownedRoot), false);

  // A failed host must not leave stale ownership behind.
  const project = new IsolatedProject();
  const host = await hostExtension(emptyExtension, { project });
  await host.dispose().finally(() => project.dispose());
});

test("dispose restores the environment and reports errors caught during shutdown", async () => {
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  let ownedRoot: string | undefined;
  const host = await hostExtension((pi) => {
    ownedRoot = dirname(process.cwd());
    pi.on("session_shutdown", () => { throw new Error("shutdown handler failed"); });
  });

  await assert.rejects(host.dispose(), /extension runner caught errors:[\s\S]*shutdown handler failed/);
  assert.equal(process.cwd(), previousCwd);
  assert.equal(process.env.HOME, previousHome);
  assert.ok(ownedRoot);
  assert.equal(existsSync(ownedRoot), false);
});
