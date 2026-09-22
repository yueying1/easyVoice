@echo off
cd /d "%~dp0"
set "PATH=%~dp0.bin;%~dp0ffmpeg\bin;%PATH%"
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0

rem ============================================================
rem  Read PORT from .env so the URL below matches the real port.
rem ============================================================
set "EASYVOICE_PORT=3000"
if exist ".env" for /f "tokens=1,2 delims== " %%a in ('findstr /b /c:"PORT=" ".env"') do set "EASYVOICE_PORT=%%b"
set "EASYVOICE_URL=http://localhost:%EASYVOICE_PORT%"
title EasyVoice Server  %EASYVOICE_PORT%

rem ============================================================
rem  pnpm launcher: create it inside .bin when missing (fresh clone)
rem ============================================================
if not exist "%~dp0.bin\pnpm.cmd" (
  echo Preparing pnpm launcher, please wait...
  call corepack enable --install-directory "%~dp0.bin" >nul 2>nul
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo ================================================
  echo   [!] pnpm was not found.
  echo.
  echo   Install Node.js first, then run this once:
  echo       corepack enable --install-directory .bin
  echo   or install pnpm globally:
  echo       npm install -g pnpm
  echo ================================================
  pause
  exit /b 1
)

rem ============================================================
rem  First run: install dependencies and build
rem ============================================================
if not exist "packages\backend\dist\server.js" (
  echo ================================================
  echo   First run detected. Dependencies will be installed
  echo   and the project will be built. This can take several
  echo   minutes - please keep this window open.
  echo ================================================
  echo.
  call pnpm install
  if errorlevel 1 goto buildfail
  call pnpm build
  if errorlevel 1 goto buildfail
  echo.
  echo Build finished.
  echo.
)

rem ============================================================
rem  ffmpeg check (needed to concatenate audio segments)
rem ============================================================
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ================================================
  echo   [!] ffmpeg was not found.
  echo   Audio synthesis needs it. Either put ffmpeg.exe and
  echo   ffprobe.exe into:  ffmpeg\bin\
  echo   or install it, for example:  winget install Gyan.FFmpeg
  echo   The server will still start, but generating audio
  echo   will fail.
  echo ================================================
  ping -n 5 127.0.0.1 >nul
)

rem ============================================================
rem  Port check
rem ============================================================
netstat -ano | findstr ":%EASYVOICE_PORT% " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo ================================================
  echo   EasyVoice is ALREADY running on port %EASYVOICE_PORT%.
  echo.
  echo   Open this in your browser:
  echo       %EASYVOICE_URL%
  echo.
  echo   To restart it, close the old EasyVoice window first.
  echo ================================================
  ping -n 5 127.0.0.1 >nul
  exit /b 0
)

echo ================================================
echo   EasyVoice is starting, please wait...
echo   Keep this window open while using EasyVoice.
echo   Close this window to stop the server.
echo.
echo   Open this in your browser:
echo       %EASYVOICE_URL%
echo.
echo   Full novel, chapter by chapter:
echo       %EASYVOICE_URL%/chapter
echo ================================================
echo.

call pnpm start
pause
exit /b 0

:buildfail
echo.
echo ================================================
echo   [!] Install or build failed. Please read the messages
echo   above (common causes: no network, no disk space,
echo   Node.js version too old).
echo ================================================
pause
exit /b 1
