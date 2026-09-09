// Loads an extension through Pi's real loader and runner, with a recording UI.
// See docs/testing.md, "Public interfaces".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import * as pi from "@earendil-works/pi-coding-agent";

import type { JsonObject } from "../../extensions/_lib/boundary.ts";

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
type WidgetFactory = (tui: TUI, theme: Theme) => Component;

const piRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

// Pi spreads the UI context, so these methods must be own properties.
export class RecordedUi {
  readonly notifications: Array<{ text: string; type: "info" | "warning" | "error" }> = [];
  readonly widgets = new Map<string, string[] | Component>();
  readonly theme = undefined;
  readonly tui = { requestRender(): void {} };

  readonly notify = (text: string, type: "info" | "warning" | "error" = "info"): void => {
    this.notifications.push({ text, type });
  };

  readonly setWidget = (key: string, content: string[] | WidgetFactory | undefined): void => {
    if (content === undefined) {
      this.widgets.delete(key);
    } else if (Array.isArray(content)) {
      this.widgets.set(key, content);
    } else {
      // SAFETY: these extensions only call requestRender on the captured TUI. The
      // installed-Pi lifecycle specs exercise this stand-in.
      this.widgets.set(key, content(this.tui as unknown as TUI, undefined as unknown as Theme));
    }
  };

  widgetLines(key: string, width = 80): string[] | undefined {
    const widget = this.widgets.get(key);
    if (widget === undefined) return undefined;
    return Array.isArray(widget) ? widget : widget.render(width);
  }

  get notificationTexts(): string[] {
    return this.notifications.map((entry) => entry.text);
  }
}

export class IsolatedProject {
  readonly dir: string;
  readonly home: string;
  readonly #previousCwd: string;
  readonly #previousHome: string | undefined;

  constructor() {
    const root = mkdtempSync(join(tmpdir(), "pine-of-glass-host-"));
    this.dir = join(root, "project");
    this.home = join(root, "home");
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    this.#previousCwd = process.cwd();
    this.#previousHome = process.env.HOME;
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

export type HostOptions = {
  project: IsolatedProject;
  interactive?: boolean;
};

export class HostedExtension {
  readonly runner: pi.ExtensionRunner;
  readonly ui: RecordedUi;
  readonly #errors: string[];

  constructor(runner: pi.ExtensionRunner, ui: RecordedUi, errors: string[]) {
    this.runner = runner;
    this.ui = ui;
    this.#errors = errors;
  }

  hasCommand(name: string): boolean {
    return this.runner.getCommand(name) !== undefined;
  }

  async runCommand(name: string, args = ""): Promise<void> {
    const command = this.runner.getCommand(name);
    if (!command) throw new Error(`the extension did not register /${name}`);
    await command.handler(args, this.runner.createCommandContext());
  }

  async start(reason: "startup" | "new" | "resume" | "fork" = "startup"): Promise<void> {
    await this.runner.emit({ type: "session_start", reason });
  }

  async dispose(): Promise<void> {
    await this.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (this.#errors.length > 0) {
      throw new Error(`extension runner caught errors:\n${this.#errors.join("\n")}`);
    }
  }
}

export async function hostExtension(factory: ExtensionFactory, options: HostOptions): Promise<HostedExtension> {
  const cwd = options.project.dir;
  const runtime = pi.createExtensionRuntime();
  const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href) as FactoryLoader;
  if (typeof loader.loadExtensionFromFactory !== "function") {
    throw new Error("Pi's factory loader moved: update tests/harness/extension-host.ts");
  }
  const extension = await loader.loadExtensionFromFactory(
    factory,
    cwd,
    pi.createEventBus(),
    runtime,
    "pine-of-glass-hosted-extension",
  );
  const modelRegistry = {
    registerProvider(): void {},
    unregisterProvider(): void {},
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderConfig: () => undefined,
  };
  const runner = new pi.ExtensionRunner([extension], runtime, cwd, pi.SessionManager.inMemory(cwd), modelRegistry as never);
  runner.bindCore({ getThinkingLevel: (): "off" => "off" } as never, {
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
  });

  const ui = new RecordedUi();
  if (options.interactive ?? true) {
    runner.setUIContext(ui as unknown as ExtensionUIContext, "tui");
  }
  const errors: string[] = [];
  runner.onError((error) => errors.push(`${error.event}: ${error.error}`));
  return new HostedExtension(runner, ui, errors);
}
