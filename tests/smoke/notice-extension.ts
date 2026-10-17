// Traceline plus the renderers an extension such as pi-subagents registers: a message
// renderer whose collapsed line carries a bold label, a status word in warning ink and
// Pi's key hint, and an entry renderer in the same shape. A second message type has no
// renderer at all, so Pi's default block stands in. /notice sends one of each live.
import { keyText, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import piTraceline from "../../extensions/pi-traceline/index.ts";

function block(theme: Theme, lines: string[]): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export default function noticeFixture(pi: ExtensionAPI): void {
  piTraceline(pi);
  pi.registerMessageRenderer("fixture-request", (message, options, theme) => {
    const title = `${theme.fg("customMessageLabel", theme.bold("[fixture]"))} ${theme.fg("customMessageText", "worker ")}${theme.fg("warning", "needs a decision")}`;
    const body = typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    return block(theme, options.expanded ? [title, "", body] : [`${title} ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`]);
  });
  pi.registerEntryRenderer("fixture-reply", (entry, options, theme) => {
    const data = entry.data as { message?: string } | undefined;
    const title = `${theme.fg("customMessageLabel", theme.bold("[fixture]"))} ${theme.fg("customMessageText", "reply sent to worker")}`;
    return block(theme, options.expanded ? [title, "", data?.message ?? ""] : [`${title} ${theme.fg("dim", "(click to expand)")}`]);
  });
  pi.registerCommand("notice", {
    description: "send a live fixture notice and append a live fixture entry",
    handler: async (_args, ctx) => {
      pi.sendMessage({ customType: "fixture-request", content: "LIVE_REQUEST_BODY", display: true }, { triggerTurn: false });
      pi.appendEntry("fixture-reply", { message: "LIVE_REPLY_BODY" });
      ctx.ui.notify("NOTICE_SENT");
    },
  });
}
