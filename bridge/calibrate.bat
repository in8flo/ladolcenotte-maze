@echo off
title La Dolce Notte - LED Calibration
cd /d "%~dp0"
echo Starting calibration mode (auto-detects the Pico)...
echo.
call "%~dp0start-bridge.bat" --calibrate
