use super::gcode_gen::{CutObject, PathSegment, Point, object_to_path, rotate_segment};

/// Optimize cut order using nearest-neighbor heuristic starting from a given point.
/// Returns indices into the original objects vec in optimized order.
pub fn optimize_cut_order_from(objects: &[CutObject], start_x: f64, start_y: f64) -> Vec<usize> {
    if objects.is_empty() {
        return vec![];
    }

    let n = objects.len();
    let mut visited = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur_x = start_x;
    let mut cur_y = start_y;

    for _ in 0..n {
        let mut best_idx = None;
        let mut best_dist = f64::MAX;

        for (i, obj) in objects.iter().enumerate() {
            if visited[i] { continue; }

            // Get the starting point of this object
            let (sx, sy) = object_start_point(obj);
            let dist = ((sx - cur_x).powi(2) + (sy - cur_y).powi(2)).sqrt();

            if dist < best_dist {
                best_dist = dist;
                best_idx = Some(i);
            }
        }

        if let Some(idx) = best_idx {
            visited[idx] = true;
            order.push(idx);
            // Update current position to end of this object's path
            let (ex, ey) = object_end_point(&objects[idx]);
            cur_x = ex;
            cur_y = ey;
        }
    }

    order
}


/// Reorder scan segments by nearest-neighbor (flood fill order).
/// Each segment is (y_pos, x_start, x_end). Returns reordered segments.
pub fn flood_reorder_segments(
    segments: &[(f64, f64, f64)],
) -> Vec<(f64, f64, f64)> {
    if segments.len() <= 1 {
        return segments.to_vec();
    }

    let n = segments.len();
    let mut visited = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur_x = 0.0_f64;
    let mut cur_y = 0.0_f64;

    for _ in 0..n {
        let mut best_idx = None;
        let mut best_dist = f64::MAX;

        for (i, seg) in segments.iter().enumerate() {
            if visited[i] { continue; }

            // Distance to start of this segment
            let dist = ((seg.1 - cur_x).powi(2) + (seg.0 - cur_y).powi(2)).sqrt();
            if dist < best_dist {
                best_dist = dist;
                best_idx = Some(i);
            }

            // Also check distance to end of segment (in case reverse is closer)
            let dist_end = ((seg.2 - cur_x).powi(2) + (seg.0 - cur_y).powi(2)).sqrt();
            if dist_end < best_dist {
                best_dist = dist_end;
                best_idx = Some(i);
            }
        }

        if let Some(idx) = best_idx {
            visited[idx] = true;
            order.push(segments[idx]);
            // Update position to end of this segment
            cur_x = segments[idx].2;
            cur_y = segments[idx].0;
        }
    }

    order
}

// ─── Geometric containment helpers ────────────────────────────────────────────

/// Absolute area of a polygon using the shoelace formula.
fn polygon_area_abs(pts: &[Point]) -> f64 {
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    for i in 0..n {
        let j = (i + 1) % n;
        sum += pts[i].x * pts[j].y;
        sum -= pts[j].x * pts[i].y;
    }
    sum.abs() / 2.0
}

/// Signed area of a polygon (positive = counter-clockwise in standard math coords).
fn polygon_signed_area(pts: &[Point]) -> f64 {
    let n = pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    for i in 0..n {
        let j = (i + 1) % n;
        sum += pts[i].x * pts[j].y;
        sum -= pts[j].x * pts[i].y;
    }
    sum / 2.0
}

/// Area centroid of a polygon (shoelace-weighted, NOT a vertex average).
fn polygon_centroid(pts: &[Point]) -> Point {
    let n = pts.len();
    if n == 0 {
        return Point { x: 0.0, y: 0.0 };
    }
    if n == 1 {
        return Point { x: pts[0].x, y: pts[0].y };
    }
    let area = polygon_signed_area(pts);
    if area.abs() < 1e-10 {
        // Degenerate — return bbox centre
        let min_x = pts.iter().map(|p| p.x).fold(f64::MAX, f64::min);
        let max_x = pts.iter().map(|p| p.x).fold(f64::MIN, f64::max);
        let min_y = pts.iter().map(|p| p.y).fold(f64::MAX, f64::min);
        let max_y = pts.iter().map(|p| p.y).fold(f64::MIN, f64::max);
        return Point { x: (min_x + max_x) / 2.0, y: (min_y + max_y) / 2.0 };
    }
    let mut cx = 0.0_f64;
    let mut cy = 0.0_f64;
    for i in 0..n {
        let j = (i + 1) % n;
        let cross = pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        cx += (pts[i].x + pts[j].x) * cross;
        cy += (pts[i].y + pts[j].y) * cross;
    }
    Point { x: cx / (6.0 * area), y: cy / (6.0 * area) }
}

