# Upstream candidates: potential pi issues

Observations about **pi itself** (not this repo's extensions) collected while building
and live-testing the pine-of-glass family. Each entry records facts and evidence so a
future issue can be written without re-deriving the diagnosis.

> **Process: upstreaming is manual.** Nothing in this file is auto-filed. If we decide
> an entry is worth raising, a human reviews the facts and writes the upstream issue.
> Agents add/update entries here; they do not open issues against pi.

Entries pin the pi version inspected; internals drift, so re-verify before filing.

---

## 1. Doubled `Thinking...` lines when reasoning is hidden (resolved)

**Observed:** Pi 0.79.1 · live sessions, 2026-06-10 · diagnosed in
[pine-of-glass#14](https://github.com/tmustier/pine-of-glass/issues/14)

**Resolved:** Pi 0.80.8 and 0.80.9 emit one collapsed label per adjacent thinking
run. Traceline's installed-Pi contract pins that cardinality and still accepts the
older label-per-block shape.

In Pi 0.79.1, with reasoning hidden (Ctrl+T), `AssistantMessageComponent` rendered
the collapsed `Thinking...` label **once per thinking block, not per message**
(`dist/modes/interactive/components/assistant-message.js`: the content loop emitted
a label for each `thinking` block, with a spacer when more visible content followed).
An assistant message containing adjacent thinking blocks therefore rendered two or
more consecutive `Thinking...` lines with nothing between them.

Frequency evidence from one live session (`019eb262`): **24 instances** of adjacent
thinking blocks within a single assistant message; **0** consecutive thinking-only
messages, so the doubling was intra-message block adjacency (models emitting multiple
reasoning segments per response), not message boundaries.

Two native collapsed labels carried no more information than one; the duplication
was purely an artifact of per-block rendering. Pi adopted the possible upstream
direction and now coalesces an adjacent run into one collapsed label. Traceline
replaces that label with one `<fragment> · <fragment>` preview line.

## 2. Anthropic tool search (`defer_loading`) not wired through pi-ai

**Observed:** pi 0.79.1 (pi-ai anthropic provider) · inspected 2026-06-05 · full notes
in `TOOL-SEARCH-NOTES.local.md` (local-only, gitignored)

Anthropic's tool-search feature lets large tool catalogs be **deferred** out of the
prompt prefix: a search tool + non-deferred tools sit in the prefix, the rest are
discovered on demand and appended inline as `tool_reference` blocks, which are documented
to leave the cached prefix untouched. The SDK pi bundles (`@anthropic-ai/sdk@^0.91.1`)
already has the feature in its **stable** types (`defer_loading`,
`ToolSearchToolResultBlock`).

pi-ai's anthropic provider does not wire it up (evidence:
`pi-ai/dist/providers/anthropic.js`):

1. **Request side**: `convertTools` emits only name/description/schema/cache_control;
   no `defer_loading`, and nothing injects a `tool_search_tool_*` object into
   `params.tools`. pi's internal `ToolInfo` has no deferral concept.
2. **Response side**: the stream parser handles only `text` / `thinking` /
   `redacted_thinking` / `tool_use` block types; `server_tool_use` and
   `tool_search_tool_result` blocks would be silently dropped, so discovery turns
   cannot work even if the params were forced in.
3. **Beta headers**: only fine-grained-tool-streaming and interleaved-thinking are
   sent; no tool-search beta.

Why it matters: pi's existing active/inactive tools mechanism *changes the `tools`
array*, which busts the prompt cache on every toggle. Tool search is the
cache-preserving alternative for sessions carrying large MCP catalogs; the prefix
stays byte-identical while discovery happens in history. Possible upstream direction:
an opt-in flag that marks tools `defer_loading`, injects the search tool, and handles
the two extra stream block types.

## 3. (TBD) Status lines and appended chat children dropped on chat rebuilds

**Observed:** pi 0.79.1 · diagnosed 2026-06-10 while fixing
[pine-of-glass#16](https://github.com/tmustier/pine-of-glass/pull/16) · status: **TBD**,
with no decision yet on whether this is worth raising; it may be intended behaviour.

`toggleThinkingBlockVisibility()` (Ctrl+T) and `rebuildChatFromMessages()` (also used
by compaction and tree navigation) rebuild the chat container from session messages:
`this.chatContainer.clear()` + re-render
(`dist/modes/interactive/interactive-mode.js`). Any child not derived from a session
message is silently dropped, including **pi's own `showStatus` lines** (`/model`
confirmations, toggle notices, etc.) and anything extensions append to the chat
scrollback.

For transient flotsam this is arguably fine, which is why this entry is TBD. The cost
is that (a) a user scrolling back after a Ctrl+T loses status context that was visibly
part of the conversation record, and (b) extensions have no sanctioned way to put a
persistent non-message line into the scrollback; this repo's cachemire now carries its
own anchor/re-attach machinery (hooking the container's `clear()`) purely to survive
these rebuilds, and contextimate independently grew equivalent re-attach logic for its
estimator block. Two extensions re-deriving the same workaround suggests a seam worth
an API. Possible upstream direction: either a documented “persistent chat line”
extension API that survives rebuilds, or rebuilds that preserve/replay status lines at
their original positions.
