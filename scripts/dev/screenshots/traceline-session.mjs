// Builds the story-shaped fixture session for the traceline README screenshot.
// Everything renders through the real pi TUI via `pi --session <file>` — the transcript
// is crafted, the rendering is not (the point is to demonstrate the real renderer).
import { randomUUID } from "node:crypto";

const pad = (n) => n.toString(16).padStart(8, "0");

export function buildTracelineSession(cwd) {
  const entries = [];
  let seq = 0;
  let parent = null;
  let clock = Date.now() - 8 * 60 * 1000;
  const push = (entry) => {
    const id = pad(++seq);
    clock += 1500 + (seq % 3) * 700;
    entries.push({ ...entry, id, parentId: parent, timestamp: new Date(clock).toISOString() });
    parent = id;
  };
  let cacheSoFar = 11840;
  const msg = (message) => {
    if (message.role === "assistant") {
      const output = 180 + (seq % 4) * 60;
      const cacheWrite = 900 + (seq % 5) * 400;
      const usage = {
        input: 3,
        output,
        cacheRead: cacheSoFar,
        cacheWrite,
        totalTokens: cacheSoFar + cacheWrite + output + 3,
        cost: { input: 0.00003, output: output * 5e-5, cacheRead: cacheSoFar * 1e-6, cacheWrite: cacheWrite * 1.25e-5, total: 0 },
        reasoning: 40,
      };
      usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
      cacheSoFar += cacheWrite;
      message = {
        ...message,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage,
        stopReason: message.content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
      };
    }
    push({ type: "message", message: { ...message, timestamp: clock } });
  };
  const call = (name, args) => ({ type: "toolCall", id: `toolu_${pad(seq)}_${name}${Math.random().toString(36).slice(2, 6)}`, name, arguments: args });
  const result = (toolCall, text, extra = {}) =>
    msg({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text }], isError: false, ...extra });

  const file = (lines, width = 68) =>
    Array.from({ length: lines }, (_, i) => `  ${String(i + 1).padStart(3)}  ${"const section = definePricing({ tier, cadence, seats });".padEnd(width - 8).slice(0, width - 8)}`).join("\n");

  push({ type: "session", version: 3, timestamp: new Date(clock).toISOString(), cwd });
  push({ type: "model_change", provider: "anthropic", modelId: "claude-opus-4-8" });

  msg({
    role: "user",
    content: [{ type: "text", text: "The pricing section on /product reads clunky, and two navbar links 404 (blog + changelog). Can you tighten the copy and fix the nav?" }],
  });

  // Recon: prose owns the margin, then a fused tool block nests under the rail.
  const ls = call("bash", { command: "ls src/pages src/components" });
  const grepNative = call("grep", { pattern: "pricing", path: "src", ignoreCase: true });
  const grepBash = call("bash", { command: "grep -rn 'href=' src/components/NavBar.astro src/components/Footer.astro --include='*.astro' | grep -v 'https://' | head -20" });
  msg({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Two complaints: copy quality on the pricing section, and dead nav links. Map the page structure first, then read the pricing component and the nav." },
      { type: "text", text: "Let me look at how the page is put together." },
      ls, grepNative, grepBash,
    ],
  });
  result(ls, "404.astro\nindex.astro\nproduct.astro\n\nCtaBand.astro\nFooter.astro\nNavBar.astro\nPricingTable.astro\nQuoteWall.astro");
  result(grepNative, Array.from({ length: 26 }, (_, i) => `src/${i % 2 ? "pages/product.astro" : "components/PricingTable.astro"}:${40 + i * 3}:  pricing copy line ${i}`).join("\n"));
  result(grepBash, Array.from({ length: 14 }, (_, i) => `src/components/NavBar.astro:${18 + i}:      <a href="/${["product", "pricing", "blog", "changelog", "contact"][i % 5]}">`).join("\n"));

  const read1 = call("read", { path: `${cwd}/src/pages/product.astro` });
  const read2 = call("read", { path: `${cwd}/src/pages/product.astro`, offset: 180, limit: 180 });
  const read3 = call("read", { path: `${cwd}/src/pages/product.astro`, offset: 360, limit: 180 });
  const readPricing = call("read", { path: `${cwd}/src/components/PricingTable.astro` });
  const readNav = call("read", { path: `${cwd}/src/components/NavBar.astro` });
  msg({ role: "assistant", content: [read1, read2, read3, readPricing, readNav] });
  result(read1, file(180));
  result(read2, file(180));
  result(read3, file(168));
  result(readPricing, file(96));
  result(readNav, file(42));

  // The fix: edits carry their diff facts; the build fails once, honestly.
  const editPage = call("edit", { path: `${cwd}/src/pages/product.astro`, oldText: "…", newText: "…" });
  const editPricing = call("edit", { path: `${cwd}/src/components/PricingTable.astro`, oldText: "…", newText: "…" });
  const editNav = call("edit", { path: `${cwd}/src/components/NavBar.astro`, oldText: "…", newText: "…" });
  const buildFail = call("bash", { command: "npm run build 2>&1 | tail -5", timeout: 120 });
  msg({
    role: "assistant",
    content: [
      { type: "text", text: "The pitch repeats itself three times across the hero and the table, and the nav points at `/blog` and `/changelog` — both retired. Tightening the copy to say it once, and repointing the links." },
      editPage, editPricing, editNav, buildFail,
    ],
  });
  const diff = (plus, minus) =>
    [...Array.from({ length: minus }, (_, i) => `- ${40 + i}   removed line`), ...Array.from({ length: plus }, (_, i) => `+ ${40 + i}   added line`)].join("\n");
  result(editPage, `Successfully replaced 3 block(s) in ${cwd}/src/pages/product.astro.`, { details: { diff: diff(4, 9) } });
  result(editPricing, `Successfully replaced 2 block(s) in ${cwd}/src/components/PricingTable.astro.`, { details: { diff: diff(2, 2) } });
  result(editNav, `Successfully replaced 1 block(s) in ${cwd}/src/components/NavBar.astro.`, { details: { diff: diff(2, 2) } });
  msg({
    role: "toolResult", toolCallId: buildFail.id, toolName: "bash",
    content: [{ type: "text", text: `src/components/PricingTable.astro:96:3: unexpected closing tag </div>\n  94 |     </ul>\n  95 |   </div>\n> 96 |   </div>\nbuild failed in 0.82s` }],
    isError: true,
  });

  const readRange = call("read", { path: `${cwd}/src/components/PricingTable.astro`, offset: 88, limit: 17 });
  const editFix = call("edit", { path: `${cwd}/src/components/PricingTable.astro`, oldText: "…", newText: "…" });
  const buildOk = call("bash", { command: "rm -rf dist && npm run build 2>&1 | tail -3", timeout: 120 });
  const worklog = call("write", { path: `${cwd}/worklog/2026-07-01-pricing-pass.md`, content: "…" });
  msg({
    role: "assistant",
    content: [
      { type: "text", text: "That one's mine — my second edit dropped a wrapper but left its closing tag." },
      readRange, editFix, buildOk, worklog,
    ],
  });
  result(readRange, file(17));
  result(editFix, `Successfully replaced 1 block(s) in ${cwd}/src/components/PricingTable.astro.`, { details: { diff: diff(0, 1) } });
  result(buildOk, "✓ 14 pages built\n✓ sitemap generated\nbuild complete in 1.31s");
  result(worklog, `Wrote ${cwd}/worklog/2026-07-01-pricing-pass.md`, { details: { diff: diff(18, 0) } });

  // Records of consequence (§12.19): commit + push porcelain becomes verb-first facts.
  const ship = call("bash", { command: "git add -A && git commit -m 'product: tighten pricing copy, repoint nav links' && git push", timeout: 120 });
  msg({
    role: "assistant",
    content: [{ type: "text", text: "Green — shipping the pass." }, ship],
  });
  msg({
    role: "toolResult", toolCallId: ship.id, toolName: "bash",
    content: [{ type: "text", text: `[main a4f21c9] product: tighten pricing copy, repoint nav links\n 4 files changed, 25 insertions(+), 14 deletions(-)\nTo github.com:acme/site.git\n   1f0d2a3..a4f21c9  main -> main` }],
    isError: false,
  });

  msg({
    role: "assistant",
    content: [{ type: "text", text: "Done — the pricing section now makes its case once, both nav links resolve, and the pass is on main." }],
  });

  return { id: randomUUID(), entries };
}
