/** Pixels per mm at 96 DPI (~96dpi → mm conversion for screen display) */
export const PX_PER_MM = 3.78;

/** Millimetres per inch. Exact by definition (international inch, 1959). */
export const MM_PER_INCH = 25.4;

/** PostScript/PDF points per inch. Exact by definition. */
export const PT_PER_INCH = 72;

/** R2 F6: distance of the rotate handle above the selection's top edge, in screen px. */
export const ROTATE_HANDLE_OFFSET_PX = 20;

/**
 * R2 F6: a screen-pixel size as world millimetres at `zoom`. Tool handlers
 * receive world coordinates in mm, so every screen-sized hit target goes
 * through this one conversion (px / zoom alone is 3.78x too large).
 */
export function screenPxToMm(px: number, zoom: number): number {
  return px / (zoom * PX_PER_MM);
}

/** Minimum zoom level (5% -- furthest out). */
export const MIN_ZOOM = 0.05;

/** Maximum zoom level (5000% -- closest in). */
export const MAX_ZOOM = 50;

/** Format a duration in seconds to a human-readable string (e.g. "3m 12s", "1h 5m"). */
export function formatTime(secs: number): string {
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
