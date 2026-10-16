# Molili Local Mod: LM Studio Integration & Offline Caching

An unofficial community mod for **Molili** (a Tauri app built with Rust and WebView2). This mod hooks into the game's web frontend via the Chrome DevTools Protocol (CDP) to reroute AI chat calls to a local **LM Studio** agent.

## ⛔ Disclaimer
> This is a fan-made, unofficial project. It is not affiliated with, endorsed by, or connected to the official Molili developers. Use at your own risk.

---

## 🛠️ Request Routing Overview

| Request Type | Handled By |
| --- | --- |
| **Chat, Chat History, Suggestions** | Locally via LM Studio and `chat-history.jsonl`.
| **Login, User Info, Settings** | The live cloud server when reachable (mirrored into `account.json`), or your saved local account when offline.
| **Diary, Store, Balances** | The live server when reachable (cached to `capture/`), or your saved copy when offline.
| **Other Endpoints (Mail, Backpack, etc.)** | Forwarded to the live server and recorded in `capture/`.

---

## 🚀 Quick Start

### Prerequisites
* **Node.js** (v22+ required)
* **LM Studio** running locally with a model loaded on port `1234`

### Installation
1. Download or clone this repository and place all the files in the same folder as `Molili.exe`.
2. (Optional) Copy `persona.example.txt` to `persona.txt` and customize your AI character's prompt.
3. Ensure Molili is completely closed, then run `start-molili-local.bat`.
* The console will display `hooked window ...` followed by `ready` when successful.

> **Launching via Steam?**
> Set your Steam launch options to:
> `cmd /c "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222&& %command%"`
> And then run `node molili-lmstudio.mjs` manually in the game directory.

---

## 📋 Features & How It Works

### 1. Automated Data Crawling (`CRAWL=auto`)
The first time the game logs in with an active server connection, the mod runs a gentle background crawl to save your data locally:
* **Diary:** Pages through your complete history (duplicates across pages are automatically filtered, order setting in the config file).
* **Store:** Captures every category, item page, and your owned items.
* **Balances & Assets:** Saves your energy, stardust, and references to associated static images/media files into `capture/`.

### 2. Account Management (`account.json`)
* **Online & Offline Sync:** While online, your profile and settings mirror automatically without copying sensitive server tokens. When offline, your session persists seamlessly.
* **Local Mode:** Set `LOGIN_MODE=local` or add `"loginMode": "local"` in `account.json` to lock your account state and prevent server overwrites. Any 6 digits will pass e-mail login codes in local mode.
* **Crash Safety:** Writes use atomic temp files with automatic `.bak` backups and damaged file quarantine (`.corrupt-<timestamp>`).

### 3. Persona & History Customization
* Customize the AI companion's tone, rules, and boundaries by editing `persona.txt`.
* Conversation histories are preserved locally in `chat-history.jsonl` across game restarts.

---

## ⚙️ Configuration & Environment Variables
You can customize behavior using environment variables in the batch script or your shell:
* `LMSTUDIO_URL`: Custom endpoint for LM Studio (default: `http://localhost:1234/v1/chat/completions`)
* `LMSTUDIO_MODEL`: Specific model identifier (optional)
* `LOGIN_MODE`: Controls account synchronization (`auto`, `local`, or `cloud`)
* `CRAWL`: Controls background caching behavior (`auto`, `1`, or `0`)
* `RECORD`: Toggles server response recording (`1` or `0`)
* `OFFLINE_STUB`: When set to `1`, replies to unhandled server endpoints with an empty success structure instead of an error
* `STREAM`: Enables or disables response streaming (`1` or `0`)
* `DEBUG`: Enables verbose logging (`1` or `0`)
* And more in the new config file!

---

## 🎯 TODO
* [x] **Complete Offline Experience:** Implement full standalone gameplay capabilities without requiring a live server handshake.
* [ ] **Auto Local Files:** Generate all needed files even without initial server handshake.
* [ ] **LM Studio Enhancement** Make sure to load a model if the LM Studio API is available instead of giving an error.
* [ ] **Expanded Endpoint Support:** Add robust local handling for additional game features (such as mail, backpack management, favorites, and skills) currently returning empty success stubs or fallback errors.
* [ ] **Server Push & Voice Integration:** Explore handling for server push WebSocket messages (e.g., voice notifications, random prompts, and event alerts) and text-to-speech (TTS) workflows.
* [ ] **Local Chat Enhancements:** Add support for favoriting local chat messages and handling inline image attachments.

---

## 🔒 Privacy & Security Notes
* **Local-Only Proxy:** The local gateway listens strictly on `127.0.0.1` and enforces strict origin checks alongside per-run cryptographic secrets (`x-molili-local`) to prevent malicious web pages from interacting with it.
* **Keep Data Private:** The `capture/` folder and `account.json`/`store.json` files contain personal game data, names, IDs, and chat histories. **Never commit or share these files publicly.** Ensure your `.gitignore` covers them.