/// Even-odd ray-casting point-in-polygon test.
///
/// Half-open rule: edge (y0, y1) crosses the ray iff `min(y0,y1) <= py < max(y0,y1)`.
/// This excludes horizontal edges (where min == max) and ensures a vertex on the
/// scanline is counted exactly once (only the upward-going edge from it counts).
pub(crate) fn point_in_polygon(px: f64, py: f64, poly: &[Point]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let xi = poly[i].x;
        let yi = poly[i].y;
        let xj = poly[j].x;
        let yj = poly[j].y;
        // Half-open crossing rule
        if (yi > py) != (yj > py) {
            let x_intercept = xj + (py - yj) / (yi - yj) * (xi - xj);
            if px < x_intercept {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Guaranteed-interior representative point for any simple polygon.
///
/// 1. Try the area centroid (shoelace-weighted). If it's inside the polygon, use it.
/// 2. Fallback: scanline-midpoint — choose y = midpoint of the two smallest distinct
///    vertex y-values (strictly between them, so no vertices lie on the scanline).
///    Collect edge crossings at that y with the half-open rule; the rep point is the
///    midpoint of the first (leftmost) interior span [x0, x1].
///    Guaranteed interior for any simple polygon.
fn guaranteed_interior_point(pts: &[Point]) -> Point {
    // Attempt 1: area centroid
    let c = polygon_centroid(pts);
    if point_in_polygon(c.x, c.y, pts) {
        return c;
    }

    // Attempt 2: scanline midpoint
    let mut ys: Vec<f64> = pts.iter().map(|p| p.y).collect();
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    // Deduplicate (keep distinct values only, within 1e-10 tolerance)
    ys.dedup_by(|a, b| (*a - *b).abs() < 1e-10);

    if ys.len() < 2 {
        return c; // degenerate polygon
    }

    // scan_y is strictly between the two smallest distinct y-values —
    // no vertex lies on this scanline by construction.
    let scan_y = (ys[0] + ys[1]) / 2.0;

    let n = pts.len();
    let mut xs: Vec<f64> = Vec::new();
    let mut j = n - 1;
    for i in 0..n {
        let y0 = pts[j].y;
        let y1 = pts[i].y;
        let x0 = pts[j].x;
        let x1 = pts[i].x;
        // Half-open rule: min(y0,y1) <= scan_y < max(y0,y1)
        let lo = y0.min(y1);
        let hi = y0.max(y1);
        if lo <= scan_y && scan_y < hi {
            let x_int = x0 + (scan_y - y0) / (y1 - y0) * (x1 - x0);
            xs.push(x_int);
        }
        j = i;
    }

    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    if xs.len() >= 2 {
        Point { x: (xs[0] + xs[1]) / 2.0, y: scan_y }
    } else {
        c // Last resort: return centroid (degenerate polygon)
    }
}

/// Axis-aligned bounding box of a polygon: (min_x, min_y, width, height).
fn polygon_aabb(pts: &[Point]) -> (f64, f64, f64, f64) {
    if pts.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let min_x = pts.iter().map(|p| p.x).fold(f64::MAX, f64::min);
    let min_y = pts.iter().map(|p| p.y).fold(f64::MAX, f64::min);
    let max_x = pts.iter().map(|p| p.x).fold(f64::MIN, f64::max);
    let max_y = pts.iter().map(|p| p.y).fold(f64::MIN, f64::max);
    (min_x, min_y, max_x - min_x, max_y - min_y)
}

/// Build the outline polygon for containment checks, reusing the emit geometry.
///
/// For objects with paths: pick the largest-area contour (with rotation applied),
/// so the containment geometry matches exactly what the laser will cut.
/// For primitive objects (rectangle/ellipse/line) with no paths: synthesize via
/// `object_to_path` (which already applies rotation).
///
/// This is the single source of truth for outline geometry — the same function is
/// used both here (containment) and by the emitter (gcode_gen.rs), so they can't drift.
fn build_object_outline(obj: &CutObject) -> Vec<Point> {
    if obj.paths.is_empty() {
        let seg = object_to_path(obj);
        return seg.points;
    }

    // Apply rotation to each path and pick the one with the largest area.
    let mut best_pts: Vec<Point> = vec![];
    let mut best_area = 0.0_f64;

    // Invariant: an object's outer perimeter is its largest-area sub-path. Holds for all
    // standard SVG/DXF imports (holes are strictly smaller than their container). A
    // pathological import that violates this would degrade containment to a false-negative
    // (outer-before-inner = old behavior), never an incorrect cut of valid geometry.
    for path in &obj.paths {
        let mut p = path.clone();
        rotate_segment(&mut p, obj);
        let area = polygon_area_abs(&p.points);
        if area > best_area {
            best_area = area;
            best_pts = p.points;
        }
    }

    if best_pts.is_empty() {
        // Empty paths with zero area — fall back to bbox rect
        let seg = object_to_path(obj);
        seg.points
    } else {
        best_pts
    }
}

// ─── Longest-path rank in the containment DAG ─────────────────────────────────

/// Compute the longest-path rank for each object in the containment DAG.
///
/// Edge A→parent means "parent geometrically contains A" (A's rep point is inside
/// parent's outline). rank[A] = length of the longest chain of containers above A.
/// Top-level objects (nothing contains them) have rank 0.
///
/// Monotone along every containment edge by construction:
/// if A⊂B then rank(A) ≥ rank(B)+1 > rank(B), regardless of unrelated objects
/// that may also contain B but not A. This is the key property that prevents
/// a straddling third object from tying an inner with its outer.
fn compute_ranks(outlines: &[Vec<Point>], rep_points: &[(f64, f64)]) -> Vec<usize> {
    let n = outlines.len();
    // contained_by[i] = indices of objects that directly contain i
    let mut contained_by: Vec<Vec<usize>> = vec![vec![]; n];

    // Pre-compute each object's polygon AABB (computed on the already-rotated outline points)
    let aabbs: Vec<(f64, f64, f64, f64)> = outlines.iter().map(|pts| polygon_aabb(pts)).collect();

    for i in 0..n {
        let (px, py) = rep_points[i];
        let (ix, iy, iw, ih) = aabbs[i]; // i's polygon AABB

        for j in 0..n {
            if i == j {
                continue;
            }
            let outline_j = &outlines[j];
            if outline_j.is_empty() {
                continue;
            }
            let (jx, jy, jw, jh) = aabbs[j]; // j's polygon AABB

            // Rotated-AABB pre-filter (necessary condition): i's full polygon AABB
            // must fit inside j's polygon AABB. This prevents false positives where a
            // large outer's centroid happens to fall inside a small inner's polygon.
            if ix < jx || iy < jy || ix + iw > jx + jw || iy + ih > jy + jh {
                continue; // i is too big to be inside j — skip
            }

            // Precise PiP: i's representative interior point must be inside j's polygon.
            if point_in_polygon(px, py, outline_j) {
                contained_by[i].push(j);
            }
        }
    }

    // Memoized DFS for longest-path rank.
    // rank[v] = 1 + max(rank[parent] for parent in contained_by[v]), or 0 if no parents.
    let mut memo: Vec<Option<usize>> = vec![None; n];

    fn dfs(v: usize, contained_by: &[Vec<usize>], memo: &mut Vec<Option<usize>>) -> usize {
        if let Some(r) = memo[v] {
            return r;
        }
        // Guard against cycles (mutual containment — degenerate but safe)
        memo[v] = Some(0); // temporary sentinel to break cycles
        let r = contained_by[v].iter().map(|&p| dfs(p, contained_by, memo) + 1).max().unwrap_or(0);
        memo[v] = Some(r);
        r
    }

    (0..n).map(|v| dfs(v, &contained_by, &mut memo)).collect()
}

/// Inner-first + nearest-neighbor ordering of CutObjects.
///
/// Primary key: containment rank (longest-path in the containment DAG), high→low.
/// Secondary key: nearest-neighbor from the running head, within each rank band.
///
/// NN only ever reorders objects within a rank band. Because two objects in the same
/// band cannot have a containment relation (A⊂B implies rank(A) > rank(B)), NN can
/// never let an outer cut before its inner — this is the invariant the old
/// old bbox-containment sort + `optimize_cut_order_from` sequence violated.
///
/// Returns indices into the original `objects` slice in the computed order.
pub fn order_inner_first_nn(objects: &[CutObject], start_x: f64, start_y: f64) -> Vec<usize> {
    let n = objects.len();
    if n == 0 {
        return vec![];
    }
    if n == 1 {
        return vec![0];
    }

    // Build outlines and rep points once, reusing emit geometry.
    let outlines: Vec<Vec<Point>> = objects.iter().map(build_object_outline).collect();
    let rep_points: Vec<(f64, f64)> = outlines
        .iter()
        .map(|pts| {
            let p = guaranteed_interior_point(pts);
            (p.x, p.y)
        })
        .collect();

    // Compute longest-path rank for each object.
    let ranks = compute_ranks(&outlines, &rep_points);

    // Find the maximum rank (innermost band).
    let max_rank = *ranks.iter().max().unwrap_or(&0);

    let mut order: Vec<usize> = Vec::with_capacity(n);
    let mut visited = vec![false; n];
    let mut cur_x = start_x;
    let mut cur_y = start_y;

    // Process bands from innermost (max_rank) to outermost (0).
    for rank in (0..=max_rank).rev() {
        // Collect unvisited objects in this band
        let band: Vec<usize> = (0..n)
            .filter(|&i| !visited[i] && ranks[i] == rank)
            .collect();

        if band.is_empty() {
            continue;
        }

        // NN within this band
        let mut band_visited = vec![false; band.len()];
        for _ in 0..band.len() {
            let mut best_local = 0;
            let mut best_dist = f64::MAX;

            for (li, &gi) in band.iter().enumerate() {
                if band_visited[li] {
                    continue;
                }
                let (sx, sy) = object_start_point(&objects[gi]);
                let dist = (sx - cur_x).powi(2) + (sy - cur_y).powi(2);
                if dist < best_dist {
                    best_dist = dist;
                    best_local = li;
                }
            }

            band_visited[best_local] = true;
            let gi = band[best_local];
            visited[gi] = true;
            order.push(gi);
            let (ex, ey) = object_end_point(&objects[gi]);
            cur_x = ex;
            cur_y = ey;
        }
    }

    order
}

// ─── Sub-contour ordering (§D) ────────────────────────────────────────────────

/// Order paths within a single object so holes (inner contours) cut before the
/// outer perimeter. Uses the same PiP containment test as `order_inner_first_nn`.
///
/// A path A is considered "inner" relative to path B if A's representative point
/// is inside B's polygon. Paths are ordered high-rank-first (innermost first),
/// stable within equal rank.
///
/// Called from gcode_gen.rs `"line"` arm only — not `maskFill` or `offsetFill`.
pub fn order_paths_inner_first(paths: &mut [PathSegment]) {
    let n = paths.len();
    if n <= 1 {
        return;
    }

    // Compute AABB and rep point for each path
    let aabbs: Vec<(f64, f64, f64, f64)> = paths.iter().map(|p| polygon_aabb(&p.points)).collect();
    let rep_points: Vec<(f64, f64)> = paths
        .iter()
        .map(|p| {
            let pt = guaranteed_interior_point(&p.points);
            (pt.x, pt.y)
        })
        .collect();

    // Build containment depth: depth[i] = number of other paths that contain i.
    // Uses the same AABB pre-filter as compute_ranks: i's full AABB must fit inside j's
    // AABB before we bother with PiP. This prevents the perimeter's centroid (which may
    // lie inside a hole) from creating a false reverse-containment edge.
    let mut depth = vec![0usize; n];
    for i in 0..n {
        let (px, py) = rep_points[i];
        let (ix, iy, iw, ih) = aabbs[i];
        for j in 0..n {
            if i == j {
                continue;
            }
            let (jx, jy, jw, jh) = aabbs[j];
            // i's full AABB must fit inside j's AABB (necessary condition)
            if ix < jx || iy < jy || ix + iw > jx + jw || iy + ih > jy + jh {
                continue;
            }
            if point_in_polygon(px, py, &paths[j].points) {
                depth[i] += 1;
            }
        }
    }

    // Sort: higher depth (more inner) first. Stable sort preserves stored order
    // for paths at the same depth (e.g., two sibling holes).
    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_by(|&a, &b| depth[b].cmp(&depth[a]));

    let original = paths.to_owned();
    for (new_pos, &old_pos) in indices.iter().enumerate() {
        paths[new_pos] = original[old_pos].clone();
    }
}

fn object_start_point(obj: &CutObject) -> (f64, f64) {
    if let Some(path) = obj.paths.first() {
        if let Some(pt) = path.points.first() {
            return (pt.x, pt.y);
        }
    }
    (obj.x, obj.y)
}

fn object_end_point(obj: &CutObject) -> (f64, f64) {
    if let Some(path) = obj.paths.last() {
        if let Some(pt) = path.points.last() {
            return (pt.x, pt.y);
        }
    }
    (obj.x + obj.width, obj.y + obj.height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::gcode_gen::{CutLayer, CutObject};

    fn make_cut_layer() -> CutLayer {
        CutLayer {
            mode: "line".to_string(),
            power: 100.0,
            power_min: 0.0,
            speed: 1200.0, // mm/min (was 20 mm/s before unit switch)
            passes: 1,
            power_mode: "constant".to_string(),
            interval: 0.1,
            air_assist: true,
            cut_inner_first: true,
            dither: "floydSteinberg".to_string(),
            scan_angle: 0.0,
            angle_increment: 0.0,
            overcut: 0.0,
            lead_in: 0.0,
            lead_out: 0.0,
            overscan: 0.0,
            bidirectional: true,
            cross_hatch: false,
            scanning_offset: 0.0,
            tab_spacing: 0.0,
            tab_width: 0.0,
            perforation_cut: 0.0,
            perforation_skip: 0.0,
            power_curve: None,
            fill_order: None,
            newsprint_cell_size: None,
            newsprint_angle: None,
        }
    }

    fn make_obj(id: &str, x: f64, y: f64, w: f64, h: f64, pri: Option<i32>, gid: Option<&str>) -> CutObject {
        CutObject {
            id: id.to_string(),
            obj_type: "rectangle".to_string(),
            x,
            y,
            width: w,
            height: h,
            paths: vec![],
            layer: make_cut_layer(),
            corner_radius: None,
            rotation: 0.0,
            priority: pri,
            group_id: gid.map(|s| s.to_string()),
            layer_index: None,
        }
    }

    #[test]
    fn start_corner_top_right() {
        let objs = vec![
            make_obj("near_tl", 10.0, 10.0, 10.0, 10.0, None, None),
            make_obj("near_tr", 480.0, 10.0, 10.0, 10.0, None, None),
        ];
        // Start from top-right (500, 300)
        let order = optimize_cut_order_from(&objs, 500.0, 300.0);
        // near_tr is closer to (500, 300) than near_tl
        assert_eq!(order[0], 1); // near_tr first
    }

    // --- flood_reorder_segments tests ---

    #[test]
    fn flood_single_contiguous_row_unchanged() {
        // A single contiguous row of segments should come out in the same order
        // (each segment's end is already nearest to the next segment's start)
        let segments = vec![
            (0.0, 0.0, 10.0),
            (0.0, 10.0, 20.0),
            (0.0, 20.0, 30.0),
        ];
        let result = flood_reorder_segments(&segments);
        assert_eq!(result.len(), 3);
        // All on same row, already sequential -- order should be preserved
        assert_eq!(result[0], (0.0, 0.0, 10.0));
        assert_eq!(result[1], (0.0, 10.0, 20.0));
        assert_eq!(result[2], (0.0, 20.0, 30.0));
    }

    #[test]
    fn flood_two_distant_regions_closer_first() {
        // Two groups: near origin and far away.
        // Starting from (0,0), the near group should be visited first.
        let segments = vec![
            (100.0, 100.0, 110.0), // far region
            (0.0, 0.0, 10.0),      // near region
            (100.0, 110.0, 120.0), // far region (adjacent to first)
            (0.0, 10.0, 20.0),     // near region (adjacent to second)
        ];
        let result = flood_reorder_segments(&segments);
        assert_eq!(result.len(), 4);
        // Near-origin segments should come first
        assert!(result[0].0 < 50.0, "first segment should be from near region");
        assert!(result[1].0 < 50.0, "second segment should be from near region");
        // Far segments last
        assert!(result[2].0 >= 50.0, "third segment should be from far region");
        assert!(result[3].0 >= 50.0, "fourth segment should be from far region");
    }

    #[test]
    fn flood_empty_and_single() {
        // Empty input
        let empty: Vec<(f64, f64, f64)> = vec![];
        assert_eq!(flood_reorder_segments(&empty).len(), 0);

        // Single segment
        let single = vec![(5.0, 0.0, 10.0)];
        let result = flood_reorder_segments(&single);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], (5.0, 0.0, 10.0));
    }

    // ─── Helpers for new inner-first tests ────────────────────────────────────

    fn make_rect_path(x: f64, y: f64, w: f64, h: f64) -> PathSegment {
        PathSegment {
            points: vec![
                Point { x, y },
                Point { x: x + w, y },
                Point { x: x + w, y: y + h },
                Point { x, y: y + h },
            ],
            closed: true,
        }
    }

    fn make_obj_with_paths(id: &str, x: f64, y: f64, w: f64, h: f64, paths: Vec<PathSegment>) -> CutObject {
        let mut obj = make_obj(id, x, y, w, h, None, None);
        obj.paths = paths;
        obj
    }

    fn make_obj_layer(id: &str, x: f64, y: f64, w: f64, h: f64, layer_index: i32) -> CutObject {
        let mut obj = make_obj(id, x, y, w, h, None, None);
        obj.layer_index = Some(layer_index);
        obj
    }

    // ─── Test #1: THE regression ─────────────────────────────────────────────

    /// THE regression test: inner-first must survive when the outer's start point
    /// is nearer the head (the exact failure mode of the old sort + NN sequence).
    /// With the old bbox-containment sort + optimize_cut_order_from: outer goes first (bug).
    /// With order_inner_first_nn: inner goes first (correct).
    #[test]
    fn inner_first_survives_nn_when_perimeter_start_nearer() {
        // outer: 100×100 at (0,0) — start point (0,0), distance to head (0,0) = 0
        // inner: 20×20 at (40,40), fully inside outer — start at (40,40), distance ≈ 56
        // NN alone would pick outer first. inner_first_nn must override this.
        let outer = make_obj("outer", 0.0, 0.0, 100.0, 100.0, None, None);
        let inner = make_obj("inner", 40.0, 40.0, 20.0, 20.0, None, None);
        let objs = vec![outer, inner]; // outer=idx 0, inner=idx 1

        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_eq!(order.len(), 2);
        assert_eq!(
            order[0], 1,
            "inner (idx 1) must cut first despite outer start being at distance 0 from head"
        );
        assert_eq!(order[1], 0, "outer (idx 0) must cut second");
    }

    // ─── Test #2: sub-contour hole before perimeter ───────────────────────────

    #[test]
    fn subcontour_hole_before_perimeter() {
        // A single object has two sub-paths: an outer perimeter (large) and a hole (small).
        // order_paths_inner_first must put the hole before the perimeter.
        let perimeter = make_rect_path(0.0, 0.0, 100.0, 100.0); // area = 10000
        let hole      = make_rect_path(40.0, 40.0, 20.0, 20.0); // area = 400

        let mut paths = vec![perimeter, hole]; // perimeter=idx 0, hole=idx 1
        order_paths_inner_first(&mut paths);

        // After ordering: hole (smaller area) must be first
        let area0 = polygon_area_abs(&paths[0].points);
        let area1 = polygon_area_abs(&paths[1].points);
        assert!(area0 < area1, "hole (smaller area ≈400) must come first, got area0={area0} area1={area1}");
        assert!((area0 - 400.0).abs() < 1.0, "first path should be the hole (area≈400), got {area0}");
    }

    // ─── Test #3: toggle on/off ───────────────────────────────────────────────

    #[test]
    fn toggle_off_uses_nn() {
        // With toggle OFF (pure NN), the nearer object wins regardless of containment.
        let outer = make_obj("outer", 0.0, 0.0, 100.0, 100.0, None, None);
        let inner = make_obj("inner", 40.0, 40.0, 20.0, 20.0, None, None);
        let objs = vec![outer, inner]; // outer=idx 0 start at (0,0), inner=idx 1 start at (40,40)

        // Pure NN from (0,0): outer's start is at (0,0) = distance 0 → outer first
        let order = optimize_cut_order_from(&objs, 0.0, 0.0);
        assert_eq!(order[0], 0, "toggle off: NN picks outer (start 0,0 = distance 0 from head)");
        assert_eq!(order[1], 1);
    }

    #[test]
    fn toggle_on_orders_inner_first() {
        // With toggle ON (inner-first), the inner must cut before its container
        // regardless of travel distance.
        let outer = make_obj("outer", 0.0, 0.0, 100.0, 100.0, None, None);
        let inner = make_obj("inner", 40.0, 40.0, 20.0, 20.0, None, None);
        let objs = vec![outer, inner];

        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_eq!(order[0], 1, "toggle on: inner must cut before its outer container");
        assert_eq!(order[1], 0);
    }

    // ─── Test #4: rotated shape containment ──────────────────────────────────

    #[test]
    fn containment_rotated_shape() {
        // Small inner square rotated 45° (diamond) inside a large un-rotated outer.
        // The old bbox-containment test would use un-rotated bounds (45-55, 45-55) ⊂ (0-100, 0-100) — passes.
        // With rotation, the inner's polygon AABB (≈42.93-57.07 in both axes) still fits inside outer.
        // This test mainly guards that rotation doesn't break containment detection.
        let outer = make_obj("outer", 0.0, 0.0, 100.0, 100.0, None, None);
        let mut inner = make_obj("inner", 45.0, 45.0, 10.0, 10.0, None, None);
        inner.rotation = 45.0;
        let objs = vec![outer, inner];

        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_eq!(order[0], 1, "rotated inner must be detected as contained and cut first");

        // Variant: outer also rotated (30°). A 200×200 outer rotated 30° still contains a
        // small 10×10 inner near the center.
        let mut outer2 = make_obj("outer2", 0.0, 0.0, 200.0, 200.0, None, None);
        outer2.rotation = 30.0;
        let mut inner2 = make_obj("inner2", 95.0, 95.0, 10.0, 10.0, None, None);
        inner2.rotation = 45.0;
        let objs2 = vec![outer2, inner2];
        let order2 = order_inner_first_nn(&objs2, 0.0, 0.0);
        assert_eq!(order2[0], 1, "rotated inner inside rotated outer must still be detected");
    }

    // ─── Test #5: irregular and concave shapes ────────────────────────────────

    #[test]
    fn containment_irregular_shape() {
        // Triangle outer (explicit paths, not a bbox) containing a small inner rectangle.
        // The old bbox-containment test would use the triangle's bounding box (100×100), potentially
        // giving false positives; PiP correctly handles the non-rectangular boundary.
        let triangle = PathSegment {
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 100.0, y: 0.0 },
                Point { x: 50.0, y: 100.0 },
            ],
            closed: true,
        };
        let outer_tri = make_obj_with_paths("outer_tri", 0.0, 0.0, 100.0, 100.0, vec![triangle]);
        // inner square at (35,10,20,30): centroid at (45,25) — inside the triangle
        let inner = make_obj("inner", 35.0, 10.0, 20.0, 30.0, None, None);

        let objs = vec![outer_tri, inner];
        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_eq!(order[0], 1, "inner must be detected inside irregular (triangle) outer");

        // Concave-outer (L-shape): inner is in the bottom-left arm of the L.
        // A centroid-based check on a CONCAVE inner would fail if it put the rep point
        // outside the inner shape; guaranteed_interior_point prevents this.
        // Here the inner itself is a U-shape (concave) inside a large outer rectangle.
        // The U's vertex average (~y=5.5 for a narrow U) is outside the U; the scanline
        // fallback must find a point inside and correctly detect it's inside the outer.
        let u_inner = PathSegment {
            // U-shape: bottom bar 0-10×0-2, left arm 0-2×0-10, right arm 8-10×0-10
            // Opening is at the top (y=2-10, x=2-8 is the notch)
            points: vec![
                Point { x: 10.0, y: 0.0 },
                Point { x: 10.0, y: 10.0 },
                Point { x: 8.0,  y: 10.0 },
                Point { x: 8.0,  y: 2.0 },
                Point { x: 2.0,  y: 2.0 },
                Point { x: 2.0,  y: 10.0 },
                Point { x: 0.0,  y: 10.0 },
                Point { x: 0.0,  y: 0.0 },
            ],
            closed: true,
        };
        // Shift U to be inside the large outer (offset to 50,50)
        let u_shifted: Vec<Point> = u_inner.points.iter()
            .map(|p| Point { x: p.x + 50.0, y: p.y + 50.0 })
            .collect();
        let u_seg = PathSegment { points: u_shifted, closed: true };
        let concave_inner = make_obj_with_paths("u_inner", 50.0, 50.0, 10.0, 10.0, vec![u_seg]);
        let large_outer = make_obj("large_outer", 0.0, 0.0, 200.0, 200.0, None, None);

        let objs2 = vec![large_outer, concave_inner];
        let order2 = order_inner_first_nn(&objs2, 0.0, 0.0);
        assert_eq!(order2[0], 1, "concave (U-shaped) inner must be detected inside large outer");
    }

    // ─── Test #6: equal depth band uses NN ────────────────────────────────────

    #[test]
    fn equal_depth_band_uses_nn() {
        // Two sibling objects at rank 0 (neither contains the other).
        // Head is nearer B → NN within the band should pick B first.
        let a = make_obj("a", 0.0, 0.0, 10.0, 10.0, None, None);    // start at (0,0)
        let b = make_obj("b", 200.0, 0.0, 10.0, 10.0, None, None);  // start at (200,0)

        // Head at (210,0): b is much nearer
        let order = order_inner_first_nn(&[a, b], 210.0, 0.0);
        assert_eq!(order[0], 1, "head at (210,0): b (start 200,0) is nearer and same rank → b first");
        assert_eq!(order[1], 0);
    }

    // ─── Test #7: three-level nesting ────────────────────────────────────────

    #[test]
    fn three_level_nesting() {
        // inner ⊂ middle ⊂ outer → expected order: [inner, middle, outer]
        let outer  = make_obj("outer",  0.0,  0.0,  100.0, 100.0, None, None);
        let middle = make_obj("middle", 10.0, 10.0,  80.0,  80.0, None, None);
        let inner  = make_obj("inner",  30.0, 30.0,  40.0,  40.0, None, None);

        // Objects presented in worst-case order (outer first)
        let objs = vec![outer, middle, inner]; // outer=0, middle=1, inner=2

        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_eq!(order[0], 2, "innermost must cut first");
        assert_eq!(order[1], 1, "middle must cut second");
        assert_eq!(order[2], 0, "outer must cut last");
    }

    // ─── Test #7b: straddling object doesn't tie inner with outer ─────────────

    /// Regression for the count-of-containers failure mode identified by the critic.
    /// S⊂O (S is truly inside O), plus T that partially overlaps O (T's polygon
    /// contains O's rep point but T's AABB does NOT contain O's full AABB).
    /// With a plain count metric: count(S)=count(O)=1 → same band → NN might pick O first.
    /// With longest-path rank (and AABB filter): T doesn't register as O's container,
    /// rank(O)=0, rank(S)=1 → S cuts before O. ✓
    #[test]
    fn straddling_object_does_not_tie_inner_with_outer() {
        // O: 100×100 outer square at (0,0). Rep point: centroid of outline ≈ (50,50).
        let o = make_obj("O", 0.0, 0.0, 100.0, 100.0, None, None);
        // S: 20×20 square inside O at (10,10). Rep point ≈ (20,20).
        let s = make_obj("S", 10.0, 10.0, 20.0, 20.0, None, None);
        // T: rectangle at (40,0,60,100) — a vertical strip through the center of O.
        // T's polygon DOES contain O's rep (50,50) geometrically, but O's full AABB (0-100)
        // is NOT inside T's AABB (40-100) → AABB filter rejects O⊂T → rank(O) stays 0.
        let t = make_obj("T", 40.0, 0.0, 60.0, 100.0, None, None);

        // objs: O=0, S=1, T=2. Head at (0,0) (nearer to O's start).
        let objs = vec![o, s, t];
        let order = order_inner_first_nn(&objs, 0.0, 0.0);

        // S must appear before O in the output, regardless of T
        let pos_s = order.iter().position(|&i| i == 1).expect("S in order");
        let pos_o = order.iter().position(|&i| i == 0).expect("O in order");
        assert!(
            pos_s < pos_o,
            "S (truly inside O) must cut before O even with straddling T present; \
             order={order:?}"
        );
    }

    // ─── Test #8: layer order preserved — no cross-layer pull ────────────────

    /// Layer ordering is enforced by gcode.rs (F7 loop) by feeding order_inner_first_nn
    /// one layer's objects at a time. This test simulates that: two separate layer
    /// calls, verifying that objects in layer 0 are all emitted before layer 1.
    #[test]
    fn layer_order_preserved_no_cross_layer_pull() {
        // Layer 0: big outer square
        let layer0_outer = make_obj_layer("l0_outer", 0.0, 0.0, 100.0, 100.0, 0);
        // Layer 1: small square (geometrically "inner-looking") — closer to head (0,0)
        //   than layer 0's outer, but on a different layer
        let layer1_inner = make_obj_layer("l1_inner", 10.0, 10.0, 20.0, 20.0, 1);

        // Simulate what gcode.rs does: process each layer independently
        let layer0_objs = vec![layer0_outer.clone()];
        let layer1_objs = vec![layer1_inner.clone()];

        let order0 = order_inner_first_nn(&layer0_objs, 0.0, 0.0);
        let order1 = order_inner_first_nn(&layer1_objs, 0.0, 0.0);

        // Layer 0 objects come first, then layer 1
        // (The F7 loop in gcode.rs appends these in sequence)
        let mut combined_ids: Vec<&str> = Vec::new();
        for &i in &order0 { combined_ids.push(&layer0_objs[i].id); }
        for &i in &order1 { combined_ids.push(&layer1_objs[i].id); }

        assert_eq!(combined_ids[0], "l0_outer",
            "layer 0 object must emit before layer 1 object regardless of proximity");
        assert_eq!(combined_ids[1], "l1_inner");
    }

    // ─── Degenerate rep-point tests ───────────────────────────────────────────

    /// Concave shape (U) whose area centroid falls OUTSIDE the polygon.
    /// guaranteed_interior_point must fall back to scanline-midpoint and return
    /// a point that is strictly inside the polygon.
    #[test]
    fn rep_point_concave_centroid_outside() {
        // Narrow U-shape: bottom bar 0-10×0-2, arms 0-2×0-10 and 8-10×0-10.
        // The notch is x:[2,8], y:[2,10]. Centroid ≈ (5, 4.07) — inside the notch → outside U.
        let u_pts = vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 10.0, y: 0.0 },
            Point { x: 10.0, y: 10.0 },
            Point { x: 8.0,  y: 10.0 },
            Point { x: 8.0,  y: 2.0 },
            Point { x: 2.0,  y: 2.0 },
            Point { x: 2.0,  y: 10.0 },
            Point { x: 0.0,  y: 10.0 },
        ];

        // Verify the centroid is outside (so the fallback fires)
        let c = polygon_centroid(&u_pts);
        // The U-shape's notch covers (2,2)-(8,10). Centroid y ≈ 4.07 is inside the notch.
        let centroid_inside = point_in_polygon(c.x, c.y, &u_pts);
        // centroid_inside is expected to be false (it's in the notch); the test guards
        // that guaranteed_interior_point handles this case correctly regardless.
        let interior = guaranteed_interior_point(&u_pts);
        assert!(
            point_in_polygon(interior.x, interior.y, &u_pts),
            "guaranteed_interior_point must return a point strictly inside the U-shape; \
             centroid was {:?} (inside={centroid_inside}), fallback returned ({}, {})",
            c, interior.x, interior.y
        );
    }

    /// point_in_polygon: verify consistent half-open crossing rule behavior.
    ///
    /// The rule `(yi > py) != (yj > py)` treats the lower boundary as "in" and the
    /// upper boundary as "out". This is consistent (no double-counting) and guarantees
    /// that `guaranteed_interior_point`'s scanline-fallback output (strictly between
    /// the two lowest distinct y-values) is always correctly classified as inside.
    ///
    /// The key safety property: interior points return true, and the diamond test
    /// (two polygon vertices at the same y-level) is counted exactly once.
    #[test]
    fn pip_horizontal_edge_and_vertex_on_scanline() {
        // Rectangle (0,0)-(4,0)-(4,2)-(0,2)
        let rect = vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 4.0, y: 0.0 },
            Point { x: 4.0, y: 2.0 },
            Point { x: 0.0, y: 2.0 },
        ];

        // The upper horizontal boundary (y=2) is classified as "outside" by the
        // half-open rule (both vertical edges' upward-going side ends at y=2 exclusive).
        let on_top_edge = point_in_polygon(2.0, 2.0, &rect);
        assert!(!on_top_edge, "upper boundary (y=2) must be outside per half-open rule");

        // Strictly interior point
        assert!(point_in_polygon(2.0, 1.0, &rect), "center point (y=1) must be inside");

        // Points well outside
        assert!(!point_in_polygon(5.0, 1.0, &rect), "right of rectangle must be outside");
        assert!(!point_in_polygon(-1.0, 1.0, &rect), "left of rectangle must be outside");

        // Diamond: vertices at (5,0), (10,5), (5,10), (0,5).
        // At y=5 there are exactly two vertices (0,5) and (10,5). The half-open rule
        // must count each shared vertex exactly once to avoid toggling twice and
        // flipping the answer.
        let diamond = vec![
            Point { x: 5.0, y: 0.0 },
            Point { x: 10.0, y: 5.0 },
            Point { x: 5.0, y: 10.0 },
            Point { x: 0.0, y: 5.0 },
        ];
        // Geometric center: strictly inside
        assert!(point_in_polygon(5.0, 5.0, &diamond), "center of diamond must be inside");
        // Outside
        assert!(!point_in_polygon(15.0, 5.0, &diamond), "right of diamond must be outside");
        assert!(!point_in_polygon(5.0, 11.0, &diamond), "above diamond must be outside");

        // Strictly interior (non-center) to avoid vertex ambiguity
        assert!(point_in_polygon(5.0, 3.0, &diamond), "lower-center of diamond must be inside");
        assert!(point_in_polygon(5.0, 7.0, &diamond), "upper-center of diamond must be inside");
    }

    /// AABB pre-filter cycle-prevention: two partially-overlapping rectangles must not
    /// produce a mutual-containment cycle in `compute_ranks`.
    ///
    /// Setup: A=(0,0,60,60) and B=(20,20,60,60) share a 40×40 intersection region.
    ///
    /// Without the AABB pre-filter, the PiP check alone would register a cycle:
    ///   - A's centroid (30,30) is inside B's polygon  → contained_by[A] = [B]
    ///   - B's centroid (50,50) is inside A's polygon  → contained_by[B] = [A]
    ///
    /// The DFS cycle guard (sentinel) prevents an infinite loop, but assigns
    /// non-zero ranks ([2, 1] with DFS-visit order [A, B]), incorrectly treating
    /// one object as "inner" relative to the other.
    ///
    /// With the AABB pre-filter both checks short-circuit:
    ///   - A's AABB left-edge (0) < B's AABB left-edge (20)  → skip
    ///   - B's AABB right-edge (80) > A's AABB right-edge (60) → skip
    ///
    /// Neither is classified as contained → both get rank 0 → pure NN ordering.
    ///
    /// This test would fail on the rank assertions if the AABB filter were removed.
    #[test]
    fn partial_overlap_no_false_containment_cycle() {
        let a = make_obj("A", 0.0, 0.0, 60.0, 60.0, None, None);
        let b = make_obj("B", 20.0, 20.0, 60.0, 60.0, None, None);
        let objects = vec![a, b];

        // (a) Terminates — calling the function is sufficient proof; a hang would stall
        // the test runner. Verify both objects appear in the result.
        let order = order_inner_first_nn(&objects, 0.0, 0.0);
        assert_eq!(order.len(), 2, "both objects must appear in the result");

        // (b) Same rank band — neither object is considered inside the other.
        // compute_ranks is the internal function under test; accessible via `use super::*`.
        let outlines: Vec<Vec<Point>> = objects.iter().map(build_object_outline).collect();
        let rep_points: Vec<(f64, f64)> = outlines
            .iter()
            .map(|pts| {
                let p = guaranteed_interior_point(pts);
                (p.x, p.y)
            })
            .collect();
        let ranks = compute_ranks(&outlines, &rep_points);
        assert_eq!(ranks[0], 0, "A must have rank 0 (not considered inside B)");
        assert_eq!(ranks[1], 0, "B must have rank 0 (not considered inside A)");

        // NN from (0,0): A's start point (0,0) beats B's (20,20) — A comes first.
        assert_eq!(order[0], 0, "A (nearest to origin) must be first in pure NN order");
        assert_eq!(order[1], 1, "B must follow");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Part 3 (kerf-hardening-program Relay 1C): adversarial property tests.
    //
    // These tests ARE the audit of the ~67 raw index sites in this module --
    // per the plan, if one of them proves a reachable OOB/panic, that one
    // site gets a minimal fix (see the relay report). No manual sweep of the
    // remaining sites otherwise. No proptest/quickcheck dependency: every
    // fixture below is hand-rolled.
    // ─────────────────────────────────────────────────────────────────────

    // ── No-panic: empty / single-element inputs ────────────────────────────

    #[test]
    fn no_panic_empty_object_list() {
        let empty: Vec<CutObject> = vec![];
        assert_eq!(order_inner_first_nn(&empty, 0.0, 0.0), Vec::<usize>::new());
        assert_eq!(optimize_cut_order_from(&empty, 0.0, 0.0), Vec::<usize>::new());
    }

    #[test]
    fn no_panic_empty_path_list() {
        let mut empty: Vec<PathSegment> = vec![];
        order_paths_inner_first(&mut empty); // must not panic
        assert!(empty.is_empty());
    }

    #[test]
    fn no_panic_single_object() {
        let obj = make_obj("solo", 10.0, 10.0, 5.0, 5.0, None, None);
        let order = order_inner_first_nn(std::slice::from_ref(&obj), 0.0, 0.0);
        assert_eq!(order, vec![0]);
        let order2 = optimize_cut_order_from(&[obj], 0.0, 0.0);
        assert_eq!(order2, vec![0]);
    }

    // ── No-panic: single-point / zero-length / degenerate "contours" ──────

    #[test]
    fn no_panic_degenerate_paths_zero_one_two_points() {
        // Empty path (0 points)
        let empty_path = PathSegment { points: vec![], closed: true };
        // Single-point "contour"
        let one_point_path = PathSegment { points: vec![Point { x: 5.0, y: 5.0 }], closed: true };
        // Zero-length path: two coincident points
        let zero_len_path = PathSegment {
            points: vec![Point { x: 3.0, y: 3.0 }, Point { x: 3.0, y: 3.0 }],
            closed: true,
        };
        let normal = make_rect_path(0.0, 0.0, 50.0, 50.0);

        let degenerate_objs = vec![
            make_obj_with_paths("empty_path_obj", 0.0, 0.0, 0.0, 0.0, vec![empty_path]),
            make_obj_with_paths("one_point_obj", 5.0, 5.0, 0.0, 0.0, vec![one_point_path]),
            make_obj_with_paths("zero_len_obj", 3.0, 3.0, 0.0, 0.0, vec![zero_len_path]),
            make_obj_with_paths("normal_obj", 0.0, 0.0, 50.0, 50.0, vec![normal]),
        ];

        // Must not panic, and must return every object exactly once.
        let order = order_inner_first_nn(&degenerate_objs, 0.0, 0.0);
        assert_is_permutation(&order, degenerate_objs.len());

        // Sub-contour ordering on a single object with degenerate hole paths
        // must also survive without panicking or dropping a path.
        let mut mixed_paths = vec![
            make_rect_path(0.0, 0.0, 50.0, 50.0),
            PathSegment { points: vec![], closed: true },
            PathSegment { points: vec![Point { x: 1.0, y: 1.0 }], closed: true },
        ];
        order_paths_inner_first(&mut mixed_paths); // must not panic
        assert_eq!(mixed_paths.len(), 3, "no path should be dropped");
    }

    // ── No-panic: duplicate / identical objects (mutual-containment stress) ─

    #[test]
    fn no_panic_duplicate_identical_objects() {
        // Two perfectly identical, fully overlapping rectangles: each one's
        // representative point lies inside the other's polygon -- exactly
        // the mutual-containment shape the DFS cycle-guard in compute_ranks
        // exists to survive (see partial_overlap_no_false_containment_cycle
        // for the near-miss case; this is the exact-duplicate extreme). Must
        // terminate without panicking or hanging, and must still return both
        // objects exactly once (a dropped/duplicated object here would mean
        // an un-cut or double-cut part).
        let a = make_obj("dup_a", 10.0, 10.0, 20.0, 20.0, None, None);
        let b = make_obj("dup_b", 10.0, 10.0, 20.0, 20.0, None, None);
        let objs = vec![a, b];
        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_is_permutation(&order, 2);
    }

    #[test]
    fn no_panic_many_duplicate_objects() {
        // Five identical overlapping rectangles -- stress the cycle guard
        // with more than a simple pair.
        let objs: Vec<CutObject> = (0..5)
            .map(|i| make_obj(&format!("dup_{i}"), 0.0, 0.0, 30.0, 30.0, None, None))
            .collect();
        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_is_permutation(&order, 5);
    }

    // ── No-panic: collinear points (zero-area degenerate polygon) ──────────

    #[test]
    fn no_panic_collinear_points_zero_area_polygon() {
        // All points on a horizontal line: signed area is exactly zero, and
        // every point shares the same y -- exactly the case guaranteed_
        // interior_point's scanline fallback (`ys.len() < 2`) exists to
        // handle without panicking.
        let collinear = PathSegment {
            points: vec![
                Point { x: 0.0, y: 5.0 },
                Point { x: 10.0, y: 5.0 },
                Point { x: 20.0, y: 5.0 },
            ],
            closed: true,
        };
        let normal = make_rect_path(0.0, 0.0, 100.0, 100.0);
        let objs = vec![
            make_obj_with_paths("collinear_obj", 0.0, 5.0, 20.0, 0.0, vec![collinear]),
            make_obj_with_paths("normal_obj", 0.0, 0.0, 100.0, 100.0, vec![normal]),
        ];
        let order = order_inner_first_nn(&objs, 0.0, 0.0);
        assert_is_permutation(&order, 2);
    }

    // ── Output-is-a-permutation-of-input (safety-critical invariant) ───────

    /// A dropped object means an un-cut part; a duplicated one means a
    /// double-cut. Assert the optimizer's output is exactly the input
    /// reordered -- no more, no fewer.
    fn assert_is_permutation(order: &[usize], n: usize) {
        assert_eq!(order.len(), n, "output length must equal input length (n={n})");
        let mut seen = vec![false; n];
        for &i in order {
            assert!(i < n, "index {i} out of range for n={n}");
            assert!(!seen[i], "index {i} appeared more than once in order={:?}", order);
            seen[i] = true;
        }
        assert!(seen.iter().all(|&s| s), "not every index appeared in order={:?}", order);
    }

    #[test]
    fn permutation_property_across_hand_rolled_fixtures() {
        // (a) Flat list of non-overlapping siblings
        let flat: Vec<CutObject> = (0..15)
            .map(|i| make_obj(&format!("flat_{i}"), (i as f64) * 30.0, 0.0, 10.0, 10.0, None, None))
            .collect();
        assert_is_permutation(&order_inner_first_nn(&flat, 0.0, 0.0), flat.len());

        // (b) Nested rectangles at varying depths (5 levels; see also the
        // dedicated rank-monotonicity test below)
        let nested = vec![
            make_obj("n0", 0.0, 0.0, 100.0, 100.0, None, None),
            make_obj("n1", 10.0, 10.0, 80.0, 80.0, None, None),
            make_obj("n2", 20.0, 20.0, 60.0, 60.0, None, None),
            make_obj("n3", 30.0, 30.0, 40.0, 40.0, None, None),
            make_obj("n4", 40.0, 40.0, 20.0, 20.0, None, None),
        ];
        assert_is_permutation(&order_inner_first_nn(&nested, 0.0, 0.0), nested.len());

        // (c) Mixed: normal objects + a duplicate pair + a degenerate zero-area object
        let degenerate = make_obj_with_paths(
            "degenerate",
            5.0,
            5.0,
            0.0,
            0.0,
            vec![PathSegment { points: vec![Point { x: 5.0, y: 5.0 }], closed: true }],
        );
        let mixed = vec![
            make_obj("m0", 0.0, 0.0, 100.0, 100.0, None, None),
            make_obj("m1", 200.0, 200.0, 10.0, 10.0, None, None),
            make_obj("m1_dup", 200.0, 200.0, 10.0, 10.0, None, None),
            degenerate,
        ];
        assert_is_permutation(&order_inner_first_nn(&mixed, 5.0, 5.0), mixed.len());

        // (d) optimize_cut_order_from (pure NN path) over the same flat set
        assert_is_permutation(&optimize_cut_order_from(&flat, 0.0, 0.0), flat.len());
    }

    // ── Inner-first rank monotonicity: deep nesting (5 levels) ────────────

    /// Extends `three_level_nesting` to 5 levels: for EVERY declared
    /// containment pair (inner, outer) -- not just adjacent levels -- inner's
    /// position in the output must come strictly before outer's. This pins
    /// the rank-monotonicity property the module doc-comment guarantees:
    /// "if A⊂B then rank(A) ≥ rank(B)+1", checked exhaustively rather than
    /// just level-by-level.
    #[test]
    fn deeply_nested_five_levels_rank_monotonicity() {
        let levels = vec![
            make_obj("l0_outer", 0.0, 0.0, 100.0, 100.0, None, None),
            make_obj("l1", 10.0, 10.0, 80.0, 80.0, None, None),
            make_obj("l2", 20.0, 20.0, 60.0, 60.0, None, None),
            make_obj("l3", 30.0, 30.0, 40.0, 40.0, None, None),
            make_obj("l4_innermost", 40.0, 40.0, 20.0, 20.0, None, None),
        ];
        // Presented in worst-case (outermost-first) input order.
        let order = order_inner_first_nn(&levels, 0.0, 0.0);
        assert_is_permutation(&order, levels.len());

        // Every (outer, inner) pair with inner > outer is a real containment
        // relation here (level `inner` is nested inside level `outer` for
        // all inner > outer) -- assert ALL pairs, not just adjacent levels.
        let position_of = |idx: usize| order.iter().position(|&x| x == idx).unwrap();
        for outer in 0..levels.len() {
            for inner in (outer + 1)..levels.len() {
                assert!(
                    position_of(inner) < position_of(outer),
                    "level {inner} (nested inside level {outer}) must cut before level {outer}; order={:?}",
                    order
                );
            }
        }
    }
}
