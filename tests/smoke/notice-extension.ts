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
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    return block(theme, options.expanded ? [title, "", body] : [`${title} ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`]);
  });
  pi.registerEntryRenderer<{ message?: string }>("fixture-reply", (entry, options, theme) => {
    const title = `${theme.fg("customMessageLabel", theme.bold("[fixture]"))} ${theme.fg("customMessageText", "reply sent to worker")}`;
    return block(theme, options.expanded ? [title, "", entry.data?.message ?? ""] : [`${title} ${theme.fg("dim", "(click to expand)")}`]);
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
