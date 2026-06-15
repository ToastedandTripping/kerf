import { useRef, useEffect, useState } from "react";
import { useStore } from "../../app/store";
import { machineConnection } from "../../lib/machine/connection";

export function Console() {
  const consoleLines = useStore((s) => s.consoleLines);
  const clearConsole = useStore((s) => s.clearConsole);
  const showConsole = useStore((s) => s.showConsole);
  const machineConnected = useStore((s) => s.machineConnected);
  const jobRunning = useStore((s) => s.jobRunning);

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [consoleLines]);

  if (!showConsole) return null;

  async function handleSend() {
    const cmd = input.trim();
    if (!cmd) return;

    setHistory((h) => [...h, cmd]);
    setHistoryIndex(-1);
    setInput("");

    if (machineConnected) {
      // Send via real serial connection
      await machineConnection.send(cmd);
    } else {
      // Offline mode: log the command but note no connection
      useStore.getState().addConsoleLine(cmd, "sent");
      useStore.getState().addConsoleLine("Not connected to machine", "error");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!jobRunning) handleSend();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0) {
        const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInput(history[newIndex]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex >= 0) {
        const newIndex = historyIndex + 1;
        if (newIndex >= history.length) {
          setHistoryIndex(-1);
          setInput("");
        } else {
          setHistoryIndex(newIndex);
          setInput(history[newIndex]);
        }
      }
    }
  }

  const lineColors: Record<string, string> = {
    sent: "var(--accent)",
    received: "var(--success)",
    info: "var(--text-secondary)",
    error: "var(--danger)",
    warning: "var(--accent-warm)",
  };

  const linePrefixes: Record<string, string> = {
    sent: ">>> ",
    received: "<<< ",
    info: "[i] ",
    error: "[!] ",
    warning: "[!] ",
  };

  return (
    <div
      style={{
        height: "180px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 8px",
        borderBottom: "1px solid var(--border)",
      }}>
        <span style={{ fontSize: "10px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>
          G-code Console
        </span>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{
            fontSize: "9px",
            color: machineConnected ? "var(--success)" : "var(--text-muted)",
          }}>
            {machineConnected ? "LIVE" : "OFFLINE"}
          </span>
          <button
            onClick={clearConsole}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: "10px",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Output */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "4px 8px",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          lineHeight: "1.5",
        }}
      >
        {consoleLines.length === 0 && (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
            Type G-code commands or use machine controls above...
          </div>
        )}
        {consoleLines.map((line, i) => (
          <div key={i} style={{ color: lineColors[line.type] }}>
            <span style={{ opacity: 0.5 }}>{linePrefixes[line.type]}</span>
            {line.text}
          </div>
        ))}
      </div>

      {/* Input */}
      <div style={{
        display: "flex",
        borderTop: "1px solid var(--border)",
      }}>
        <span style={{
          padding: "4px 6px",
          color: "var(--accent)",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          fontWeight: 600,
        }}>
          &gt;
        </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={handleKeyDown}
          placeholder={jobRunning ? "Cannot send during active job" : "Enter G-code command..."}
          disabled={jobRunning}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            color: jobRunning ? "var(--text-muted)" : "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            padding: "4px 0",
          }}
        />
        <button
          onClick={handleSend}
          disabled={jobRunning || !input.trim()}
          title={jobRunning ? "Cannot send during active job" : "Send command"}
          style={{
            padding: "2px 8px",
            background: "none",
            border: "none",
            color: jobRunning ? "var(--text-muted)" : "var(--accent)",
            fontSize: "10px",
            cursor: jobRunning || !input.trim() ? "not-allowed" : "pointer",
            opacity: jobRunning || !input.trim() ? 0.4 : 1,
            fontWeight: 600,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
