# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**simple_translate** is a Windows desktop translation tool built with Tauri 2.0, React, and Rust. It provides instant translation via a global hotkey (Ctrl+Q) that displays results in a floating popup window.

## Development Commands

```bash
# Frontend development
npm run dev          # Start Vite dev server on port 1420
npm run build        # TypeScript type check + build frontend
npm run preview      # Preview built app

# Full Tauri application
npm run tauri dev    # Run full app in development mode (builds Rust + frontend)
npm run tauri build  # Build application packages for distribution

# Rust backend (run from src-tauri/)
cargo build          # Build Rust backend
cargo check          # Check Rust code without building
cargo add <crate>    # Add Rust dependency
```

## Architecture

The application follows a clear separation of concerns:

### Frontend-Backend Communication

The architecture uses **Tauri events** for one-way communication (Rust → React) and **Tauri commands** for request-response (React → Rust):

```
User Action (Ctrl+Q)
    ↓
Rust: trigger_translate() [lib.rs]
    ↓
Rust: get_selected_text() → get_mouse_position()
    ↓
Rust: emit "translate-text" event
    ↓
React: App.tsx listens for event → shows popup
    ↓
React: invoke "translate" command
    ↓
Rust: translate() → HTTP request to DeepLX API
    ↓
React: displays result
```

### Key Components

**Rust Backend (`src-tauri/src/lib.rs`)**:
- `run()` - Initializes Tauri app with global shortcuts and system tray
- `trigger_translate()` - Global shortcut handler (Ctrl+Q) with 300ms debounce
- `get_selected_text()` - Clipboard-based text extraction using `enigo` for Ctrl+C simulation and `arboard` for clipboard reading
- `get_mouse_position()` - Tracks cursor position for popup placement
- `translate()` - HTTP POST to DeepLX API (EN → ZH), max 1000 chars, 10s timeout

**React Frontend (`src/App.tsx`)**:
- Listens for "translate-text" events from Rust
- Manages popup window positioning with boundary detection
- Handles copy-to-clipboard via `@tauri-apps/plugin-clipboard-manager`
- Auto-hides after 1.5s of mouse leave

### Translation API

- Endpoint: `https://api.deeplx.org/pIcaK4I42id_1BwHBrx2z2trJ5EaE2aG0qwVD8gmYuo/translate`
- Request format: `{ "text": "...", "source_lang": "EN", "target_lang": "ZH" }`
- Response: `TranslateResult { success: bool, text: string, error: string }`

### Window Configuration

The window is defined in `tauri.conf.json`:
- Size: 320x200 (auto-resizes based on content)
- Frameless, transparent, always-on-top
- Starts hidden (`visible: false`)
- Shows only when translation is triggered

## Important Notes

- The clipboard text extraction saves the original clipboard content, simulates Ctrl+C, reads the new content, then restores the original clipboard.
- Text is trimmed to a maximum of 1000 characters before translation.
- The global shortcut has a 300ms debounce to prevent rapid-fire triggers.
- The popup window positions near the mouse cursor with boundary detection to keep it on-screen.