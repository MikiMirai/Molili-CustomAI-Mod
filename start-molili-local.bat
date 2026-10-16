@echo off
rem Put this file, all the .mjs files, molili.config.json and persona.txt (optional) in the same folder as Molili.exe.
rem Settings are changed only in molili.config.json. Needs Node 22+ (https://nodejs.org).
cd /d "%~dp0"
rem Required by Molili, not a mod setting: opens the web view's debug port on localhost (must match CDP_PORT in the config).
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
start "" "%~dp0Molili.exe"
node "%~dp0molili-lmstudio.mjs"
