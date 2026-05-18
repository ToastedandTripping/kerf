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
import { useKeyboardShortcuts } from "../lib/shortcuts";
import { handleFileDrop } from "../lib/fileDrop";
import { startAutoSave, checkRecoveryFile, clearRecoveryFile } from "../lib/autoSave";
import { OnboardingOverlay, shouldShowOnboarding } from "../components/panels/OnboardingOverlay";
import { useStore } from "./store";

// Expose dialog openers globally so menus/commands can trigger them
export const dialogState: {
  openGrblSettings: () => void;
  openSettings: () => void;
  openProjectNotes: () => void;
  openQrCode: () => void;
  openImageTrace: () => void;
  openMaterialTest: () => void;
  openSvgImport: (svgContent: string) => void;
  openImageImport: (data: string, name: string, width: number, height: number) => void;
} = {
  openGrblSettings: () => {},
  openSettings: () => {},
  openProjectNotes: () => {},
  openQrCode: () => {},
  openImageTrace: () => {},
  openMaterialTest: () => {},
  openSvgImport: () => {},
  openImageImport: () => {},
};

export default function App() {
  useKeyboardShortcuts();
  const [recoveryOffer, setRecoveryOffer] = useState<{ timestamp: number } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);

  useEffect(() => {
    startAutoSave(60000);
    checkRecoveryFile().then((result) => {
      if (result) setRecoveryOffer({ timestamp: result.timestamp });
    }).catch(console.error);
  }, []);

  const [grblOpen, setGrblOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [materialTestOpen, setMaterialTestOpen] = useState(false);
  const [svgImportOpen, setSvgImportOpen] = useState(false);
  const [pendingSvgContent, setPendingSvgContent] = useState<string | null>(null);
  const [imageImportOpen, setImageImportOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<{ data: string; name: string; width: number; height: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Wire up global dialog openers
  dialogState.openGrblSettings = () => setGrblOpen(true);
  dialogState.openSettings = () => setSettingsOpen(true);
  dialogState.openProjectNotes = () => setNotesOpen(true);
  dialogState.openQrCode = () => setQrOpen(true);
  dialogState.openImageTrace = () => setTraceOpen(true);
  dialogState.openMaterialTest = () => setMaterialTestOpen(true);
  dialogState.openSvgImport = (svgContent: string) => {
    setPendingSvgContent(svgContent);
    setSvgImportOpen(true);
  };
  dialogState.openImageImport = (data: string, name: string, width: number, height: number) => {
    setPendingImage({ data, name, width, height });
    setImageImportOpen(true);
  };

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
            overflow: "auto",
          }}
        >
          <LayerPanel />
          <MaterialLibrary />
          <PropertiesPanel />
          <MachinePanel />
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <GrblSettingsDialog open={grblOpen} onClose={() => setGrblOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ProjectNotesDialog open={notesOpen} onClose={() => setNotesOpen(false)} />
      <QrCodeDialog open={qrOpen} onClose={() => setQrOpen(false)} />
      <ImageTraceDialog open={traceOpen} onClose={() => setTraceOpen(false)} />
      <MaterialTestDialog open={materialTestOpen} onClose={() => setMaterialTestOpen(false)} />
      <SvgImportDialog
        open={svgImportOpen}
        svgContent={pendingSvgContent}
        onClose={() => { setSvgImportOpen(false); setPendingSvgContent(null); }}
      />
      <ImageImportDialog
        open={imageImportOpen}
        imageData={pendingImage?.data ?? null}
        fileName={pendingImage?.name ?? ""}
        imageWidth={pendingImage?.width ?? 0}
        imageHeight={pendingImage?.height ?? 0}
        onClose={() => { setImageImportOpen(false); setPendingImage(null); }}
        onImported={() => {
          if (pendingImage) {
            setTimeout(() => dialogState.openImageTrace(), 100);
          }
        }}
      />
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
                    useStore.getState().loadProject(result.project);
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
