import { useState, useCallback, useEffect } from "react";
import { MenuBar } from "../components/topbar/MenuBar";
import { Toolbar } from "../components/toolbar/Toolbar";
import { Viewport } from "../components/viewport/Viewport";
import { LayerPanel } from "../components/panels/LayerPanel";
import { MaterialLibrary } from "../components/panels/MaterialLibrary";
import { PropertiesPanel } from "../components/panels/PropertiesPanel";
import { MachinePanel } from "../components/panels/MachinePanel";
import { StatusBar } from "../components/bottom/StatusBar";
import { Console } from "../components/bottom/Console";
import { JobPreview } from "../components/bottom/JobPreview";
import { Rulers } from "../components/viewport/Rulers";
import { CommandPalette } from "../components/topbar/CommandPalette";
import { GrblSettingsDialog } from "../components/panels/GrblSettingsDialog";
import { SettingsDialog } from "../components/panels/SettingsDialog";
import { ProjectNotesDialog } from "../components/panels/ProjectNotesDialog";
import { QrCodeDialog } from "../components/panels/QrCodeDialog";
import { ImageTraceDialog } from "../components/panels/ImageTraceDialog";
import { MaterialTestDialog } from "../components/panels/MaterialTestDialog";
import { SvgImportDialog } from "../components/panels/SvgImportDialog";
import { ImageImportDialog } from "../components/panels/ImageImportDialog";
import { ShortcutOverlay } from "../components/panels/ShortcutOverlay";
import { DitherPreviewDialog } from "../components/panels/DitherPreviewDialog";
import { PdfImportDialog } from "../components/panels/PdfImportDialog";
import { VariableTextDialog } from "../components/panels/VariableTextDialog";
import { NestingDialog } from "../components/panels/NestingDialog";
import { useKeyboardShortcuts } from "../lib/shortcuts";
import { handleFileDrop } from "../lib/fileDrop";
import { loadProjectWithMigrations } from "../lib/fileOps";
import { startAutoSave, checkRecoveryFile, clearRecoveryFile } from "../lib/autoSave";
import { OnboardingOverlay, shouldShowOnboarding } from "../components/panels/OnboardingOverlay";
import { useStore } from "./store";
import { generateId } from "./store/storeTypes";

// Dialog helpers — open dialogs via Zustand store
export function openGrblSettings() { useStore.getState().openDialog("grbl"); }
export function openSettings() { useStore.getState().openDialog("settings"); }
export function openProjectNotes() { useStore.getState().openDialog("notes"); }
export function openQrCode() { useStore.getState().openDialog("qr"); }
export function openImageTrace() { useStore.getState().openDialog("trace"); }
export function openMaterialTest() { useStore.getState().openDialog("materialTest"); }
export function openVariableText() { useStore.getState().openDialog("variableText"); }
export function openNesting() { useStore.getState().openDialog("nesting"); }
export function openSvgImport(svgContent: string) {
  const s = useStore.getState();
  s.setDialogData({ svgContent });
  s.openDialog("svgImport");
}
export function openImageImport(data: string, name: string, width: number, height: number) {
  const s = useStore.getState();
  s.setDialogData({ pendingImage: { data, name, width, height } });
  s.openDialog("imageImport");
}
export function openDitherPreview(objectId: string) {
  const s = useStore.getState();
  s.setDialogData({ ditherPreviewObjectId: objectId });
  s.openDialog("ditherPreview");
}
export function openPdfImport(data: ArrayBuffer, name: string) {
  const s = useStore.getState();
  s.setDialogData({ pendingPdf: { data, name } });
  s.openDialog("pdfImport");
}

