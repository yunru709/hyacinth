@echo off
chcp 65001 >nul
setlocal

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       DeepThink WebUI — One-Click Start     ║
echo ╚══════════════════════════════════════════════╝
echo.

:: Get the directory where this script lives
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Step 1: Check if backend is compiled
if not exist "dist\index.js" (
    echo [ERROR] Backend not compiled. Run: pnpm build
    echo.
    pause
    exit /b 1
)

:: Step 2: Install frontend dependencies (if needed)
if not exist "webui\node_modules" (
    echo [1/2] Installing frontend dependencies...
    cd webui
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed
        cd ..
        pause
        exit /b 1
    )
    cd ..
) else (
    echo [1/2] Frontend dependencies OK
)

:: Step 3: Build frontend (only if source changed)
echo [2/2] Starting DeepThink...
echo.

:: Run the compiled CLI via the correct entry point
node dist\index.js serve --webui --webui-port 3100

:: If we get here, something went wrong
echo.
echo [ERROR] Server stopped unexpectedly (code: %ERRORLEVEL%)
echo.
pause
