@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  Rebuild the offline bundle in deps\. Windows version.
REM  This is the only script that needs the internet.
REM ============================================================

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "DEPS_DIR=%APP_DIR%\deps"
set "NODE_VERSION=v24.12.0"
if defined NODE_VER set "NODE_VERSION=%NODE_VER%"

cd /d "%APP_DIR%"
if not exist "%DEPS_DIR%" mkdir "%DEPS_DIR%"

echo ==^> Refreshing node_modules from package-lock.json
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto failed

echo ==^> Packing node_modules
if exist "%DEPS_DIR%\node_modules.tar.gz" del "%DEPS_DIR%\node_modules.tar.gz"
tar -czf "%DEPS_DIR%\node_modules.tar.gz" -C "%APP_DIR%" node_modules
if errorlevel 1 goto failed

echo ==^> Downloading Node.js %NODE_VERSION% runtimes
set "BASE=https://nodejs.org/dist/%NODE_VERSION%"
for %%A in (node-%NODE_VERSION%-linux-x64.tar.xz node-%NODE_VERSION%-linux-arm64.tar.xz node-%NODE_VERSION%-win-x64.zip) do (
    if exist "%DEPS_DIR%\%%A" (
        echo     have     %%A
    ) else (
        echo     fetching %%A
        powershell -NoProfile -Command "Invoke-WebRequest -Uri '%BASE%/%%A' -OutFile '%DEPS_DIR%\%%A' -UseBasicParsing" || goto failed
    )
)

REM Generate SHA256SUMS. Written with [IO.File]::WriteAllText and explicit "\n"
REM so the file has LF endings - sha256sum -c on Linux fails on CRLF files.
powershell -NoProfile -Command ^
  "$d='%DEPS_DIR%'; $lines=Get-ChildItem $d -File | Where-Object { $_.Extension -in '.gz','.xz','.zip' } | Sort-Object Name | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() + '  ' + $_.Name }; [IO.File]::WriteAllText((Join-Path $d 'SHA256SUMS'), (($lines -join \"`n\") + \"`n\"))" || goto failed
type "%DEPS_DIR%\SHA256SUMS"

echo.
echo Done. Copy the whole project (including deps\) to the offline server.
echo.
goto :eof

:failed
echo.
echo FAILED - see errors above.
exit /b 1
