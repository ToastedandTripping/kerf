/**
 * Test-only helper: asserts the points/transform invariant.
 *
 * Deliberately NOT part of the production geometry module and NOT re-exported
 * from the geometry barrel — no production code path ever called it. It exists
 * purely so test suites can assert that every writer leaves
 * `transform.{x,y,width,height}` ≡ anchors-only `pointsBBox(points)` within ε.
 */

import type { DesignObject } from "../../../app/types";
import { pointsBBox, POINTS_EPSILON } from "../index";

/** Local mirror of geometry's private points-bearing predicate. */
function isPointsBearing(obj: DesignObject): boolean {
  return (obj.type === "path" || obj.type === "line") && !!obj.points && obj.points.length > 0;
}

/**
 * Throws if a points-bearing object violates the invariant (transform x/y/w/h
 * ≡ anchors-only points bbox, within ε). Recurses into group children — under
 * the group-local convention, child points and child transform share the
 * group-local frame, so the invariant holds at every level.
 */
export function assertPointsInvariant(obj: DesignObject, epsilon: number = POINTS_EPSILON): void {
  if (obj.type === "group" && obj.children) {
    for (const child of obj.children) assertPointsInvariant(child, epsilon);
    return;
  }
  if (!isPointsBearing(obj)) return;
  const bb = pointsBBox(obj.points!);
  const t = obj.transform;
  const drift = Math.max(
    Math.abs(t.x - bb.x), Math.abs(t.y - bb.y),
    Math.abs(t.width - bb.width), Math.abs(t.height - bb.height),
  );
  if (drift > epsilon) {
    throw new Error(
      `points invariant violated for "${obj.id}" (${obj.type}): transform=` +
      `{x:${t.x}, y:${t.y}, w:${t.width}, h:${t.height}} vs pointsBBox=` +
      `{x:${bb.x}, y:${bb.y}, w:${bb.width}, h:${bb.height}} (drift ${drift})`,
    );
  }
}
