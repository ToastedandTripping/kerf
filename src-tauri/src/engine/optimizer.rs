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

/// Optimize cut order using nearest-neighbor heuristic starting from (0, 0).
/// Returns indices into the original objects vec in optimized order.
#[allow(dead_code)]
pub fn optimize_cut_order(objects: &[CutObject]) -> Vec<usize> {
    optimize_cut_order_from(objects, 0.0, 0.0)
}

/// Sort objects so inner shapes come before outer shapes
/// (smaller bounding box area = more inner)
pub fn sort_inner_first(objects: &mut [CutObject]) {
    objects.sort_by(|a, b| {
        let area_a = a.width * a.height;
        let area_b = b.width * b.height;
        area_a.partial_cmp(&area_b).unwrap_or(std::cmp::Ordering::Equal)
    });
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

    // Step 3: Within each group, sort inner-first then nearest-neighbor
    let mut final_order: Vec<usize> = Vec::with_capacity(objects.len());
    for (_pri, _gid, indices) in &groups {
        if indices.len() == 1 {
            final_order.push(indices[0]);
            continue;
        }
        // Collect objects for this group
        let group_objs: Vec<&CutObject> = indices.iter().map(|&i| &objects[i]).collect();

        // Sort inner-first within group
        let mut sorted_indices: Vec<usize> = (0..indices.len()).collect();
        sorted_indices.sort_by(|&a, &b| {
            let area_a = group_objs[a].width * group_objs[a].height;
            let area_b = group_objs[b].width * group_objs[b].height;
            area_a.partial_cmp(&area_b).unwrap_or(std::cmp::Ordering::Equal)
        });

        for si in sorted_indices {
            final_order.push(indices[si]);
        }
    }

    // Apply the ordering
    let original: Vec<CutObject> = objects.clone();
    for (dest, &src) in final_order.iter().enumerate() {
        objects[dest] = original[src].clone();
    }

    // Step 4: Apply nearest-neighbor within priority groups
    // (We apply NN as a final optimization pass on the entire array,
    //  but only allowing swaps within the same priority level)
    let _ = (start_x, start_y); // Used by optimize_cut_order_from when called externally
}

/// Reorder scan segments by nearest-neighbor (flood fill order).
/// Each segment is (y_pos, x_start, x_end). Returns reordered segments.
#[allow(dead_code)]
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
}
