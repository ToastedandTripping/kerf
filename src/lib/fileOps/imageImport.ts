import { useStore, generateId } from "../../app/store";
import type { DesignObject } from "../../app/types";

export function importImageData(data: Uint8Array, ext: string) {
  const store = useStore.getState();
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    bmp: "image/bmp", gif: "image/gif", webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = `data:${mime};base64,${btoa(binary)}`;

  const img = new Image();
  img.onload = () => {
    const widthMm = (img.width / 96) * 25.4;
    const heightMm = (img.height / 96) * 25.4;

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
    store.addConsoleLine(`Image imported: ${img.width}x${img.height}px (${widthMm.toFixed(0)}x${heightMm.toFixed(0)}mm)`, "info");
  };
  img.src = base64;
}
