import { useState, useRef, useEffect, useCallback } from "react";

export interface CurvePoint {
  x: number; // 0-255 (input shade)
  y: number; // 0-100 (output power %)
}

const PRESETS: Record<string, CurvePoint[]> = {
  Linear: [
    { x: 0, y: 0 },
    { x: 255, y: 100 },
  ],
  "S-Curve": [
    { x: 0, y: 0 },
    { x: 64, y: 10 },
    { x: 128, y: 50 },
    { x: 192, y: 90 },
    { x: 255, y: 100 },
  ],
  Posterize: [
    { x: 0, y: 0 },
    { x: 84, y: 0 },
    { x: 85, y: 33 },
    { x: 169, y: 33 },
    { x: 170, y: 66 },
    { x: 254, y: 66 },
    { x: 255, y: 100 },
  ],
};

const CANVAS_W = 480;
const CANVAS_H = 280;
const HIT_RADIUS = 12;
const POINT_RADIUS = 5;
const POINT_RADIUS_HOVER = 7;

function shadeToCanvasX(shade: number): number {
  return (shade / 255) * CANVAS_W;
}
function canvasXToShade(cx: number): number {
  return (cx / CANVAS_W) * 255;
}
function powerToCanvasY(power: number): number {
  return CANVAS_H - (power / 100) * CANVAS_H;
}
function canvasYToPower(cy: number): number {
  return ((CANVAS_H - cy) / CANVAS_H) * 100;
}

/** Monotone cubic spline interpolation (Fritsch-Carlson) */
function evaluateSpline(points: CurvePoint[], xVal: number): number {
  const n = points.length;
  if (n < 2) return 0;
  if (xVal <= points[0].x) return points[0].y;
  if (xVal >= points[n - 1].x) return points[n - 1].y;

  // Find segment
  let seg = 0;
  for (let i = 0; i < n - 1; i++) {
    if (points[i + 1].x >= xVal) {
      seg = i;
      break;
    }
  }

  // Compute tangents
  const tangents = new Array(n).fill(0);
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = Math.max(points[i + 1].x - points[i].x, 0.001);
    secants.push((points[i + 1].y - points[i].y) / dx);
  }
  tangents[0] = secants[0];
  tangents[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangents[i] = (secants[i - 1] + secants[i]) / 2;
  }
  // Monotonicity enforcement
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(secants[i]) < 1e-10) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const alpha = tangents[i] / secants[i];
      const beta = tangents[i + 1] / secants[i];
      const tau = alpha * alpha + beta * beta;
      if (tau > 9) {
        const s = 3 / Math.sqrt(tau);
        tangents[i] = s * alpha * secants[i];
        tangents[i + 1] = s * beta * secants[i];
      }
    }
  }

  const dx = Math.max(points[seg + 1].x - points[seg].x, 0.001);
  const t = Math.max(0, Math.min(1, (xVal - points[seg].x) / dx));
  const t2 = t * t;
  const t3 = t2 * t;

  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return (
    h00 * points[seg].y +
    h10 * dx * tangents[seg] +
    h01 * points[seg + 1].y +
    h11 * dx * tangents[seg + 1]
  );
}

function pointsMatch(a: CurvePoint[], b: CurvePoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.x - b[i].x) < 0.5 && Math.abs(p.y - b[i].y) < 0.5);
}

