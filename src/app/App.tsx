import { useState } from "react";
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
import { useKeyboardShortcuts } from "../lib/shortcuts";

// Expose dialog openers globally so menus/commands can trigger them
export const dialogState = {
  openGrblSettings: () => {},
  openSettings: () => {},
  openProjectNotes: () => {},
  openQrCode: () => {},
  openImageTrace: () => {},
};

export default function App() {
  useKeyboardShortcuts();

  const [grblOpen, setGrblOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  // Wire up global dialog openers
  dialogState.openGrblSettings = () => setGrblOpen(true);
  dialogState.openSettings = () => setSettingsOpen(true);
  dialogState.openProjectNotes = () => setNotesOpen(true);
  dialogState.openQrCode = () => setQrOpen(true);
  dialogState.openImageTrace = () => setTraceOpen(true);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        background: "var(--bg-app)",
      }}
    >
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
    </div>
  );
}
