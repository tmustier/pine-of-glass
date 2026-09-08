// Hosts an extension the way Pi does: the real factory loader, a real ExtensionRunner,
// real event dispatch, and a recording UI in place of the terminal. Tests written on
// top of it drive the extension only through its public interface (config files, the
// default export, Pi events, commands) and observe only what a user would see
// (notifications, widgets, status, chat lines). See docs/testing.md, "Public interfaces".
//
// The UI is a recorder, not a mock of Pi: nothing here re-implements behaviour under
// test. Two limits, so specs do not over-claim:
// - There is no chat container. Where an extension would append to the chat, its own
//   notify fallback delivers the text into `ui.notifications`; the chat-append path
//   itself (anchoring, re-attachment) is not exercised here.
// - Process-global state (`globalThis.__pi*`) is the one thing the harness cannot
//   isolate. Pi resets it on `session_start` with reason `new`, `resume` or `fork`, so
//   specs for an enabled extension should `start("new")` to be order-independent.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContextActions,
  ExtensionUIContext,
  ResolvedCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import * as pi from "@earendil-works/pi-coding-agent";

import { isJsonObject, type JsonObject } from "../../extensions/_lib/boundary.ts";

type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
type PiExtension = ConstructorParameters<typeof pi.ExtensionRunner>[0][number];
type FactoryLoader = {
  loadExtensionFromFactory: (
    factory: ExtensionFactory,
    cwd: string,
    eventBus: ReturnType<typeof pi.createEventBus>,
    runtime: ReturnType<typeof pi.createExtensionRuntime>,
    extensionPath?: string,
  ) => Promise<PiExtension>;
};
type TerminalListener = Parameters<ExtensionUIContext["onTerminalInput"]>[0];
type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

function isFactoryLoader(module: unknown): module is FactoryLoader {
  return isJsonObject(module) && typeof module.loadExtensionFromFactory === "function";
}

// Pi does not export its factory loader from the package index; the lifecycle contracts
// pin the path. One import here means one place to move when Pi moves it.
async function factoryLoader(): Promise<FactoryLoader> {
  const loader: unknown = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
  if (!isFactoryLoader(loader)) {
    throw new Error("Pi's factory loader moved: tests/harness/extension-host.ts needs the new seam");
  }
  return loader;
}

/** What a user would have seen on an interactive terminal. */
// Pi installs a UI context by spreading it (`{ ...ui }` in ExtensionRunner.setUIContext),
// which keeps only own enumerable properties. Every member below is therefore an own
// property (arrow-function fields), not a prototype method.
export class RecordedUi {
  readonly notifications: Array<{ text: string; type: "info" | "warning" | "error" }> = [];
  readonly statuses = new Map<string, string | undefined>();
  readonly widgets = new Map<string, string[] | (Component & { dispose?(): void })>();
  readonly terminalListeners: TerminalListener[] = [];
  toolsExpanded = true;
  readonly theme = undefined;
  /** The stand-in TUI handed to widget factories; extensions capture it via `captureTui`. */
  readonly tui = { requestRender(): void {} };

  readonly notify = (text: string, type: "info" | "warning" | "error" = "info"): void => {
    this.notifications.push({ text, type });
  };

  readonly setStatus = (key: string, text: string | undefined): void => {
    this.statuses.set(key, text);
  };

  readonly setWidget = (key: string, content: string[] | WidgetFactory | undefined): void => {
    const previous = this.widgets.get(key);
    if (previous !== undefined && !Array.isArray(previous)) previous.dispose?.();
    if (content === undefined) {
      this.widgets.delete(key);
      return;
    }
    if (Array.isArray(content)) {
      this.widgets.set(key, content);
      return;
    }
    // SAFETY: the harness TUI only answers `requestRender`; extensions in this family
    // capture it through `captureTui` and never touch other TUI members outside a
    // real terminal. The theme is deliberately undefined: colour is not under test.
    this.widgets.set(key, content(this.tui as unknown as TUI, undefined as unknown as Theme));
  };

  readonly onTerminalInput = (handler: TerminalListener): (() => void) => {
    this.terminalListeners.push(handler);
    return () => {
      const index = this.terminalListeners.indexOf(handler);
      if (index >= 0) this.terminalListeners.splice(index, 1);
    };
  };

  readonly getToolsExpanded = (): boolean => this.toolsExpanded;

  readonly setToolsExpanded = (expanded: boolean): void => {
    this.toolsExpanded = expanded;
  };

  /** The plain text of a widget as it would render at `width`. */
  widgetLines(key: string, width = 80): string[] | undefined {
    const widget = this.widgets.get(key);
    if (widget === undefined) return undefined;
    return Array.isArray(widget) ? widget : widget.render(width);
  }

  /** Every notification text, in order. */
  get notificationTexts(): string[] {
    return this.notifications.map((entry) => entry.text);
  }
}

/** A throwaway project directory with optional family config files under `.pi/`. */
export class IsolatedProject {
  readonly dir: string;
  readonly home: string;

  constructor() {
    const root = mkdtempSync(join(tmpdir(), "pine-of-glass-host-"));
    this.dir = join(root, "project");
    this.home = join(root, "home");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(join(this.home, ".pi", "agent"), { recursive: true });
  }

