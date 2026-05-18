import { useStore } from "../app/store";

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
      import("../app/App").then(({ dialogState }) => {
        dialogState.openImageImport(base64, file.name, img.width, img.height);
      }).catch(console.error);
    };
    img.src = base64;
  };
  reader.readAsDataURL(file);
}

function importDroppedSvg(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const svgContent = reader.result as string;
    import("../app/App").then(({ dialogState }) => {
      dialogState.openSvgImport(svgContent);
    }).catch(console.error);
  };
  reader.readAsText(file);
}

function importDroppedDxf(file: File) {
  const reader = new FileReader();
  reader.onload = () => {
    const content = reader.result as string;
    import("./fileOps").then(({ importDxfDirect }) => {
      importDxfDirect(content);
    }).catch(console.error);
  };
  reader.readAsText(file);
}
