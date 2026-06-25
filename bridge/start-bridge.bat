@echo off
title La Dolce Notte - LED Bridge
cd /d "%~dp0"

echo ============================================
echo    La Dolce Notte - LED Bridge
echo ============================================
echo.

REM --- Find Python (py launcher preferred, then python) ---
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY (
  echo [X] Python is not installed on this machine.
  echo.
  echo     1. Get it from https://www.python.org/downloads/
  echo     2. During setup, TICK "Add Python to PATH"
  echo     3. Run this launcher again.
  echo.
  pause
  exit /b 1
)

REM --- Make sure the two libraries are present (installs only the first time) ---
%PY% -c "import websockets, serial" 1>nul 2>nul
if errorlevel 1 (
  echo First-time setup: installing required libraries...
  %PY% -m pip install --quiet websockets pyserial
  if errorlevel 1 (
    echo [X] Library install failed. Check your internet connection and retry.
    pause
    exit /b 1
  )
)

echo Plug the Pico into USB. The bridge will find it automatically.
echo After this window says "listening for Foundry", press F5 in Foundry.
echo (Close this window to stop the bridge.)
echo.
%PY% bridge.py %*

echo.
echo Bridge stopped.
pause
