import { useRef, useEffect, useState, useCallback } from "react";
import { useStore } from "../../app/store";

import { PX_PER_MM } from "../../lib/constants";

const COLORS = {
  rapid: "#4A90E2",     // Blue - travel moves
  cut: "#E24A4A",       // Red - vector cuts
  engrave: "#c4a57b",   // Gold - engrave/fill
  laserHead: "#4AE28A", // Green - laser head dot
};

interface Move {
  x: number;
  y: number;
  moveType: string;
  speed: number;
  power: number;
}

export function JobPreview() {
  const gcodeResult = useStore((s) => s.gcodeResult);
  const previewVisible = useStore((s) => s.previewVisible);
  const setPreviewVisible = useStore((s) => s.setPreviewVisible);
  const camera = useStore((s) => s.camera);
  const workspaceWidth = useStore((s) => s.workspaceWidth);
  const workspaceHeight = useStore((s) => s.workspaceHeight);
  const originTop = useStore((s) => s.originTop);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0-1
  const [speed, setSpeed] = useState(1); // playback speed multiplier
  const progressRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const lastTimeRef = useRef(0);

  // Keep refs in sync
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { progressRef.current = progress; }, [progress]);

  const moves = gcodeResult?.moves || [];

  // Calculate cumulative distances for smooth scrubbing
  const cumulativeDistances = useRef<number[]>([]);
  useEffect(() => {
    if (!moves.length) return;
    const dists: number[] = [0];
    let px = 0, py = 0;
    for (let i = 0; i < moves.length; i++) {
      const d = Math.hypot(moves[i].x - px, moves[i].y - py);
      dists.push(dists[dists.length - 1] + d);
      px = moves[i].x;
      py = moves[i].y;
    }
    cumulativeDistances.current = dists;
  }, [moves]);

  // Get the move index for a given progress (0-1)
  const getMoveIndex = useCallback((p: number): number => {
    if (!moves.length) return 0;
    const totalDist = cumulativeDistances.current[cumulativeDistances.current.length - 1];
    const targetDist = p * totalDist;

    // Binary search for the move
    let lo = 0, hi = moves.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulativeDistances.current[mid + 1] < targetDist) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [moves]);

  // Get interpolated position at progress
  const getPositionAtProgress = useCallback((p: number): { x: number; y: number } => {
    if (!moves.length) return { x: 0, y: 0 };
    const totalDist = cumulativeDistances.current[cumulativeDistances.current.length - 1];
    if (totalDist === 0) return { x: moves[0].x, y: moves[0].y };

    const targetDist = p * totalDist;
    const moveIdx = getMoveIndex(p);

    const distBefore = cumulativeDistances.current[moveIdx];
    const distAfter = cumulativeDistances.current[moveIdx + 1];
    const segmentLen = distAfter - distBefore;

    if (segmentLen === 0) return { x: moves[moveIdx].x, y: moves[moveIdx].y };

    const t = (targetDist - distBefore) / segmentLen;
    const prevX = moveIdx > 0 ? moves[moveIdx - 1].x : 0;
    const prevY = moveIdx > 0 ? moves[moveIdx - 1].y : 0;

    return {
      x: prevX + (moves[moveIdx].x - prevX) * t,
      y: prevY + (moves[moveIdx].y - prevY) * t,
    };
  }, [moves, getMoveIndex]);

  // Drawing function
  const draw = useCallback((canvas: HTMLCanvasElement, currentProgress: number) => {
    const ctx = canvas.getContext("2d");
    if (!ctx || !moves.length) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Semi-transparent overlay
    ctx.fillStyle = "rgba(26, 26, 26, 0.85)";
    ctx.fillRect(0, 0, w, h);

    // Apply camera transform -- match Viewport's coordinate system
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // Draw workspace boundary
    const wsW = workspaceWidth * PX_PER_MM;
    const wsH = workspaceHeight * PX_PER_MM;
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1 / camera.zoom;
    ctx.strokeRect(0, 0, wsW, wsH);

    // Coordinate transform: G-code coords to screen coords.
    // Standard GRBL (origin bottom): G-code Y=0 at bottom → screen Y = (wsH - y).
    // Origin top: G-code Y is negative (0 at top, -wsH at bottom) → screen Y = -y.
    const toScreen = (mx: number, my: number) => ({
      sx: mx * PX_PER_MM,
      sy: originTop ? (-my) * PX_PER_MM : (workspaceHeight - my) * PX_PER_MM,
    });

    const currentMoveIdx = getMoveIndex(currentProgress);

    // Draw all moves up to current progress
    let prevX = 0, prevY = 0;
    for (let i = 0; i <= Math.min(currentMoveIdx, moves.length - 1); i++) {
      const move = moves[i];
      const from = toScreen(prevX, prevY);
      const to = toScreen(move.x, move.y);

      ctx.beginPath();
      ctx.moveTo(from.sx, from.sy);

      if (i < currentMoveIdx) {
        ctx.lineTo(to.sx, to.sy);
      } else {
        // Partially draw the last segment
        const pos = getPositionAtProgress(currentProgress);
        const partial = toScreen(pos.x, pos.y);
        ctx.lineTo(partial.sx, partial.sy);
      }

      // Color by move type
      const color = COLORS[move.moveType as keyof typeof COLORS] || COLORS.cut;
      ctx.strokeStyle = i <= currentMoveIdx ? color : `${color}40`;
      ctx.lineWidth = move.moveType === "rapid" ? (1 / camera.zoom) : (1.5 / camera.zoom);

      if (move.moveType === "rapid") {
        ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
      } else {
        ctx.setLineDash([]);
      }

      ctx.stroke();

      prevX = move.x;
      prevY = move.y;
    }

    // Draw future moves (dimmed)
    ctx.setLineDash([]);
    for (let i = currentMoveIdx + 1; i < moves.length; i++) {
      const move = moves[i];
      const from = toScreen(prevX, prevY);
      const to = toScreen(move.x, move.y);

      ctx.beginPath();
      ctx.moveTo(from.sx, from.sy);
      ctx.lineTo(to.sx, to.sy);

      const color = COLORS[move.moveType as keyof typeof COLORS] || COLORS.cut;
      ctx.strokeStyle = `${color}20`;
      ctx.lineWidth = (0.5 / camera.zoom);

      if (move.moveType === "rapid") {
        ctx.setLineDash([3 / camera.zoom, 3 / camera.zoom]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke();

      prevX = move.x;
      prevY = move.y;
    }

    ctx.setLineDash([]);

    // Draw laser head position
    const headPos = getPositionAtProgress(currentProgress);
    const headScreen = toScreen(headPos.x, headPos.y);

    // Glow
    const gradient = ctx.createRadialGradient(
      headScreen.sx, headScreen.sy, 0,
      headScreen.sx, headScreen.sy, 8 / camera.zoom
    );
    gradient.addColorStop(0, "rgba(74,226,138,0.6)");
    gradient.addColorStop(1, "rgba(74,226,138,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(headScreen.sx, headScreen.sy, 8 / camera.zoom, 0, Math.PI * 2);
    ctx.fill();

    // Head dot
    ctx.fillStyle = COLORS.laserHead;
    ctx.beginPath();
    ctx.arc(headScreen.sx, headScreen.sy, 3 / camera.zoom, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }, [moves, camera, workspaceWidth, workspaceHeight, originTop, getMoveIndex, getPositionAtProgress]);

  // Animation loop
  useEffect(() => {
    if (!previewVisible || !canvasRef.current || !moves.length) return;

    const canvas = canvasRef.current;
    const totalTime = gcodeResult?.estimatedTimeSecs || 10;

    const animate = (timestamp: number) => {
      if (!playingRef.current) {
        draw(canvas, progressRef.current);
        animFrameRef.current = requestAnimationFrame(animate);
        return;
      }

      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
      const dt = (timestamp - lastTimeRef.current) / 1000; // seconds
      lastTimeRef.current = timestamp;

      const increment = (dt * speedRef.current) / totalTime;
      const newProgress = Math.min(1, progressRef.current + increment);

      progressRef.current = newProgress;
      setProgress(newProgress);

      if (newProgress >= 1) {
        playingRef.current = false;
        setPlaying(false);
      }

      draw(canvas, newProgress);
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [previewVisible, moves, gcodeResult, draw]);

  // Resize canvas to match parent
  useEffect(() => {
    if (!canvasRef.current || !previewVisible) return;
    const canvas = canvasRef.current;
    const parent = canvas.parentElement;
    if (!parent) return;

    const resize = () => {
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
      draw(canvas, progressRef.current);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [previewVisible, draw]);

  if (!previewVisible || !gcodeResult) return null;

  const currentMoveIdx = getMoveIndex(progress);
  const currentMove: Move | null = moves[currentMoveIdx] || null;
  const elapsedTime = (gcodeResult.estimatedTimeSecs || 0) * progress;
  const remainingTime = (gcodeResult.estimatedTimeSecs || 0) * (1 - progress);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Canvas */}
      <div style={{ flex: 1, position: "relative" }}>
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />

        {/* Stats overlay - top right */}
        <div
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            background: "rgba(34,34,34,0.9)",
            borderRadius: "var(--radius-md)",
            padding: "10px 14px",
            fontSize: "11px",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            border: "1px solid var(--border)",
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: "4px", fontFamily: "var(--font-sans)" }}>
            Job Preview
          </div>
          <div>Lines: <span style={{ color: "var(--text-primary)" }}>{gcodeResult.lineCount}</span></div>
          <div>Cut: <span style={{ color: COLORS.cut }}>{gcodeResult.cutDistance.toFixed(1)}mm</span></div>
          <div>Travel: <span style={{ color: COLORS.rapid }}>{gcodeResult.travelDistance.toFixed(1)}mm</span></div>
          <div>Total: <span style={{ color: "var(--text-primary)" }}>{gcodeResult.totalDistance.toFixed(1)}mm</span></div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: "4px", marginTop: "2px" }}>
            Est. time: <span style={{ color: "var(--accent-warm)" }}>{formatTime(gcodeResult.estimatedTimeSecs)}</span>
          </div>
          {currentMove && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "4px", marginTop: "2px" }}>
              <div>Move {currentMoveIdx + 1}/{moves.length}</div>
              <div>Type: <span style={{ color: COLORS[currentMove.moveType as keyof typeof COLORS] || "#fff" }}>
                {currentMove.moveType}
              </span></div>
              <div>Pos: X{currentMove.x.toFixed(1)} Y{currentMove.y.toFixed(1)}</div>
              {currentMove.power > 0 && <div>Power: S{currentMove.power.toFixed(0)}</div>}
            </div>
          )}
        </div>

        {/* Legend - top left */}
        <div
          style={{
            position: "absolute",
            top: "12px",
            left: "12px",
            background: "rgba(34,34,34,0.9)",
            borderRadius: "var(--radius-md)",
            padding: "8px 12px",
            fontSize: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            border: "1px solid var(--border)",
          }}
        >
          <LegendItem color={COLORS.rapid} label="Travel (G0)" dashed />
          <LegendItem color={COLORS.cut} label="Cut (G1)" />
          <LegendItem color={COLORS.engrave} label="Engrave" />
          <LegendItem color={COLORS.laserHead} label="Laser head" dot />
        </div>

        {/* Close button */}
        <button
          onClick={() => setPreviewVisible(false)}
          style={{
            position: "absolute",
            top: "12px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(34,34,34,0.9)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            color: "var(--text-primary)",
            padding: "6px 16px",
            fontSize: "11px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Close Preview
        </button>
      </div>

      {/* Playback controls */}
      <div
        style={{
          background: "rgba(34,34,34,0.95)",
          borderTop: "1px solid var(--border)",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        {/* Play/Pause */}
        <button
          onClick={() => {
            if (progress >= 1) {
              progressRef.current = 0;
              setProgress(0);
              lastTimeRef.current = 0;
            }
            lastTimeRef.current = 0;
            setPlaying(!playing);
          }}
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            border: "1px solid var(--accent)",
            background: "rgba(74,144,226,0.15)",
            color: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            fontSize: "14px",
          }}
        >
          {playing ? "\u23F8" : "\u25B6"}
        </button>

        {/* Reset */}
        <button
          onClick={() => {
            setPlaying(false);
            progressRef.current = 0;
            setProgress(0);
            lastTimeRef.current = 0;
          }}
          style={{
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-muted)",
            padding: "4px 8px",
            fontSize: "10px",
            cursor: "pointer",
          }}
        >
          Reset
        </button>

        {/* Time display */}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-secondary)", minWidth: "60px" }}>
          {formatTime(elapsedTime)}
        </span>

        {/* Scrubber */}
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(e) => {
            const p = parseInt(e.target.value) / 1000;
            progressRef.current = p;
            setProgress(p);
          }}
          style={{ flex: 1, accentColor: "var(--accent)" }}
        />

        {/* Remaining time */}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)", minWidth: "60px", textAlign: "right" }}>
          -{formatTime(remainingTime)}
        </span>

        {/* Speed controls */}
        <div style={{ display: "flex", gap: "2px" }}>
          {[0.25, 0.5, 1, 2, 5, 10].map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              style={{
                padding: "2px 6px",
                borderRadius: "3px",
                fontSize: "9px",
                border: `1px solid ${speed === s ? "var(--accent)" : "var(--border)"}`,
                background: speed === s ? "rgba(74,144,226,0.15)" : "transparent",
                color: speed === s ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Progress percentage */}
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--accent)", fontWeight: 600, minWidth: "40px", textAlign: "right" }}>
          {(progress * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function formatTime(secs: number): string {
  if (secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function LegendItem({ color, label, dashed, dot }: { color: string; label: string; dashed?: boolean; dot?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      {dot ? (
        <div style={{ width: "12px", height: "12px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: color }} />
        </div>
      ) : (
        <div
          style={{
            width: "12px",
            height: "2px",
            background: color,
            borderTop: dashed ? `2px dashed ${color}` : "none",
            backgroundColor: dashed ? "transparent" : color,
          }}
        />
      )}
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}
