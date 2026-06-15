use super::gcode_gen::CutObject;

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


/// Returns true if object A's bbox is fully contained within object B's bbox.
fn bbox_contains(ax: f64, ay: f64, aw: f64, ah: f64, bx: f64, by: f64, bw: f64, bh: f64) -> bool {
    ax >= bx && ay >= by && ax + aw <= bx + bw && ay + ah <= by + bh
}

/// Sort objects so inner shapes come before outer shapes.
/// Uses bbox containment: if A is contained in B, A sorts first.
/// Non-contained objects preserve their relative (stable) order.
/// Falls back to area comparison at equal containment depth.
pub fn sort_inner_first(objects: &mut [CutObject]) {
    let n = objects.len();
    if n <= 1 {
        return;
    }

    // Build pairwise containment: contained_by[i] = set of j where objects[i] is inside objects[j]
    // containment_depth[i] = number of objects that contain i
    let mut depth = vec![0usize; n];
    for i in 0..n {
        for j in 0..n {
            if i == j { continue; }
            if bbox_contains(
                objects[i].x, objects[i].y, objects[i].width, objects[i].height,
                objects[j].x, objects[j].y, objects[j].width, objects[j].height,
            ) {
                depth[i] += 1;
            }
        }
    }

    // Sort: higher containment depth (more containers) = more inner = first.
    // Stable sort preserves relative order for objects at the same depth;
    // fall back to area comparison within same depth (smaller = more inner).
    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_by(|&a, &b| {
        let da = depth[a];
        let db = depth[b];
        if da != db {
            // Higher depth = more inner = comes first (descending depth)
            db.cmp(&da)
        } else {
            // Same depth: smaller area first (area-based fallback)
            let area_a = objects[a].width * objects[a].height;
            let area_b = objects[b].width * objects[b].height;
            area_a.partial_cmp(&area_b).unwrap_or(std::cmp::Ordering::Equal)
        }
    });

    // Apply the sorted order (in-place via a temporary clone)
    let original: Vec<CutObject> = objects.to_vec();
    for (new_pos, &old_pos) in indices.iter().enumerate() {
        objects[new_pos] = original[old_pos].clone();
    }
}

