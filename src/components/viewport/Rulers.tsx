import { useRef, useEffect, useCallback } from "react";
import { useStore } from "../../app/store";

import { PX_PER_MM } from "../../lib/constants";
const RULER_SIZE = 24; // px thickness of ruler bar
const BG = "#1e1e1e";
const TICK_COLOR = "rgba(255,255,255,0.35)";
const LABEL_COLOR = "rgba(255,255,255,0.5)";
const MAJOR_TICK_COLOR = "rgba(255,255,255,0.5)";

export function Rulers() {
  const hCanvasRef = useRef<HTMLCanvasElement>(null);
  const vCanvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useStore((s) => s.camera);
  const gridVisible = useStore((s) => s.gridVisible);

  const drawHorizontal = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement?.clientWidth || canvas.width;
    canvas.width = w * dpr;
    canvas.height = RULER_SIZE * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${RULER_SIZE}px`;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, RULER_SIZE);

    // Bottom border
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_SIZE - 0.5);
    ctx.lineTo(w, RULER_SIZE - 0.5);
    ctx.stroke();

    // Calculate tick spacing based on zoom
    const scale = camera.zoom * PX_PER_MM; // px per mm at current zoom
    const { interval, subdivisions } = getTickInterval(scale);

    // World coordinates visible
    const worldLeft = -camera.x / camera.zoom / PX_PER_MM;
    const worldRight = (w - camera.x) / camera.zoom / PX_PER_MM;

    // Start from first tick before visible area
    const startMm = Math.floor(worldLeft / interval) * interval;

    ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let mm = startMm; mm <= worldRight; mm += interval / subdivisions) {
      const screenX = camera.x + mm * PX_PER_MM * camera.zoom;
      if (screenX < RULER_SIZE || screenX > w) continue; // skip corner area

      const isMajor = Math.abs(mm % interval) < 0.001;
      const isMid = Math.abs(mm % (interval / 2)) < 0.001;

      if (isMajor) {
        ctx.strokeStyle = MAJOR_TICK_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX, RULER_SIZE);
        ctx.lineTo(screenX, 4);
        ctx.stroke();

        // Label
        ctx.fillStyle = LABEL_COLOR;
        const label = mm >= 1000 || mm <= -1000 ? `${(mm / 10).toFixed(0)}cm` : `${mm.toFixed(0)}`;
        ctx.fillText(label, screenX, 2);
      } else if (isMid) {
        ctx.strokeStyle = TICK_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(screenX, RULER_SIZE);
        ctx.lineTo(screenX, RULER_SIZE - 8);
        ctx.stroke();
      } else {
        ctx.strokeStyle = TICK_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(screenX, RULER_SIZE);
        ctx.lineTo(screenX, RULER_SIZE - 4);
        ctx.stroke();
      }
    }
  }, [camera]);

  const drawVertical = useCallback((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const h = canvas.parentElement?.clientHeight || canvas.height;
    canvas.width = RULER_SIZE * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${RULER_SIZE}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, RULER_SIZE, h);

    // Right border
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(RULER_SIZE - 0.5, 0);
    ctx.lineTo(RULER_SIZE - 0.5, h);
    ctx.stroke();

    // Calculate tick spacing
    const scale = camera.zoom * PX_PER_MM;
    const { interval, subdivisions } = getTickInterval(scale);

    const worldTop = -camera.y / camera.zoom / PX_PER_MM;
    const worldBottom = (h - camera.y) / camera.zoom / PX_PER_MM;

    const startMm = Math.floor(worldTop / interval) * interval;

    ctx.font = "9px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let mm = startMm; mm <= worldBottom; mm += interval / subdivisions) {
      const screenY = camera.y + mm * PX_PER_MM * camera.zoom;
      if (screenY < RULER_SIZE || screenY > h) continue;

      const isMajor = Math.abs(mm % interval) < 0.001;
      const isMid = Math.abs(mm % (interval / 2)) < 0.001;

      if (isMajor) {
        ctx.strokeStyle = MAJOR_TICK_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(RULER_SIZE, screenY);
        ctx.lineTo(4, screenY);
        ctx.stroke();

        // Label (rotated)
        ctx.save();
        ctx.translate(10, screenY);
        ctx.rotate(-Math.PI / 2);
        ctx.fillStyle = LABEL_COLOR;
        const label = mm >= 1000 || mm <= -1000 ? `${(mm / 10).toFixed(0)}cm` : `${mm.toFixed(0)}`;
        ctx.fillText(label, 0, 0);
        ctx.restore();
      } else if (isMid) {
        ctx.strokeStyle = TICK_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(RULER_SIZE, screenY);
        ctx.lineTo(RULER_SIZE - 8, screenY);
        ctx.stroke();
      } else {
        ctx.strokeStyle = TICK_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(RULER_SIZE, screenY);
        ctx.lineTo(RULER_SIZE - 4, screenY);
        ctx.stroke();
      }
    }
  }, [camera]);

  // Redraw on camera change
  useEffect(() => {
    if (hCanvasRef.current) drawHorizontal(hCanvasRef.current);
    if (vCanvasRef.current) drawVertical(vCanvasRef.current);
  }, [camera, drawHorizontal, drawVertical]);

  // Resize observer
  useEffect(() => {
    const hCanvas = hCanvasRef.current;
    const vCanvas = vCanvasRef.current;
    if (!hCanvas || !vCanvas) return;

    const resize = () => {
      drawHorizontal(hCanvas);
      drawVertical(vCanvas);
    };

    const hParent = hCanvas.parentElement;
    const vParent = vCanvas.parentElement;
    if (!hParent || !vParent) return;

    const observer = new ResizeObserver(resize);
    observer.observe(hParent);
    observer.observe(vParent);
    return () => observer.disconnect();
  }, [drawHorizontal, drawVertical]);

  if (!gridVisible) return null;

  return (
    <>
      {/* Corner square */}
      <div style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: RULER_SIZE,
        height: RULER_SIZE,
        background: BG,
        zIndex: 12,
        borderRight: "1px solid rgba(255,255,255,0.08)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        <span style={{ fontSize: "7px", color: "rgba(255,255,255,0.3)", fontWeight: 600 }}>mm</span>
      </div>

      {/* Horizontal ruler */}
      <div style={{
        position: "absolute",
        top: 0,
        left: RULER_SIZE,
        right: 0,
        height: RULER_SIZE,
        zIndex: 11,
        pointerEvents: "none",
      }}>
        <canvas ref={hCanvasRef} />
      </div>

      {/* Vertical ruler */}
      <div style={{
        position: "absolute",
        top: RULER_SIZE,
        left: 0,
        bottom: 0,
        width: RULER_SIZE,
        zIndex: 11,
        pointerEvents: "none",
      }}>
        <canvas ref={vCanvasRef} />
      </div>
    </>
  );
}

/** Determine nice tick intervals based on current zoom scale */
function getTickInterval(pxPerMm: number): { interval: number; subdivisions: number } {
  // Target ~80-150px between major ticks
  const targetPx = 100;
  // Snap to nice numbers: 1, 2, 5, 10, 20, 50, 100, 200, 500...
  const niceNumbers = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let interval = niceNumbers[0];
  for (const n of niceNumbers) {
    interval = n;
    if (n * pxPerMm >= targetPx * 0.6) break;
  }

  // Subdivisions
  let subdivisions = 5;
  if (interval === 2 || interval === 20 || interval === 200) subdivisions = 4;

  return { interval, subdivisions };
}

