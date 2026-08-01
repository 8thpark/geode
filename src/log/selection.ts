// selectionOverlaps reports whether a non-collapsed browser selection intersects node.
export function selectionOverlaps(node: Node, selection: Selection | null): boolean {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  return selection.getRangeAt(0).intersectsNode(node);
}