  /** Writes `<project>/.pi/<name>.json`, the project-level config the family reads. */
  writeProjectConfig(name: string, config: JsonObject): void {
    mkdirSync(join(this.dir, ".pi"), { recursive: true });
    writeFileSync(join(this.dir, ".pi", `${name}.json`), JSON.stringify(config));
  }

  /** Writes `~/.pi/agent/<name>.json`, the user-level config the family reads. */
  writeUserConfig(name: string, config: JsonObject): void {
    writeFileSync(join(this.home, ".pi", "agent", `${name}.json`), JSON.stringify(config));
  }

  dispose(): void {
    rmSync(dirname(this.dir), { recursive: true, force: true });
  }
}

export type HostOptions = {
  /** Loads with a UI-owning runner (interactive Pi); false hosts a headless SDK-style runner. */
  interactive?: boolean;
  /** Project directory; the family resolves config from `process.cwd()` and `$HOME`.
   * Defaults to a fresh, empty IsolatedProject owned (and disposed) by the host; pass
   * your own when the spec writes config files before hosting, and dispose it yourself. */
  project?: IsolatedProject;
  /** Overrides for the context actions Pi binds; defaults are inert. */
  contextActions?: Partial<ExtensionContextActions>;
  /** The extension path Pi reports; only shows up in diagnostics. */
  name?: string;
};

export class HostedExtension {
  readonly runner: pi.ExtensionRunner;
  readonly ui: RecordedUi;
  /** Errors Pi's runner caught from the extension's handlers; a spec expects none. */
  readonly errors: string[];
  readonly #restoreProcess: () => void;

  constructor(runner: pi.ExtensionRunner, ui: RecordedUi, errors: string[], restoreProcess: () => void) {
    this.runner = runner;
    this.ui = ui;
    this.errors = errors;
    this.#restoreProcess = restoreProcess;
  }

  /** The registered command, or a failing assertion naming what is missing. */
  command(name: string): ResolvedCommand {
    const command = this.runner.getCommand(name);
    if (!command) throw new Error(`the extension did not register /${name}`);
    return command;
  }

  hasCommand(name: string): boolean {
    return this.runner.getCommand(name) !== undefined;
  }

  /** Runs `/name args` through Pi's real command context. */
  async runCommand(name: string, args = ""): Promise<void> {
    await this.command(name).handler(args, this.runner.createCommandContext());
  }

  async start(reason: "startup" | "new" | "resume" | "fork" = "startup"): Promise<void> {
    await this.runner.emit({ type: "session_start", reason });
  }

  async shutdown(): Promise<void> {
    await this.runner.emit({ type: "session_shutdown", reason: "quit" });
  }

  /** Ends the session and restores `process.cwd()` and `$HOME`. Each host restores the
   * values it found, so dispose hosts in reverse order of creation when nesting. */
  async dispose(): Promise<void> {
    try {
      await this.shutdown();
    } finally {
      this.#restoreProcess();
    }
  }
}

/** Loads `factory` through Pi's real loader into a real ExtensionRunner. */
export async function hostExtension(factory: ExtensionFactory, options: HostOptions = {}): Promise<HostedExtension> {
  const loader = await factoryLoader();
  const ownedProject = options.project ? undefined : new IsolatedProject();
  const project = options.project ?? ownedProject!;
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  process.chdir(project.dir);
  process.env.HOME = project.home;
  const restoreProcess = () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    ownedProject?.dispose();
  };

  try {
    const cwd = project.dir;
    const runtime = pi.createExtensionRuntime();
    const extension = await loader.loadExtensionFromFactory(
      factory,
      cwd,
      pi.createEventBus(),
      runtime,
      options.name ?? "pine-of-glass-hosted-extension",
    );
    const modelRegistry = {
      registerProvider(): void {},
      unregisterProvider(): void {},
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    };
    // SAFETY: the runner only reaches the registry members above when an extension
    // registers a provider, which no extension in this family does; the lifecycle
    // contract tests exercise this exact stub against the installed Pi.
    const runner = new pi.ExtensionRunner([extension], runtime, cwd, pi.SessionManager.inMemory(cwd), modelRegistry as never);
    const contextActions: ExtensionContextActions = {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
      ...options.contextActions,
    };
    // SAFETY: the family reads only `getThinkingLevel` from ExtensionActions; the rest of
    // the interface drives Pi's agent loop, which is not running here.
    runner.bindCore({ getThinkingLevel: (): "off" => "off" } as never, contextActions);

    const ui = new RecordedUi();
    if (options.interactive ?? true) {
      // SAFETY: RecordedUi implements the ExtensionUIContext members this family uses
      // (notify, setStatus, setWidget, onTerminalInput, tools-expanded, theme). Dialog and
      // editor members are absent on purpose; calling one is a test failure, not a stub.
      runner.setUIContext(ui as unknown as ExtensionUIContext, "tui");
    }
    const errors: string[] = [];
    runner.onError((error) => errors.push(`${error.event}: ${error.error}`));
    return new HostedExtension(runner, ui, errors, restoreProcess);
  } catch (error) {
    restoreProcess();
    throw error;
  }
}
