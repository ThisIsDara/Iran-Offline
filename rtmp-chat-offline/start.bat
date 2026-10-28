@echo off
setlocal enabledelayedexpansion

REM Use the interpreter chosen by install.bat (bundled Node if node isn't installed)
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if exist "%APP_DIR%\.runtime\node-path.txt" (
    set /p NODE_DIR=<"%APP_DIR%\.runtime\node-path.txt"
    if exist "!NODE_DIR!" set "PATH=!NODE_DIR!;%PATH%"
)

echo Starting RTMP Chat Server...
echo.
echo Access the chat at: http://localhost:8080
echo Admin panel:        http://localhost:8080/admin.html
echo.
cd /d "%APP_DIR%"
node server.js
