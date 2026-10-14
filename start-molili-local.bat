@echo off
rem Put this file, molili-lmstudio.mjs, account.mjs (and persona.txt) in the same folder as Molili.exe.
rem Needs Node 22+ (https://nodejs.org).
cd /d "%~dp0"
rem Opens WebView2's DevTools port on localhost only, so the script can sit in front of Molili's API calls.
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
rem --- optional settings ---
rem set LMSTUDIO_MODEL=google/gemma-4-12b-qat
rem set LOGIN_MODE=local   (no spaces, no quotes. local = always your saved account.json, never overwritten from the server;
rem                         auto = real server when reachable, saved account when not; cloud = never use the saved account.)
rem   Alternative that needs no variable: put  "loginMode": "local"  in account.json (Molili closed). The console prints which mode is active.
rem set RECORD=0             (stop recording the server's responses into .\capture)
rem set OFFLINE_STUB=1       (when the server is down, answer unknown requests with an empty success instead of an error)
rem set STREAM=0
rem set DEBUG=1
start "" "%~dp0Molili.exe"
node "%~dp0molili-lmstudio.mjs"
