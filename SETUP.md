# Kerf -- Mac Setup Guide

Kerf is a laser cutter CAD/CAM app built with Tauri (Rust + React). This gets you from zero to running on a Mac.

## Prerequisites

### 1. Xcode Command Line Tools

```bash
xcode-select --install
```

If already installed, this will tell you so. Move on.

### 2. Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Accept the defaults. Then restart your terminal (or run `source ~/.cargo/env`).

Verify:

```bash
rustc --version
cargo --version
```

### 3. Node.js

If you don't have it:

```bash
brew install node
```

Or use nvm if you prefer. Kerf needs Node 18+.

Verify:

```bash
node --version
npm --version
```

### 4. Tauri CLI

```bash
cargo install tauri-cli --version "^2"
```

This takes a few minutes the first time (compiling from source).

## Clone and Run

```bash
# Clone the repo
git clone https://github.com/ToastedandTripping/kerf.git
cd kerf

# Install frontend dependencies
npm install

# Run in dev mode
npm run tauri dev
```

The first run compiles the entire Rust backend -- expect 3-5 minutes. After that, incremental builds are fast (a few seconds).

The app opens automatically at 1400x900. Hot reload works for frontend changes (React/CSS). Rust changes require a restart.

## GitHub Auth

```bash
gh auth login
```

Select GitHub.com, HTTPS, and authenticate.

## Troubleshooting

**"xcrun: error: invalid active developer path"**
Xcode CLT not installed. Run `xcode-select --install`.

**Rust compilation errors about openssl or pkg-config**

```bash
brew install pkg-config openssl
```

**Serial port permission denied**
macOS may block serial port access. Go to System Settings > Privacy & Security > Full Disk Access and add your terminal app.

**App window doesn't appear**
Check the terminal for Rust panic messages. Most likely a missing system dependency.

## What It Does

- Import DXF/SVG files
- Boolean operations (union, subtract, intersect)
- Text-to-path conversion
- G-code generation for GRBL-compatible laser cutters
- Image tracing (bitmap to vector) and dithering/engraving
- Serial connection to laser cutter (USB)
- Material library with presets
- QR code generator
- Material test wizard

## Machine Config

The app is configured for an 18"x18" (457mm) laser bed. Machine settings are adjustable in the GRBL settings dialog within the app.