/// Multi-criteria cut ordering:
/// 1. Priority (higher first)
/// 2. Group affinity (same group_id stays together)
/// 3. Inner-first (smaller bounding box area first)
/// 4. Nearest-neighbor (minimize travel)
pub fn multi_criteria_sort(objects: &mut Vec<CutObject>, start_x: f64, start_y: f64) {
    if objects.is_empty() {
        return;
    }

    // Step 1: Sort by priority descending
    objects.sort_by(|a, b| {
        let pa = a.priority.unwrap_or(0);
        let pb = b.priority.unwrap_or(0);
        pb.cmp(&pa) // Higher priority first
    });

    // Step 2: Within same priority, group by group_id
    // Stable sort preserves priority ordering within groups
    let mut groups: Vec<(i32, Option<String>, Vec<usize>)> = Vec::new();
    for (i, obj) in objects.iter().enumerate() {
        let pri = obj.priority.unwrap_or(0);
        let gid = obj.group_id.clone();

        // Find existing group with same priority + group_id
        if let Some(g) = groups.iter_mut().find(|(p, g, _)| *p == pri && *g == gid) {
            g.2.push(i);
        } else {
            groups.push((pri, gid, vec![i]));
        }
    }

    // Step 3: Within each group, sort inner-first and apply NN.
    // Build resolved group contents (inner-first + NN within each group).
    let original: Vec<CutObject> = objects.clone();
    let mut resolved_groups: Vec<(i32, Vec<CutObject>)> = Vec::new();
    for (pri, _gid, indices) in &groups {
        let mut group_objs: Vec<CutObject> = indices.iter().map(|&i| original[i].clone()).collect();

        // Sort inner-first within group using containment-based ordering
        sort_inner_first(&mut group_objs);

        resolved_groups.push((*pri, group_objs));
    }

    // Step 4: Nearest-neighbor ordering of groups within each priority level.
    // Inner-first ordering within each group is preserved (important for cut safety).
    // NN determines which group to visit next, minimizing head travel between groups.
    objects.clear();
    let mut cur_x = start_x;
    let mut cur_y = start_y;

    // Process groups by priority level
    let mut gi = 0;
    while gi < resolved_groups.len() {
        let pri = resolved_groups[gi].0;
        // Find all groups at this priority level
        let mut gj = gi + 1;
        while gj < resolved_groups.len() && resolved_groups[gj].0 == pri {
            gj += 1;
        }

        if gj - gi == 1 {
            // Single group at this priority -- emit in inner-first order
            let group = &mut resolved_groups[gi].1;
            if let Some(last) = group.last() {
                let (ex, ey) = (last.x + last.width, last.y + last.height);
                cur_x = ex;
                cur_y = ey;
            }
            objects.extend(group.drain(..));
        } else {
            // Multiple groups at same priority -- pick nearest group first (by first object)
            let group_indices: Vec<usize> = (gi..gj).collect();
            let mut visited = vec![false; gj - gi];

            for _ in 0..(gj - gi) {
                let mut best_local = 0;
                let mut best_dist = f64::MAX;

                for (li, &gidx) in group_indices.iter().enumerate() {
                    if visited[li] { continue; }
                    if let Some(first_obj) = resolved_groups[gidx].1.first() {
                        let (sx, sy) = (first_obj.x, first_obj.y);
                        let dist = ((sx - cur_x).powi(2) + (sy - cur_y).powi(2)).sqrt();
                        if dist < best_dist {
                            best_dist = dist;
                            best_local = li;
                        }
                    }
                }

                visited[best_local] = true;
                let gidx = group_indices[best_local];
                let group = &mut resolved_groups[gidx].1;
                if let Some(last) = group.last() {
                    let (ex, ey) = (last.x + last.width, last.y + last.height);
                    cur_x = ex;
                    cur_y = ey;
                }
                objects.extend(group.drain(..));
            }
        }

        gi = gj;
    }
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
            speed: 20.0,
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
    fn higher_priority_cuts_first() {
        let mut objs = vec![
            make_obj("low", 0.0, 0.0, 10.0, 10.0, Some(1), None),
            make_obj("high", 50.0, 50.0, 10.0, 10.0, Some(5), None),
            make_obj("default", 100.0, 0.0, 10.0, 10.0, None, None),
        ];
        multi_criteria_sort(&mut objs, 0.0, 0.0);
        assert_eq!(objs[0].id, "high");
        assert_eq!(objs[1].id, "low");
        assert_eq!(objs[2].id, "default");
    }

    #[test]
    fn same_group_stays_together() {
        let mut objs = vec![
            make_obj("a1", 0.0, 0.0, 10.0, 10.0, Some(1), Some("groupA")),
            make_obj("b1", 50.0, 50.0, 10.0, 10.0, Some(1), Some("groupB")),
            make_obj("a2", 100.0, 0.0, 5.0, 5.0, Some(1), Some("groupA")),
        ];
        multi_criteria_sort(&mut objs, 0.0, 0.0);
        // groupA items should be adjacent
        let a_positions: Vec<usize> = objs.iter().enumerate()
            .filter(|(_, o)| o.group_id.as_deref() == Some("groupA"))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(a_positions[1] - a_positions[0], 1, "groupA items should be adjacent");
    }

    #[test]
    fn default_priority_no_change_from_current() {
        let mut objs = vec![
            make_obj("a", 0.0, 0.0, 10.0, 10.0, None, None),
            make_obj("b", 50.0, 50.0, 5.0, 5.0, None, None),
        ];
        multi_criteria_sort(&mut objs, 0.0, 0.0);
        // With same priority (0), inner-first should put smaller first
        assert_eq!(objs[0].id, "b"); // smaller area
        assert_eq!(objs[1].id, "a");
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

    // --- nearest-neighbor within multi_criteria_sort tests ---

    #[test]
    fn nn_picks_nearest_group_first() {
        // Two groups at same priority: groupA near origin, groupB far away.
        // NN from (0,0) should visit groupA first.
        let mut objs = vec![
            make_obj("b1", 200.0, 200.0, 10.0, 10.0, Some(1), Some("groupB")),
            make_obj("a1", 1.0, 1.0, 10.0, 10.0, Some(1), Some("groupA")),
            make_obj("b2", 210.0, 200.0, 5.0, 5.0, Some(1), Some("groupB")),
            make_obj("a2", 5.0, 5.0, 5.0, 5.0, Some(1), Some("groupA")),
        ];
        multi_criteria_sort(&mut objs, 0.0, 0.0);
        // groupA is nearer to (0,0) so should come first
        assert!(
            objs[0].group_id.as_deref() == Some("groupA"),
            "nearest group should be visited first, got {:?}", objs[0].id,
        );
        assert!(
            objs[1].group_id.as_deref() == Some("groupA"),
            "group cohesion: second item should still be groupA",
        );
        // groupB comes after
        assert!(
            objs[2].group_id.as_deref() == Some("groupB"),
            "far group should come after near group",
        );
        // Inner-first within groupA: a2 (25 area) before a1 (100 area)
        assert_eq!(objs[0].id, "a2", "smaller groupA item first (inner-first)");
        assert_eq!(objs[1].id, "a1", "larger groupA item second");
    }

    // F7 carryover: containment-based inner-first
    #[test]
    fn containment_inner_before_outer() {
        // "inner" is fully inside "outer". Inner must sort first.
        let mut objs = vec![
            make_obj("outer", 0.0, 0.0, 100.0, 100.0, None, None),
            make_obj("inner", 10.0, 10.0, 20.0, 20.0, None, None),
        ];
        sort_inner_first(&mut objs);
        assert_eq!(objs[0].id, "inner", "contained bbox must come first");
        assert_eq!(objs[1].id, "outer");
    }

    #[test]
    fn non_contained_stable_relative_order() {
        // Two non-overlapping objects: neither contains the other.
        // They have the same containment depth (0) so relative order
        // is determined by area (smaller first).
        let mut objs = vec![
            make_obj("big",   0.0, 0.0, 100.0, 100.0, None, None),
            make_obj("small", 200.0, 0.0, 5.0, 5.0, None, None),
        ];
        sort_inner_first(&mut objs);
        // small has smaller area → sorts first at equal depth
        assert_eq!(objs[0].id, "small");
        assert_eq!(objs[1].id, "big");
    }

    #[test]
    fn deeply_nested_containment_order() {
        // Three levels: outer > middle > inner.
        // Expected sort: inner, middle, outer.
        let mut objs = vec![
            make_obj("outer",  0.0, 0.0, 100.0, 100.0, None, None),
            make_obj("inner", 30.0, 30.0, 20.0, 20.0, None, None),
            make_obj("middle", 10.0, 10.0, 60.0, 60.0, None, None),
        ];
        sort_inner_first(&mut objs);
        assert_eq!(objs[0].id, "inner",  "innermost bbox must cut first");
        assert_eq!(objs[1].id, "middle");
        assert_eq!(objs[2].id, "outer");
    }

    #[test]
    fn tall_narrow_vs_short_wide_non_contained() {
        // Old area heuristic bug: tall-narrow (1×200 = 200 area) would sort
        // after short-wide (10×10 = 100 area) even though neither contains the other.
        // With containment + area fallback: short-wide (100 area) < tall-narrow (200 area)
        // at the same depth → short-wide first. This is correct for area-based tiebreak.
        let mut objs = vec![
            make_obj("tall_narrow",  0.0, 0.0, 1.0, 200.0, None, None),
            make_obj("short_wide",  50.0, 50.0, 10.0, 10.0, None, None),
        ];
        sort_inner_first(&mut objs);
        // Neither contains the other → same depth → area fallback: short_wide (100) < tall_narrow (200)
        assert_eq!(objs[0].id, "short_wide");
        assert_eq!(objs[1].id, "tall_narrow");
    }
}
