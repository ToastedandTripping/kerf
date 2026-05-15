import { useStore, generateId } from "../app/store";
import { dialogState } from "../app/App";
import type { DesignObject } from "../app/types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "bmp", "gif", "webp"]);

export function handleFileDrop(files: FileList) {
  if (files.length === 0) return;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = file.name.split(".").pop()?.toLowerCase() || "";

    if (IMAGE_EXTENSIONS.has(ext)) {
      importDroppedImage(file);
    } else if (ext === "svg") {
      importDroppedSvg(file);
    } else if (ext === "dxf") {
      importDroppedDxf(file);
    } else {
      useStore.getState().addConsoleLine(`Unsupported file type: .${ext}`, "warning");
    }
  }
}

function importDroppedImage(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result as string;
    const img = new Image();
    img.onload = () => {
      const store = useStore.getState();
      const widthMm = (img.width / 96) * 25.4;
      const heightMm = (img.height / 96) * 25.4;

      const obj: DesignObject = {
        id: generateId(),
        type: "image",
        name: file.name,
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
      store.addConsoleLine(
        `Dropped image: ${file.name} (${img.width}x${img.height}px, ${widthMm.toFixed(0)}x${heightMm.toFixed(0)}mm)`,
        "info"
      );

      // Auto-open trace dialog for the dropped image
      setTimeout(() => dialogState.openImageTrace(), 100);
    };
    img.src = base64;
  };
  reader.readAsDataURL(file);
}

function importDroppedSvg(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const svgContent = reader.result as string;
    dialogState.openSvgImport(svgContent);
  };
  reader.readAsText(file);
}

function importDroppedDxf(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const content = reader.result as string;
    // Use the existing DXF import from fileOps (re-exported for drop)
    import("./fileOps").then(({ importDxfDirect }) => {
      importDxfDirect(content);
    });
  };
  reader.readAsText(file);
}
