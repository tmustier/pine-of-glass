import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ink } from "../_lib/style.ts";

/** Pack sibling files at cell boundaries, keeping the directory on the first line (§9.9). */
export function wrapReadCells(
  theme: Theme | undefined,
  head: string,
  cells: readonly string[],
  budget: number,
  contBudget: number,
): [string, ...string[]] {
  const lines: [string, ...string[]] = [head];
  let width = visibleWidth(head);
  let hasCell = false;
  for (const [index, cell] of cells.entries()) {
    const separator = hasCell ? ink(theme, "dim", ", ") : " ";
    const cellWidth = visibleWidth(cell);
    const commaRoom = index < cells.length - 1 ? 1 : 0;
    if (width + (hasCell ? 2 : 1) + cellWidth + commaRoom <= (lines.length === 1 ? budget : contBudget)) {
      lines[lines.length - 1] += `${separator}${cell}`;
      width += (hasCell ? 2 : 1) + cellWidth;
    } else {
      if (hasCell) lines[lines.length - 1] += ink(theme, "dim", ",");
      lines.push(cell);
      width = cellWidth;
    }
    hasCell = true;
  }
  return lines;
}
