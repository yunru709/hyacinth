@echo off
rem ============================================================
rem  Hyacinth desktop launcher (double-click this file)
rem
rem  Builds the .NET shell on first run, then starts it.
rem  The shell itself launches the backend:
rem      node dist/index.js webui --port 3130 ...
rem  so run `pnpm run build` at least once before the first start.
rem
rem  NOTE: messages are ASCII-only on purpose -- a .cmd with
rem  non-ASCII text shows mojibake unless the codepage matches.
rem  Chinese docs live in desktop\README.md.
rem ============================================================
setlocal
set "REPO=%~dp0"
set "DEPLOY=%LOCALAPPDATA%\Programs\hyacinth-shell"
set "EXE=%DEPLOY%\native-shell.exe"

if not exist "%EXE%" (
  echo [first run] building the desktop shell...
  powershell -ExecutionPolicy Bypass -File "%REPO%scripts\desktop-build.ps1"
  if errorlevel 1 (
    echo Build FAILED. See the output above.
    pause
    exit /b 1
  )
)

start "" "%EXE%"
endlocal
