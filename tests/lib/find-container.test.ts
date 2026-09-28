import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { findContainerBy, isAssistantRow, isResourceRow, isToolRow } from "../../extensions/_lib/chat.ts";
import { assistantMessage } from "../helpers.ts";

initTheme(undefined, false);

const hasResourceRow = (children: unknown[]) => children.some(isResourceRow);
const isTranscript = (children: unknown[]) => children.some((child) => isToolRow(child) || isAssistantRow(child));

// Pi's document layout: header, loaded-resource list, then the transcript.
function document(resourceText: string | undefined, transcriptLeaf: Text) {
  const resources = new Container();
  if (resourceText) resources.addChild(new Text(resourceText, 0, 0));
  const transcript = new Container();
  transcript.addChild(new AssistantMessageComponent(assistantMessage([{ type: "text", text: "answer" }]), false));
  transcript.addChild(transcriptLeaf);
  const root = new Container();
  for (const child of [new Container(), resources, transcript]) root.addChild(child);
  return { root, resources };
}

test("a search that skips the transcript does not render it when the resource list is hidden", (t) => {
  // quietStartup leaves the resource list empty, so the search would otherwise render
  // every transcript row before giving up.
  const leaf = new Text("[Skills]\n  quoted by the user", 0, 0);
  const { root } = document(undefined, leaf);
  const render = t.mock.method(leaf, "render");
  assert.equal(findContainerBy(root, hasResourceRow, isTranscript), undefined);
  assert.equal(render.mock.callCount(), 0);
});

test("a search that skips the transcript still finds the resource list", () => {
  const { root, resources } = document("[Skills]\n  alpha, beta", new Text("user text", 0, 0));
  assert.equal(findContainerBy(root, hasResourceRow, isTranscript), resources);
});