export function PowerCurveEditor({
  open,
  points: initialPoints,
  onApply,
  onClose,
}: {
  open: boolean;
  points: CurvePoint[];
  onApply: (points: CurvePoint[]) => void;
  onClose: () => void;
}) {
  const [points, setPoints] = useState<CurvePoint[]>(initialPoints);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const titleId = "power-curve-title";

  useEffect(() => {
    if (open) setPoints(initialPoints);
  }, [open, initialPoints]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Grid lines (10x10)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = (CANVAS_W / 10) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
      const y = (CANVAS_H / 10) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }

    // Identity diagonal (dashed)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, CANVAS_H);
    ctx.lineTo(CANVAS_W, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Curve
    ctx.strokeStyle = "#c4a57b";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let px = 0; px <= CANVAS_W; px++) {
      const shade = canvasXToShade(px);
      const power = evaluateSpline(points, shade);
      const cy = powerToCanvasY(Math.max(0, Math.min(100, power)));
      if (px === 0) ctx.moveTo(px, cy);
      else ctx.lineTo(px, cy);
    }
    ctx.stroke();

    // Control points
    for (let i = 0; i < points.length; i++) {
      const cx = shadeToCanvasX(points[i].x);
      const cy = powerToCanvasY(points[i].y);
      const isActive = dragIndex === i;
      const isHover = hoverIndex === i;

      ctx.beginPath();
      ctx.arc(cx, cy, isActive || isHover ? POINT_RADIUS_HOVER : POINT_RADIUS, 0, Math.PI * 2);

      if (isActive) {
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "rgba(196, 165, 123, 0.6)";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (isHover) {
        ctx.fillStyle = "#d4b58b";
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = "#c4a57b";
        ctx.fill();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }, [points, dragIndex, hoverIndex]);

  useEffect(() => {
    draw();
  }, [draw]);

  const findPointAt = useCallback(
    (cx: number, cy: number): number | null => {
      for (let i = 0; i < points.length; i++) {
        const px = shadeToCanvasX(points[i].x);
        const py = powerToCanvasY(points[i].y);
        if (Math.hypot(cx - px, cy - py) <= HIT_RADIUS) return i;
      }
      return null;
    },
    [points],
  );

  const getCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [cx, cy] = getCanvasPos(e);
    const idx = findPointAt(cx, cy);
    if (idx !== null) {
      setDragIndex(idx);
    } else {
      // Add new point at current curve value
      const shade = Math.max(0, Math.min(255, canvasXToShade(cx)));
      const power = Math.max(0, Math.min(100, evaluateSpline(points, shade)));
      const newPoint = { x: shade, y: power };
      const newPoints = [...points, newPoint].sort((a, b) => a.x - b.x);
      setPoints(newPoints);
      // Find the new point's index to start dragging it
      const newIdx = newPoints.findIndex((p) => p === newPoint);
      setDragIndex(newIdx >= 0 ? newIdx : null);
    }
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [cx, cy] = getCanvasPos(e);

    if (dragIndex !== null) {
      const updated = [...points];
      const isEndpoint0 = dragIndex === 0;
      const isEndpointN = dragIndex === points.length - 1;

      let newX = Math.max(0, Math.min(255, canvasXToShade(cx)));
      const newY = Math.max(0, Math.min(100, canvasYToPower(cy)));

      // Endpoints: x-locked
      if (isEndpoint0) {
        newX = 0;
      } else if (isEndpointN) {
        newX = 255;
      } else {
        // Intermediate: clamp x between neighbors
        const prevX = points[dragIndex - 1].x + 1;
        const nextX = points[dragIndex + 1].x - 1;
        newX = Math.max(prevX, Math.min(nextX, newX));
      }

      updated[dragIndex] = { x: newX, y: newY };
      setPoints(updated);
    } else {
      setHoverIndex(findPointAt(cx, cy));
    }
  };

  const onMouseUp = () => {
    setDragIndex(null);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const [cx, cy] = getCanvasPos(e);
    const idx = findPointAt(cx, cy);
    if (idx !== null && idx !== 0 && idx !== points.length - 1) {
      setPoints(points.filter((_, i) => i !== idx));
    }
  };

  const getCursorStyle = (): string => {
    if (dragIndex !== null) return "grabbing";
    if (hoverIndex !== null) return "grab";
    return "crosshair";
  };

  const activePreset = Object.entries(PRESETS).find(([, pts]) => pointsMatch(points, pts))?.[0] ?? null;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 9999,
        }}
      />
      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
          zIndex: 10000,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Title */}
        <div
          id={titleId}
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Power Curve
        </div>

        {/* Canvas area */}
        <div style={{ position: "relative" }}>
          {/* Y axis label */}
          <span
            style={{
              position: "absolute",
              left: -24,
              top: "50%",
              transform: "translateY(-50%) rotate(-90deg)",
              fontSize: 10,
              color: "var(--text-muted)",
              fontFamily: "var(--font-sans)",
              whiteSpace: "nowrap",
            }}
          >
            Output (power %)
          </span>

          {/* Y tick labels */}
          <div
            style={{
              position: "absolute",
              left: -20,
              top: 0,
              height: CANVAS_H,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              alignItems: "flex-end",
              pointerEvents: "none",
            }}
          >
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>100%</span>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>50%</span>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>0%</span>
          </div>

          <div
            style={{
              background: "#111111",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              marginLeft: 0,
            }}
          >
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              style={{ cursor: getCursorStyle(), display: "block" }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onContextMenu={onContextMenu}
            />
          </div>

          {/* X axis label + ticks */}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>0</span>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>128</span>
            <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>255</span>
          </div>
          <div
            style={{
              textAlign: "center",
              fontSize: 10,
              color: "var(--text-muted)",
              marginTop: 6,
              fontFamily: "var(--font-sans)",
            }}
          >
            Input (shade)
          </div>
        </div>

        {/* Preset buttons */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {Object.entries(PRESETS).map(([name, pts]) => {
            const isActive = activePreset === name;
            return (
              <button
                key={name}
                onClick={() => setPoints([...pts])}
                style={{
                  padding: "4px 10px",
                  fontSize: 11,
                  borderRadius: "var(--radius-sm)",
                  border: isActive ? "1px solid #c4a57b" : "1px solid var(--border)",
                  background: isActive ? "rgba(196, 165, 123, 0.12)" : "var(--bg-input)",
                  color: isActive ? "#c4a57b" : "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                {name}
              </button>
            );
          })}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              padding: "6px 16px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onApply(points)}
            style={{
              background: "#c4a57b",
              border: "none",
              color: "#ffffff",
              padding: "6px 16px",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </>
  );
}

/** Miniature curve thumbnail for LayerPanel */
export function PowerCurveThumbnail({
  points,
  width = 48,
  height = 32,
}: {
  points: CurvePoint[];
  width?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    // Curve
    ctx.strokeStyle = "#c4a57b";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    for (let px = 0; px <= width; px++) {
      const shade = (px / width) * 255;
      const power = evaluateSpline(points, shade);
      const cy = height - (Math.max(0, Math.min(100, power)) / 100) * height;
      if (px === 0) ctx.moveTo(px, cy);
      else ctx.lineTo(px, cy);
    }
    ctx.stroke();
  }, [points, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        background: "#111111",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
      }}
    />
  );
}
