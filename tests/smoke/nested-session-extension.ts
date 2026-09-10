// Traceline plus /child: a headless Pi session in the parent's process that loads
// Traceline again, the way a subagent child does, then ends.
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import piTraceline from "../../extensions/pi-traceline/index.ts";

export default function nestedSessionFixture(pi: ExtensionAPI): void {
  piTraceline(pi);
  pi.registerCommand("child", {
    description: "run a headless child session that loads Traceline",
    handler: async (_args, ctx) => {
      const cwd = process.cwd();
      const agentDir = getAgentDir();
      const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [piTraceline] });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        noTools: "all",
      });
      await session.bindExtensions({ mode: "print" });
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      ctx.ui.notify("CHILD_DONE");
    },
  });
}
