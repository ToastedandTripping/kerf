use super::gcode_gen::CutObject;

/// Optimize cut order using nearest-neighbor heuristic
/// Returns indices into the original objects vec in optimized order
pub fn optimize_cut_order(objects: &[CutObject]) -> Vec<usize> {
    if objects.is_empty() {
        return vec![];
    }

    let n = objects.len();
    let mut visited = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut cur_x = 0.0_f64;
    let mut cur_y = 0.0_f64;

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

/// Sort objects so inner shapes come before outer shapes
/// (smaller bounding box area = more inner)
pub fn sort_inner_first(objects: &mut [CutObject]) {
    objects.sort_by(|a, b| {
        let area_a = a.width * a.height;
        let area_b = b.width * b.height;
        area_a.partial_cmp(&area_b).unwrap_or(std::cmp::Ordering::Equal)
    });
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
