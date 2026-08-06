// RenderAction describes what the log view should do after a selection-state transition.
export type RenderAction = "draw" | "refresh" | "wait";

// RenderDecision carries the next deferred state and the action the log view should take.
export type RenderDecision = {
  action: RenderAction;
  deferred: boolean;
};

// RenderEvent identifies whether a transition came from a requested render or selection change.
export type RenderEvent = "render" | "selectionchange";

// nextRender returns the action and deferred state for a log-view selection transition.
export function nextRender(
  deferred: boolean,
  event: RenderEvent,
  selected: boolean,
): RenderDecision {
  if (event === "render") {
    if (selected) {
      return { action: "wait", deferred: true };
    }

    return { action: "draw", deferred: false };
  }
  if (!deferred || selected) {
    return { action: "wait", deferred };
  }

  return { action: "refresh", deferred: false };
}

// selectionOverlaps reports whether a non-collapsed browser selection intersects node.
export function selectionOverlaps(node: Node, selection: Selection | null): boolean {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  return selection.getRangeAt(0).intersectsNode(node);
}