export default function App() {
  useKeyboardShortcuts();
  const activeLayerIndex = useStore((s) => s.activeLayerIndex);
  const openDialogs = useStore((s) => s.openDialogs);
  const dialogData = useStore((s) => s.dialogData);
  const closeDialog = useStore((s) => s.closeDialog);
  const setDialogData = useStore((s) => s.setDialogData);
  const [recoveryOffer, setRecoveryOffer] = useState<{ timestamp: number } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);

  useEffect(() => {
    startAutoSave(60000);
    checkRecoveryFile().then((result) => {
      if (result) setRecoveryOffer({ timestamp: result.timestamp });
    }).catch(console.error);
  }, []);

  const [dragOver, setDragOver] = useState(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    handleFileDrop(e.dataTransfer.files);
  }, []);

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        background: "var(--bg-app)",
        position: "relative",
      }}
    >
      {dragOver && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 99999,
          background: "rgba(74, 144, 226, 0.08)",
          border: "2px dashed rgba(74, 144, 226, 0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <div style={{
            padding: "16px 32px", borderRadius: "8px",
            background: "rgba(0, 0, 0, 0.7)", color: "#fff",
            fontSize: "14px", fontWeight: 500,
          }}>
            Drop to import
          </div>
        </div>
      )}
      <MenuBar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Toolbar />
        <div style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
            <Viewport />
            <Rulers />
            <JobPreview />
          </div>
          <Console />
        </div>
        <div
          style={{
            width: "var(--panel-width)",
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid var(--border)",
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          {/* Scrollable upper zone: panels */}
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <LayerPanel />
            <MaterialLibrary />
            <PropertiesPanel />
          </div>
          {/* Fixed bottom zone: machine controls always visible */}
          <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", maxHeight: "50%", overflow: "auto" }}>
            <MachinePanel />
          </div>
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <GrblSettingsDialog open={openDialogs.has("grbl")} onClose={() => closeDialog("grbl")} />
      <SettingsDialog open={openDialogs.has("settings")} onClose={() => closeDialog("settings")} />
      <ProjectNotesDialog open={openDialogs.has("notes")} onClose={() => closeDialog("notes")} />
      <QrCodeDialog open={openDialogs.has("qr")} onClose={() => closeDialog("qr")} />
      <ImageTraceDialog open={openDialogs.has("trace")} onClose={() => closeDialog("trace")} />
      <MaterialTestDialog open={openDialogs.has("materialTest")} onClose={() => closeDialog("materialTest")} />
      <SvgImportDialog
        open={openDialogs.has("svgImport")}
        svgContent={dialogData.svgContent}
        onClose={() => { closeDialog("svgImport"); setDialogData({ svgContent: null }); }}
      />
      <ImageImportDialog
        open={openDialogs.has("imageImport")}
        imageData={dialogData.pendingImage?.data ?? null}
        fileName={dialogData.pendingImage?.name ?? ""}
        imageWidth={dialogData.pendingImage?.width ?? 0}
        imageHeight={dialogData.pendingImage?.height ?? 0}
        onClose={() => { closeDialog("imageImport"); setDialogData({ pendingImage: null }); }}
        onImported={(autoTrace) => {
          if (dialogData.pendingImage && autoTrace) {
            setTimeout(() => openImageTrace(), 100);
          }
        }}
      />
      <DitherPreviewDialog
        open={openDialogs.has("ditherPreview")}
        objectId={dialogData.ditherPreviewObjectId}
        onClose={() => { closeDialog("ditherPreview"); setDialogData({ ditherPreviewObjectId: null }); }}
      />
      <PdfImportDialog
        open={openDialogs.has("pdfImport")}
        pdfData={dialogData.pendingPdf?.data ?? null}
        fileName={dialogData.pendingPdf?.name ?? ""}
        onClose={() => { closeDialog("pdfImport"); setDialogData({ pendingPdf: null }); }}
        onImport={(imageData, width, height) => {
          closeDialog("pdfImport");
          openImageImport(imageData, dialogData.pendingPdf?.name ?? "pdf-page.png", width, height);
        }}
        onImportVector={(objects) => {
          closeDialog("pdfImport");
          setDialogData({ pendingPdf: null });
          const addObject = useStore.getState().addObject;
          for (const obj of objects) {
            addObject(obj);
          }
        }}
        generateId={generateId}
        defaultLayerIndex={activeLayerIndex}
      />
      <VariableTextDialog open={openDialogs.has("variableText")} onClose={() => closeDialog("variableText")} />
      <NestingDialog open={openDialogs.has("nesting")} onClose={() => closeDialog("nesting")} />
      <ShortcutOverlay />

      {/* First-launch onboarding */}
      {showOnboarding && <OnboardingOverlay onClose={() => setShowOnboarding(false)} />}

      {/* Recovery offer modal */}
      {recoveryOffer && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
        }}>
          <div style={{
            background: "var(--bg-panel)", border: "1px solid var(--border)",
            borderRadius: "8px", padding: "24px", maxWidth: "360px", width: "90%",
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: "14px", color: "var(--text-primary)" }}>
              Recover unsaved work?
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: "12px", color: "var(--text-secondary)" }}>
              Found auto-saved project from {new Date(recoveryOffer.timestamp).toLocaleString()}.
            </p>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                onClick={() => { clearRecoveryFile(); setRecoveryOffer(null); }}
                style={{ padding: "6px 12px", fontSize: "12px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: "4px", color: "var(--text-primary)", cursor: "pointer" }}
              >
                Discard
              </button>
              <button
                onClick={async () => {
                  const result = await checkRecoveryFile();
                  if (result) {
                    // W1b: recovery files load through the SAME migration
                    // wrapper as every other loader — old recovery files are
                    // legacy-convention and were previously the one loader
                    // that bypassed migrations entirely.
                    loadProjectWithMigrations(result.project);
                  }
                  setRecoveryOffer(null);
                }}
                style={{ padding: "6px 12px", fontSize: "12px", background: "var(--accent, #4a90e2)", border: "none", borderRadius: "4px", color: "#fff", cursor: "pointer" }}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
