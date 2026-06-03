@echo off
chcp 65001 > nul
title Clip Extractor

set PROJECT_DIR=%~dp0

echo ========================================
echo   Clip Extractor - Video Highlight Tool
echo ========================================
echo.

where node > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install from nodejs.org
    pause
    exit /b
)

cd /d "%PROJECT_DIR%"

if not exist ".env.local" (
    echo [SETUP] API key required.
    echo.
    echo Please enter your Google AI Studio API key:
    set /p GKEY="GOOGLE_AI_API_KEY="
    (echo GOOGLE_AI_API_KEY=%GKEY%) > .env.local
    echo.
    echo API key saved!
    echo.
) else (
    findstr /i "GOOGLE_AI_API_KEY" .env.local > nul 2>&1
    if %errorlevel% neq 0 (
        echo [SETUP] Adding API key to existing .env.local...
        set /p GKEY="GOOGLE_AI_API_KEY="
        (echo GOOGLE_AI_API_KEY=%GKEY%) >> .env.local
        echo.
    ) else (
        echo [OK] API key found.
        echo.
    )
)

if not exist "node_modules" (
    echo [INSTALL] Installing packages... (first time only)
    call npm install
    echo Done!
    echo.
)

echo [BUILD] Building... (first time or after update, about 30 seconds)
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed. Check error messages above.
    pause
    exit /b
)
echo Build complete!
echo.

echo [START] Clearing port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 2^>nul') do (
    taskkill /f /pid %%a > nul 2>&1
)
echo [START] Starting server...
echo Browser will open in about 5 seconds.
echo Close this window to stop the server.
echo.
start /B powershell -WindowStyle Hidden -Command "Start-Sleep 5; Start-Process 'http://localhost:3001'"
npx next start -p 3001
