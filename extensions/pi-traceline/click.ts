import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripAnsi } from "../_lib/ansi.ts";
import type { ToolRowDataLike, ToolRowLike, ToolRowPrototypeLike } from "../_lib/chat.ts";
import { drillState } from "./drill.ts";

// View-only fold state. Output expansion always belongs to Pi's setExpanded().
let revealed = new WeakMap<ToolRowDataLike, ToolRowLike[]>();
export function resetRevealedFolds(): void { revealed = new WeakMap(); }
export function isRevealed(comp: ToolRowDataLike): boolean { return revealed.has(comp); }
export function revealedBullet(comp: ToolRowDataLike | undefined): string | undefined {
  return comp && revealed.get(comp)?.[0] === comp ? "▾" : undefined;
}

interface TraceMouseHost {
  bulletColumn: number;
  isCompact: (row: ToolRowLike) => boolean;
  renderTrace: (row: ToolRowLike, width: number) => string[];
  decorateNative: (row: ToolRowLike, lines: unknown) => unknown;
  runRows: (row: ToolRowLike) => ToolRowLike[] | undefined;
}

type MouseHandler = (this: ToolRowLike, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
interface MousePrototype extends ToolRowPrototypeLike {
  handleMouse?: MouseHandler;
  __tracelineOriginalMouse?: MouseHandler;
}
interface TraceLayout {
  width: number;
  lines: string[];
  members?: ToolRowLike[];
}

/** Pair Traceline's substituted geometry with normalized Pi mouse dispatch. */
export function installTraceMouse(proto: MousePrototype, host: TraceMouseHost): void {
  const originalRender = proto.__tracelineOriginalRender ?? proto.render;
  if (!originalRender) return;
  const originalMouse = "__tracelineOriginalMouse" in proto ? proto.__tracelineOriginalMouse : proto.handleMouse;
  proto.__tracelineOriginalRender = originalRender;
  proto.__tracelineOriginalMouse = originalMouse;
  const layouts = new WeakMap<ToolRowLike, TraceLayout>();
  proto.render = function (this: ToolRowLike, width: number) {
    layouts.delete(this);
    try {
      if (!host.isCompact(this)) return host.decorateNative(this, originalRender.call(this, width));
      const lines = host.renderTrace(this, width);
      layouts.set(this, { width, lines: lines.map(stripAnsi), members: host.runRows(this) });
      return lines;
    } catch {
      // Pi seam: a failed compact render must keep its native geometry and input.
      return originalRender.call(this, width);
    }
  };
  proto.handleMouse = function (this: ToolRowLike, event: TuiMouseEvent) {
    if (drillState()) return undefined; // preserve Drill's frozen keyboard targets
    const layout = layouts.get(this);
    if (!layout) return originalMouse?.call(this, event);
    // Never dispatch compact coordinates into Pi's hidden native children.
    // Gesture recognition, OSC 8 precedence and selection stay with the viewport.
    if (event.type !== "click" || event.button !== "left" || layout.width !== event.width) return undefined;
    const line = layout.lines[event.y];
    if (!line?.trim() || event.x < 2 || event.x >= event.width - 2) return undefined;
    const group = revealed.get(this);
    if (group?.[0] === this && event.x === host.bulletColumn) {
      for (const member of group) {
        revealed.delete(member);
        member.setExpanded(false);
      }
    } else if (layout.members && layout.members.length > 1) {
      // Use the last painted membership, not a run recomputed after new results.
      for (const member of layout.members) revealed.set(member, layout.members);
    } else {
      if (!this.result) return undefined;
      this.setExpanded(this.expanded !== true);
    }
    return { handled: true };
  };
}
