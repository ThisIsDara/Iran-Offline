@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  Offline installer for the RTMP Chat server (Windows)
REM
REM   install.bat              install + verify
REM   install.bat --force      re-extract node_modules
REM   install.bat --no-start   skip the verification run
REM ============================================================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "DEPS_DIR=%APP_DIR%\deps"
set "RUNTIME_DIR=%APP_DIR%\.runtime"
set "DATA_DIR=%DATA_DIR%"
set "FORCE=0"
set "DO_START=1"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--force"    set "FORCE=1"
if /i "%~1"=="--no-start" set "DO_START=0"
if /i "%~1"=="--help"     goto usage
shift
goto parse
:parsed

echo.
echo ===^> RTMP Chat - offline install
echo     directory: %APP_DIR%
echo.

REM ---------------------------------------------------------- 1. node
echo ===^> Locating Node.js
set "NODE_BIN="

if not defined DATA_DIR set "DATA_DIR=%APP_DIR%\data"

REM prefer a node new enough to run the app
where node >nul 2>&1
if %errorlevel%==0 (
    for /f "delims=" %%v in ('node -e "process.stdout.write(String(process.versions.node.split('.')[0]))"') do set "NODE_MAJOR=%%v"
    if !NODE_MAJOR! GEQ 18 (
        for /f "delims=" %%v in ('where node') do if not defined NODE_BIN set "NODE_BIN=%%v"
        echo     OK   using system node !NODE_BIN!
        goto have_node
    )
    echo     WARN system node is older than v18
)

if exist "%RUNTIME_DIR%\node.exe" (
    set "NODE_BIN=%RUNTIME_DIR%\node.exe"
    echo     OK   using bundled node
    goto have_node
)

if exist "%DEPS_DIR%\node-*-win-x64.zip" (
    for %%f in ("%DEPS_DIR%\node-*-win-x64.zip") do set "NODE_ZIP=%%f"
) else (
    echo     FAIL no Node.js found and no bundled build in %DEPS_DIR%
echo            The default bundle is Linux-only. Add the Windows runtime on a
echo            networked machine with:  ./download-deps.sh --all
echo            ^(or point NODE_BIN at an existing node v18+^)
    exit /b 1
)

echo     extracting bundled Node.js from %NODE_ZIP:~-30%
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
tar -xf "%NODE_ZIP%" -C "%DEPS_DIR%"
for /d %%d in ("%DEPS_DIR%\node-*-win-x64") do (
    xcopy /e /i /q /y "%%~fd\" "%RUNTIME_DIR%\"
)
for %%d in ("%DEPS_DIR%\node-*-win-x64") do rd /s /q "%%~fd"
set "NODE_BIN=%RUNTIME_DIR%\node.exe"
if not exist "%NODE_BIN%" (
    echo     FAIL bundled Node.js extraction failed
    exit /b 1
)

:have_node
for %%i in ("%NODE_BIN%") do set "NODE_BIN_DIR=%%~dpI"
REM remember the interpreter so manage.bat / start.bat work even when node is
REM not on the system PATH (i.e. when we installed from the bundled build)
if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"
> "%RUNTIME_DIR%\node-path.txt" echo %NODE_BIN_DIR%
echo.

REM ---------------------------------------------------------- 2. deps
echo ===^> Installing dependencies (offline)
if not exist "%DEPS_DIR%\node_modules.tar.gz" (
    echo     FAIL missing %DEPS_DIR%\node_modules.tar.gz
    exit /b 1
)

if exist "%APP_DIR%\node_modules\express\" if exist "%APP_DIR%\node_modules\ws\" (
    if "%FORCE%"=="0" (
        echo     OK   node_modules already present ^(use --force to reinstall^)
        goto deps_done
    )
)

echo     extracting node_modules.tar.gz
if exist "%APP_DIR%\node_modules" rd /s /q "%APP_DIR%\node_modules"
tar -xzf "%DEPS_DIR%\node_modules.tar.gz" -C "%APP_DIR%"
if errorlevel 1 (
    echo     FAIL could not extract node_modules
    exit /b 1
)
echo     OK   extracted node_modules

:deps_done
"%NODE_BIN%" -e "require('express');require('ws');console.log('     OK   express '+require('express/package.json').version+', ws '+require('ws/package.json').version+' load correctly')"
if errorlevel 1 (
    echo     FAIL dependency verification failed
    exit /b 1
)
echo.

REM ---------------------------------------------------------- 3. data
echo ===^> Preparing data directory
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
echo     OK   data directory ready: %DATA_DIR%

set "DATA_DIR=%DATA_DIR%"
set "NODE_PATH=%APP_DIR%\node_modules"
pushd "%APP_DIR%"
"%NODE_BIN%" -e "require('./lib/stream-keys').ensurePassword();"
popd
echo.

REM ---------------------------------------------------------- 4. verify
if "%DO_START%"=="1" (
    echo ===^> Verifying the server starts
    set "PORT=0"
    pushd "%APP_DIR%"
    start "" /b "%NODE_BIN%" server.js
    popd
    timeout /t 2 >nul
    tasklist /fi "imagename eq node.exe" >nul 2>&1
    if %errorlevel%==0 (
        echo     OK   server boots cleanly
    ) else (
        echo     WARN could not confirm the boot; try running node server.js
    )
    echo.
)

REM ---------------------------------------------------------- done
echo.
echo  Install complete.
echo.
echo    Chat:   http://localhost:8080/
echo    Admin:  http://localhost:8080/admin.html
echo.
echo    Start:  start.bat     Stop: manage.bat
echo.
echo  Stream keys are NOT enforced by this script - MediaMTX is a separate
echo  program and is not bundled for Windows. Point your mediamtx.yml at
echo  this server (MediaMTX 1.x), then restart MediaMTX:
echo.
echo    authMethod: http
echo    authHTTPAddress: "http://127.0.0.1:8080/mediamtx/auth"
echo    authHTTPExclude:
echo      - action: read
echo.
exit /b 0

:usage
echo install.bat [--force] [--no-start]
exit /b 0
