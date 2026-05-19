use super::gcode_gen::Point;

/// Offset a closed polygon inward by `distance`.
/// Returns the offset ring, or None if the polygon collapses.
/// Uses vertex-normal averaging with miter clamping for robust concave handling.
pub fn offset_polygon_inward(
    points: &[Point],
    distance: f64,
) -> Option<Vec<Point>> {
    let n = points.len();
    if n < 3 || distance <= 0.0 {
        return Some(points.to_vec());
    }

    // Determine winding direction via signed area
    let area = signed_area(points);
    if area.abs() < 1e-10 {
        return None; // Degenerate
    }

    // For a CCW polygon (positive area), interior is to the LEFT of each edge.
    // Left normal of edge (dx, dy) is (-dy, dx).
    // For CW (negative area), interior is to the RIGHT: normal is (dy, -dx).
    // We normalize: sign = 1 for CCW, -1 for CW.
    let sign = if area > 0.0 { 1.0 } else { -1.0 };

    let mut result = Vec::with_capacity(n);

    for i in 0..n {
        let prev = &points[(i + n - 1) % n];
        let curr = &points[i];
        let next = &points[(i + 1) % n];

        // Edge vectors
        let dx1 = curr.x - prev.x;
        let dy1 = curr.y - prev.y;
        let dx2 = next.x - curr.x;
        let dy2 = next.y - curr.y;

        let len1 = (dx1 * dx1 + dy1 * dy1).sqrt();
        let len2 = (dx2 * dx2 + dy2 * dy2).sqrt();

        if len1 < 1e-10 || len2 < 1e-10 {
            result.push(curr.clone());
            continue;
        }

        // Inward-pointing normals (left normal for CCW, right normal for CW)
        let nx1 = sign * (-dy1 / len1);
        let ny1 = sign * (dx1 / len1);
        let nx2 = sign * (-dy2 / len2);
        let ny2 = sign * (dx2 / len2);

        // Average normal
        let nx = nx1 + nx2;
        let ny = ny1 + ny2;
        let nlen = (nx * nx + ny * ny).sqrt();

        if nlen < 1e-10 {
            // Collinear edges, use single normal
            result.push(Point {
                x: curr.x + nx1 * distance,
                y: curr.y + ny1 * distance,
            });
            continue;
        }

        // The offset distance along the bisector:
        // For unit normals n1, n2, the bisector has length |n1+n2| = 2*cos(theta/2)
        // The offset along the bisector = distance / cos(theta/2) = distance * 2 / |n1+n2|
        // But we also normalize, so final: distance / (nlen / 2) = 2*distance / nlen
        // However, we need to clamp to avoid extreme miter on sharp corners.
        let miter_factor = (2.0 / nlen).min(4.0);
        let offset_dist = distance * miter_factor;

        result.push(Point {
            x: curr.x + (nx / nlen) * offset_dist,
            y: curr.y + (ny / nlen) * offset_dist,
        });
    }

    // Validate: check the result has the same-sign area as input and didn't grow
    let result_area = signed_area(&result);
    let input_area = area.abs();
    if result_area.abs() < 1e-6 || (result_area * area) < 0.0 || result_area.abs() > input_area {
        return None; // Collapsed, inverted, or grew (offset overshot)
    }

    // Remove self-intersections
    let cleaned = remove_self_intersections(&result);
    if cleaned.len() < 3 {
        return None;
    }

    Some(cleaned)
}

/// Generate concentric offset rings spiraling inward until the polygon collapses.
/// Returns a Vec of rings (each ring is a closed polygon).
pub fn generate_offset_rings(
    points: &[Point],
    interval: f64,
) -> Vec<Vec<Point>> {
    if points.len() < 3 || interval <= 0.0 {
        return vec![];
    }

    let mut rings = Vec::new();
    // First ring is the original polygon
    rings.push(points.to_vec());

    let mut current = points.to_vec();
    let original_area = signed_area(points).abs();
    let min_area = interval * interval * 0.1; // Stop when area becomes tiny

    for _ in 0..1000 {
        match offset_polygon_inward(&current, interval) {
            Some(next) if next.len() >= 3 => {
                let area = signed_area(&next).abs();
                if area < min_area || area > original_area {
                    break; // Too small or grew (error)
                }
                rings.push(next.clone());
                current = next;
            }
            _ => break,
        }
    }

    rings
}

/// Signed area of a polygon (positive = CCW, negative = CW)
fn signed_area(pts: &[Point]) -> f64 {
    let n = pts.len();
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += pts[i].x * pts[j].y;
        area -= pts[j].x * pts[i].y;
    }
    area / 2.0
}

/// Iterative self-intersection removal: walk the polygon, detect crossing edges,
/// keep the larger loop. Repeats up to 10 times to handle multiple self-intersections
/// that can arise from offsetting complex concave polygons.
fn remove_self_intersections(pts: &[Point]) -> Vec<Point> {
    let mut current = pts.to_vec();

    for _ in 0..10 {
        let n = current.len();
        if n < 4 {
            return current;
        }

        let mut found = false;

        // Check all non-adjacent edge pairs for intersections
        'outer: for i in 0..n {
            let i_next = (i + 1) % n;
            for j in (i + 2)..n {
                if j == n - 1 && i == 0 {
                    continue; // Adjacent pair (last, first)
                }
                let j_next = (j + 1) % n;

                if let Some((t, u, int_pt)) = segment_intersection(
                    &current[i], &current[i_next],
                    &current[j], &current[j_next],
                ) {
                    if t > 1e-10 && t < 1.0 - 1e-10 && u > 1e-10 && u < 1.0 - 1e-10 {
                        // Build loop A: 0..=i, int_pt, j+1..end
                        let mut loop_a = Vec::new();
                        for k in 0..=i {
                            loop_a.push(current[k].clone());
                        }
                        loop_a.push(int_pt.clone());
                        for k in (j + 1)..n {
                            loop_a.push(current[k].clone());
                        }

                        // Build loop B: int_pt, i+1..=j
                        let mut loop_b = Vec::new();
                        loop_b.push(int_pt.clone());
                        for k in (i + 1)..=j {
                            loop_b.push(current[k].clone());
                        }

                        // Keep the larger loop
                        let area_a = signed_area(&loop_a).abs();
                        let area_b = signed_area(&loop_b).abs();

                        current = if area_a >= area_b && loop_a.len() >= 3 {
                            loop_a
                        } else if loop_b.len() >= 3 {
                            loop_b
                        } else {
                            return current;
                        };
                        found = true;
                        break 'outer;
                    }
                }
            }
        }

        if !found {
            break; // No more self-intersections
        }
    }

    current
}

