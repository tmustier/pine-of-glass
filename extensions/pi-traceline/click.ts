import type { ToolRowDataLike, ToolRowLike, ToolRowPrototypeLike } from "../_lib/chat.ts";
import type { TraceRenderCache } from "./render-cache.ts";
import { installRowMouse, type RowLayout, type RowMousePrototype } from "./row-mouse.ts";

// These are view overrides; output expansion stays in Pi's setExpanded().
let revealed = new WeakMap<ToolRowDataLike, ToolRowLike[]>();
let ledgerOverrides = new WeakMap<ToolRowDataLike, boolean>();
let revealRevision = 0;
export function resetRevealedFolds(): void { revealed = new WeakMap(); ledgerOverrides = new WeakMap(); revealRevision++; }
export function revealRenderKey(): number { return revealRevision; }
export function isRevealed(comp: ToolRowDataLike): boolean { return revealed.has(comp); }
export function ledgerOverride(comp: ToolRowDataLike): boolean | undefined { return ledgerOverrides.get(comp); }
export function setLedgerRevealed(comp: ToolRowDataLike, shown: boolean): void {
  ledgerOverrides.set(comp, shown);
  revealRevision++;
}
export function revealedBullet(comp: ToolRowDataLike | undefined): string | undefined {
  return comp && revealed.get(comp)?.[0] === comp ? "▾" : undefined;
}

export type LedgerView = "folded" | "revealed";
interface TraceLayout extends RowLayout {
  members?: ToolRowLike[];
  ledger?: LedgerView;
}
export interface TraceMouseHost {
  bulletColumn: number;
  isCompact: (row: ToolRowLike) => boolean;
  renderTrace: (row: ToolRowLike, width: number) => TraceLayout;
  decorateNative: (row: ToolRowLike, lines: string[]) => string[];
  viewChanged: (rows: ToolRowLike[]) => void;
}
export interface TraceMousePrototype extends ToolRowPrototypeLike, RowMousePrototype<ToolRowLike> {
  render: ToolRowLike["render"];
  setExpanded: ToolRowLike["setExpanded"];
}

export function installTraceMouse(
  proto: TraceMousePrototype, cache: TraceRenderCache, host: TraceMouseHost, topologyChanged: () => void,
): void {
  const original = proto.__tracelineOriginalUpdateDisplay ??= proto.updateDisplay;
  const expansions = new WeakMap<ToolRowLike, unknown>();
  proto.updateDisplay = function (this: ToolRowLike, ...args: unknown[]) {
    cache.dirty(this);
    if (expansions.get(this) !== this.expanded) { topologyChanged(); expansions.set(this, this.expanded); }
    return original.apply(this, args);
  };
  installRowMouse(proto, {
    renderTrace: (row, width) => host.isCompact(row) ? host.renderTrace(row, width) : undefined,
    decorateNative: host.decorateNative,
    click(row, layout, event) {
      if (!layout) return false;
      const group = revealed.get(row);
      const parentY = layout.plain.findIndex((line) => line.trim());
      if (layout.ledger === "revealed" && event.y === parentY && event.x === host.bulletColumn) {
        setLedgerRevealed(row, false);
        host.viewChanged([row]);
      } else if (layout.ledger === "folded") {
        setLedgerRevealed(row, true);
        host.viewChanged([row]);
      } else if (group?.[0] === row && event.x === host.bulletColumn) {
        for (const member of group) {
          revealed.delete(member);
          member.setExpanded(false);
        }
        host.viewChanged(group);
      } else if (layout.members) {
        // Use the painted membership even if results arrived after the render.
        for (const member of layout.members) revealed.set(member, layout.members);
        host.viewChanged(layout.members);
      } else {
        if (!row.result) return false;
        row.setExpanded(true);
        host.viewChanged([row]);
      }
      return true;
    },
  });
}
