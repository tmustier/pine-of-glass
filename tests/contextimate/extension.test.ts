import { test } from "node:test";
import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";

import piContextimate from "../../extensions/pi-contextimate/index.ts";
import { hostExtension, IsolatedProject, RecordedUi } from "../harness/extension-host.ts";
import { mouseViewport } from "../fixtures/mouse-viewport.ts";
import { plainTheme, stripAnsi } from "../helpers.ts";

test("contextimate commands cycle views and restore one panel after a resource rebuild", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = new IsolatedProject();
  const { view } = mouseViewport();
  const resources = new Container();
  const resourceHeader = new Text("[Context] AGENTS.md", 0, 0);
  resources.addChild(resourceHeader);
  view.addChild(resources);
  t.mock.method(plainTheme, "bold", (text: string) => `<bold>${text}</bold>`);
  const ui = Object.assign(new RecordedUi(plainTheme, view), { setHeader() {} });
  const host = await hostExtension(piContextimate, { project, ui });
  const panelText = () => stripAnsi(resources.render(120).join("\n"));
  try {
    t.mock.timers.tick(1);
    assert.match(panelText(), /\[Contextimate\]/);
    assert.match(panelText(), /<bold>summary<\/bold> → compact → expanded/);
    assert.equal(resources.children[0], resourceHeader, "the panel follows Pi's resource list");

    for (const [command, mode] of [
      ["", "compact"], ["", "expanded"], ["", "summary"],
      [" ExPaNdEd ", "expanded"], ["not-a-mode", "summary"],
    ]) {
      await host.session.prompt(`/contextimate ${command}`);
      t.mock.timers.tick(1);
      assert.equal(ui.notifications.at(-1), `[Contextimate] view: ${mode}`);
      assert.ok(panelText().includes(`<bold>${mode}</bold>`), "the selected view is rendered");
      assert.equal((panelText().match(/\[Contextimate\]/g) ?? []).length, 1);
    }

    resources.clear();
    resources.addChild(resourceHeader);
    ui.widgetLines("__pi_contextimate_capture");
    t.mock.timers.tick(1);
    assert.match(panelText(), /\[Contextimate\]/, "the capture widget restores the dropped panel");
    assert.equal(resources.children.length, 2);
  } finally {
    await host.dispose();
    project.dispose();
  }
});
