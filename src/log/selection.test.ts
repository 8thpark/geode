import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRender, selectionOverlaps } from "./selection.ts";

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

test("nextRender: a deferred draw requests one refresh when selection clears", () => {
  const deferred = nextRender(false, "render", true);
  assert.deepEqual(deferred, { action: "wait", deferred: true });

  const stillSelected = nextRender(deferred.deferred, "selectionchange", true);
  assert.deepEqual(stillSelected, { action: "wait", deferred: true });

  const cleared = nextRender(stillSelected.deferred, "selectionchange", false);
  assert.deepEqual(cleared, { action: "refresh", deferred: false });

  const alreadyCaughtUp = nextRender(cleared.deferred, "selectionchange", false);
  assert.deepEqual(alreadyCaughtUp, { action: "wait", deferred: false });
});
