import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";
import { MM_PER_INCH } from "../constants";

/**
 * Parse PNG pHYs chunk to extract embedded DPI metadata.
 * pHYs chunk: 4 bytes X-ppu, 4 bytes Y-ppu, 1 byte unit (1 = meter).
 * Returns DPI or null if absent / unit is not meter.
 */
export function parsePngPhysDpi(data: Uint8Array): number | null {
  // PNG signature: 8 bytes. Then chunks: 4-byte length, 4-byte type, data, 4-byte CRC.
  if (data.length < 8) return null;
  // Check PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let s = 0; s < 8; s++) {
    if (data[s] !== sig[s]) return null;
  }
  let offset = 8;
  while (offset + 12 <= data.length) {
    const chunkLen =
      (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    if (type === "pHYs" && chunkLen === 9 && offset + 12 + 9 <= data.length) {
      const d = offset + 8;
      const xppu =
        ((data[d] << 24) | (data[d + 1] << 16) | (data[d + 2] << 8) | data[d + 3]) >>> 0;
      const unit = data[d + 8];
      if (unit === 1 && xppu > 0) {
        const dpi = xppu / 39.3701; // pixels per meter → DPI
        return dpi;
      }
      return null;
    }
    if (type === "IDAT" || type === "IEND") break; // pHYs must come before IDAT
    offset += 12 + chunkLen;
  }
  return null;
}

export function importImageData(data: Uint8Array, ext: string) {
  const store = useStore.getState();
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    bmp: "image/bmp", gif: "image/gif", webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  // For PNG files, attempt to read embedded DPI from pHYs chunk before decoding.
  const detectedDpi = ext === "png" ? parsePngPhysDpi(data) : null;

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = `data:${mime};base64,${btoa(binary)}`;

  const img = new Image();
  img.onload = () => {
    const dpi = detectedDpi ?? 300;
    const widthMm = (img.width / dpi) * MM_PER_INCH;
    const heightMm = (img.height / dpi) * MM_PER_INCH;

    const obj: DesignObject = {
      id: generateId(),
      type: "image",
      name: `Image ${store.objects.length + 1}`,
      transform: {
        x: 10, y: 10,
        width: widthMm, height: heightMm,
        rotation: 0, scaleX: 1, scaleY: 1,
      },
      layerIndex: store.activeLayerIndex,
      visible: true, locked: false,
      fill: null, stroke: "#999999", strokeWidth: 0, opacity: 1,
      imageData: base64,
    };

    store.addObject(obj);
    store.setSelectedIds([obj.id]);
    const dpiNote = detectedDpi ? ` at ${detectedDpi.toFixed(0)} DPI` : " (300 DPI assumed)";
    store.addConsoleLine(`Image imported: ${img.width}x${img.height}px → ${widthMm.toFixed(0)}x${heightMm.toFixed(0)}mm${dpiNote}`, "info");
  };
  img.src = base64;
}
