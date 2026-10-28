@echo off
setlocal enabledelayedexpansion

set "PID_FILE=.server.pid"

REM Use the interpreter chosen by install.bat (bundled Node if node isn't installed)
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if exist "%APP_DIR%\.runtime\node-path.txt" (
    set /p NODE_DIR=<"%APP_DIR%\.runtime\node-path.txt"
    if exist "!NODE_DIR!" set "PATH=!NODE_DIR!;%PATH%"
)
cd /d "%APP_DIR%"

:menu
cls
echo ====================================
echo     RTMP Chat Server Manager
echo ====================================
echo.
call :status
echo.
echo 1. Start Server
echo 2. Stop Server
echo 3. Restart Server
echo 4. Status
echo 5. Exit
echo.
set /p "choice=Choose option: "

if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto restart
if "%choice%"=="4" goto status
if "%choice%"=="5" exit

echo Invalid option
timeout /t 2 >nul
goto menu

:start
if exist "%PID_FILE%" (
    for /f %%i in (%PID_FILE%) do set PID=%%i
    tasklist /fi "pid eq !PID!" 2>nul | findstr /i "node.exe" >nul
    if !errorlevel!==0 (
        del "%PID_FILE%"
    ) else (
        echo Server is already running
        timeout /t 2 >nul
        goto menu
    )
)
echo Starting server...
start /b node server.js >nul 2>&1
timeout /t 1 >nul
for /f %%i in ('powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.MainModule.FileName -like '*server.js*'} | Select-Object -First 1 -ExpandProperty Id"') do (
    echo %%i > "%PID_FILE%"
)
if exist "%PID_FILE%" (
    echo Server started
) else (
    echo Failed to start server
)
timeout /t 2 >nul
goto menu

:stop
if not exist "%PID_FILE%" (
    echo Server is not running
    timeout /t 2 >nul
    goto menu
)
for /f %%i in (%PID_FILE%) do set PID=%%i
taskkill /f /pid !PID! >nul 2>&1
del "%PID_FILE%" 2>nul
echo Server stopped
timeout /t 2 >nul
goto menu

:restart
call :stop
timeout /t 1 >nul
call :start
goto menu

:status
if exist "%PID_FILE%" (
    for /f %%i in (%PID_FILE%) do set PID=%%i
    tasklist /fi "pid eq !PID!" 2>nul | findstr /i "node.exe" >nul
    if !errorlevel!==0 (
        echo Server is NOT running
    ) else (
        echo Server is running ^(PID: !PID!^)
    )
) else (
    echo Server is not running
)
goto :eof

endlocal
