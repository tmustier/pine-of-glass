// Hosts an extension through Pi's SDK with a recording UI. See docs/testing.md, "Public interfaces".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  SessionManager,
  type SessionStartEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;

// Pi spreads the UI context, so these members must be own properties.
export class RecordedUi {
  readonly notifications: string[] = [];
  readonly widgets = new Map<string, string[] | Component>();
  readonly theme = undefined;
  readonly tui = { requestRender(): void {} };

  readonly notify = (text: string): void => {
    this.notifications.push(text);
  };

  readonly setWidget = (key: string, content: string[] | WidgetFactory | undefined): void => {
    if (content === undefined) {
      this.widgets.delete(key);
    } else if (Array.isArray(content)) {
      this.widgets.set(key, content);
    } else {
      // SAFETY: the family only calls requestRender on the captured TUI and renders without a theme.
      this.widgets.set(key, content(this.tui as unknown as TUI, undefined as unknown as Theme));
    }
  };

  widgetLines(key: string, width = 80): string[] | undefined {
    const widget = this.widgets.get(key);
    if (widget === undefined) return undefined;
    return Array.isArray(widget) ? widget : widget.render(width);
  }
}

/** A scratch project that owns cwd and HOME until disposed, so every config read stays inside it. */
export class IsolatedProject {
  readonly dir: string;
  readonly home: string;
  readonly #previousCwd = process.cwd();
  readonly #previousHome = process.env.HOME;

  constructor() {
    const root = mkdtempSync(join(tmpdir(), "pine-of-glass-host-"));
    this.dir = join(root, "project");
    this.home = join(root, "home");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    process.chdir(this.dir);
    process.env.HOME = this.home;
  }

  writeProjectConfig(name: string, config: JsonObject): void {
    mkdirSync(join(this.dir, ".pi"), { recursive: true });
    writeFileSync(join(this.dir, ".pi", `${name}.json`), JSON.stringify(config));
  }

  dispose(): void {
    process.chdir(this.#previousCwd);
    if (this.#previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = this.#previousHome;
    rmSync(dirname(this.dir), { recursive: true, force: true });
  }
}

export type HostedExtension = {
  session: AgentSession;
  ui: RecordedUi;
  /** Ends the session and fails if Pi caught an error from any handler. */
  dispose(): Promise<void>;
};

export async function hostExtension(
  factory: ExtensionFactory,
  options: {
    project: IsolatedProject;
    interactive?: boolean;
    reason?: SessionStartEvent["reason"];
    model?: CreateAgentSessionOptions["model"];
    thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
    /** A pre-populated session to resume, as Pi does from a session file. */
    sessionManager?: SessionManager;
  },
): Promise<HostedExtension> {
  const { project, interactive = true, reason = "startup", model, thinkingLevel } = options;
  const cwd = project.dir;
  const agentDir = join(project.home, ".pi", "agent");
  const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [factory] });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length > 0) throw new Error(loadErrors.map((entry) => entry.error).join("\n"));

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
    model,
    thinkingLevel,
    noTools: "all",
    sessionStartEvent: { type: "session_start", reason },
  });
  const ui = new RecordedUi();
  const errors: string[] = [];
  const onError = (error: { event: string; error: string }) => errors.push(`${error.event}: ${error.error}`);
  await session.bindExtensions(
    interactive ? { uiContext: ui as unknown as ExtensionUIContext, mode: "tui", onError } : { mode: "print", onError },
  );

  return {
    session,
    ui,
    async dispose() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      if (errors.length > 0) throw new Error(`Pi caught extension errors:\n${errors.join("\n")}`);
    },
  };
}
