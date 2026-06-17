import React, { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import "./index.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("App crashed:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "40px", fontFamily: "system-ui", background: "#1a1a2e", color: "#e8e8e8", height: "100vh", overflow: "auto" }}>
          <h2 style={{ color: "#e24a4a", margin: "0 0 12px" }}>Kerf crashed</h2>
          <p style={{ color: "#aaa", margin: "0 0 16px" }}>The error below will help diagnose the issue. Press Cmd+Option+I for the full console.</p>
          <pre style={{ background: "#111", padding: "16px", borderRadius: "8px", fontSize: "13px", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#ff6b6b", maxHeight: "300px", overflow: "auto" }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: "16px", padding: "8px 20px", fontSize: "13px", background: "#4a90e2", border: "none", borderRadius: "4px", color: "#fff", cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
