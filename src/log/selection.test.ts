import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionOverlaps } from "./selection.ts";

const container = {} as Node;

function fakeSelection(collapsed: boolean, rangeCount: number, intersects: boolean): Selection {
  const range = {
    intersectsNode: (node: Node) => intersects && node === container,
  } as Range;

  return {
    isCollapsed: collapsed,
    rangeCount,
    getRangeAt: () => range,
  } as unknown as Selection;
}

test("selectionOverlaps: null selection does not defer rendering", () => {
  assert.equal(selectionOverlaps(container, null), false);
});

test("selectionOverlaps: collapsed caret does not defer rendering", () => {
  const selection = fakeSelection(true, 1, true);

  assert.equal(selectionOverlaps(container, selection), false);
});

test("selectionOverlaps: selection without a range does not defer rendering", () => {
  const selection = fakeSelection(false, 0, true);

  assert.equal(selectionOverlaps(container, selection), false);
});

test("selectionOverlaps: selection outside the log does not defer rendering", () => {
  const selection = fakeSelection(false, 1, false);

  assert.equal(selectionOverlaps(container, selection), false);
});

test("selectionOverlaps: selection intersecting the log defers rendering", () => {
  const selection = fakeSelection(false, 1, true);

  assert.equal(selectionOverlaps(container, selection), true);
});
