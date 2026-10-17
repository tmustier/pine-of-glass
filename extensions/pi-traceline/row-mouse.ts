import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { drillState } from "./drill.ts";

interface ExpandableRow {
  render(width: number): string[];
  setExpanded(expanded: boolean): void;
}

type MouseHandler<Row> = (this: Row, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
export interface RowMousePrototype<Row extends ExpandableRow> extends ExpandableRow {
  handleMouse?: MouseHandler<Row>;
  __tracelineOriginalRender?: ExpandableRow["render"];
  __tracelineOriginalMouse?: MouseHandler<Row>;
  __tracelineOriginalSetExpanded?: ExpandableRow["setExpanded"];
}

export interface RowLayout {
  lines: string[];
  plain: string[];
}

const patched = new WeakSet<object>();

// Reloads replace the callbacks, never the saved Pi methods.
export function installRowMouse<Row extends ExpandableRow, Layout extends RowLayout>(
  proto: RowMousePrototype<Row>,
  host: {
    renderTrace(row: Row, width: number): Layout | undefined;
    click(row: Row, layout: Layout | undefined, event: TuiMouseEvent): boolean;
    decorateNative?(row: Row, lines: string[]): string[];
    changed?(row: Row): void;
  },
): boolean {
  if (patched.has(proto)) return false;
  const render = proto.__tracelineOriginalRender ??= proto.render;
  const mouse = proto.__tracelineOriginalMouse ??= proto.handleMouse;
  const expand = proto.__tracelineOriginalSetExpanded ??= proto.setExpanded;
  const layouts = new WeakMap<Row, { width: number; layout: Layout }>();
  proto.render = function (this: Row, width: number) {
    layouts.delete(this);
    const layout = host.renderTrace(this, width);
    if (!layout) {
      const lines = render.call(this, width);
      return host.decorateNative ? host.decorateNative(this, lines) : lines;
    }
    layouts.set(this, { width, layout });
    return layout.lines;
  };
  proto.handleMouse = function (this: Row, event) {
    if (drillState()) return undefined;
    const painted = layouts.get(this);
    const click = event.type === "click" && event.button === "left";
    if (painted && (!click || painted.width !== event.width ||
      !painted.layout.plain[event.y]?.trim() || event.x < 2 || event.x >= event.width - 2)) return undefined;
    if (click && host.click(this, painted?.layout, event)) return { handled: true };
    // Compact coordinates must never reach Pi's hidden native children.
    if (!painted) return mouse?.call(this, event);
    return undefined;
  };
  const changed = host.changed;
  if (changed) proto.setExpanded = function (this: Row, expanded) {
    expand.call(this, expanded);
    changed(this);
  };
  patched.add(proto);
  return true;
}