/// Line segment intersection: returns (t, u, point) where t is parameter on seg1, u on seg2
fn segment_intersection(
    a1: &Point, a2: &Point,
    b1: &Point, b2: &Point,
) -> Option<(f64, f64, Point)> {
    let dx_a = a2.x - a1.x;
    let dy_a = a2.y - a1.y;
    let dx_b = b2.x - b1.x;
    let dy_b = b2.y - b1.y;

    let denom = dx_a * dy_b - dy_a * dx_b;
    if denom.abs() < 1e-12 {
        return None; // Parallel
    }

    let dx_ab = b1.x - a1.x;
    let dy_ab = b1.y - a1.y;

    let t = (dx_ab * dy_b - dy_ab * dx_b) / denom;
    let u = (dx_ab * dy_a - dy_ab * dx_a) / denom;

    if t >= 0.0 && t <= 1.0 && u >= 0.0 && u <= 1.0 {
        Some((t, u, Point {
            x: a1.x + t * dx_a,
            y: a1.y + t * dy_a,
        }))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(size: f64) -> Vec<Point> {
        // CCW winding (positive signed area)
        vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: size, y: 0.0 },
            Point { x: size, y: size },
            Point { x: 0.0, y: size },
        ]
    }

    #[test]
    fn square_inward_offset_produces_smaller_square() {
        let pts = square(10.0);
        let result = offset_polygon_inward(&pts, 1.0).unwrap();
        assert_eq!(result.len(), 4);
        // Each corner should be offset inward by 1mm
        for pt in &result {
            assert!(pt.x >= 0.9 && pt.x <= 9.1, "x={}", pt.x);
            assert!(pt.y >= 0.9 && pt.y <= 9.1, "y={}", pt.y);
        }
    }

    #[test]
    fn offset_until_vanish_produces_finite_rings() {
        let pts = square(10.0);
        let rings = generate_offset_rings(&pts, 1.0);
        // 10mm square at 1mm interval: expect ~5-6 rings (10/2 = 5 offsets until center)
        assert!(rings.len() >= 4 && rings.len() <= 7, "got {} rings", rings.len());
    }

    #[test]
    fn concave_l_shape_no_self_intersections() {
        // L-shape (CCW)
        let pts = vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 10.0, y: 0.0 },
            Point { x: 10.0, y: 5.0 },
            Point { x: 5.0, y: 5.0 },
            Point { x: 5.0, y: 10.0 },
            Point { x: 0.0, y: 10.0 },
        ];
        let result = offset_polygon_inward(&pts, 1.0);
        assert!(result.is_some());
        let ring = result.unwrap();
        assert!(ring.len() >= 3);
    }

    #[test]
    fn star_shape_offset_removes_multiple_self_intersections() {
        // 6-pointed star (CCW) -- offsetting inward creates multiple self-intersections
        let pts = vec![
            Point { x: 5.0, y: 0.0 },
            Point { x: 6.5, y: 3.5 },
            Point { x: 10.0, y: 5.0 },
            Point { x: 6.5, y: 6.5 },
            Point { x: 5.0, y: 10.0 },
            Point { x: 3.5, y: 6.5 },
            Point { x: 0.0, y: 5.0 },
            Point { x: 3.5, y: 3.5 },
        ];
        // A moderate offset should still produce a valid polygon
        let result = offset_polygon_inward(&pts, 1.0);
        assert!(result.is_some(), "Star offset should not collapse at 1mm");
        let ring = result.unwrap();
        assert!(ring.len() >= 3, "Result should have at least 3 points");

        // Verify no self-intersections remain by checking all non-adjacent edge pairs
        let n = ring.len();
        for i in 0..n {
            let i_next = (i + 1) % n;
            for j in (i + 2)..n {
                if j == n - 1 && i == 0 { continue; }
                let j_next = (j + 1) % n;
                if let Some((t, u, _)) = segment_intersection(
                    &ring[i], &ring[i_next],
                    &ring[j], &ring[j_next],
                ) {
                    assert!(
                        t <= 1e-10 || t >= 1.0 - 1e-10 || u <= 1e-10 || u >= 1.0 - 1e-10,
                        "Found self-intersection at edges {}-{} and {}-{}: t={}, u={}",
                        i, i_next, j, j_next, t, u
                    );
                }
            }
        }
    }

    #[test]
    fn tiny_polygon_collapses() {
        let pts = vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.0 },
            Point { x: 0.5, y: 0.5 },
        ];
        // Offset by more than the inscribed circle radius should eventually collapse
        let result = offset_polygon_inward(&pts, 5.0);
        // Either None or a very small polygon
        if let Some(ring) = result {
            let area = signed_area(&ring).abs();
            // The offset should have collapsed or be much smaller
            assert!(ring.len() < 3 || area < 1.0, "area={}, len={}", area, ring.len());
        }
    }
}
