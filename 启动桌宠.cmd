@echo off
setlocal
title Mao Pet - Restart Backend + Launch

rem ==========================================================================
rem  Repo-root launcher for Mao-pet (DSH 专用 Live2D 桌宠)
rem
rem  1) stop the old backend on :8000
rem  2) start the backend from THIS repo
rem  3) verify the DSH plugin routes are live
rem  4) launch the pet window if it is not running
rem
rem  Usage (run from anywhere; path is resolved from this file's own folder):
rem    double-click             -> restart backend, keep the running pet window
rem    启动桌宠.cmd -ForcePet    -> ALSO restart the pet shell (after editing
rem                                main.js / preload.js)
rem    启动桌宠.cmd -SkipPet     -> backend only, never touch the pet
rem
rem  First time on a new machine: run 安装依赖.ps1 once (it also provisions the
rem  ACL + Low integrity label that Electron needs, see
rem  docs/项目独立性-技术分析.md §11).
rem ==========================================================================

rem --- repo root = the folder this .cmd lives in (no hard-coded paths) ------
set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"
set "PS1=%REPO%\restart_mio.ps1"

if not exist "%PS1%" (
    echo.
    echo [ERROR] Not found: "%PS1%"
    echo         This .cmd must stay in the repository root, next to restart_mio.ps1.
    echo.
    pause
    exit /b 1
)

rem --- pick an available PowerShell (pwsh 7 preferred, 5.1 as fallback) -----
set "PS="
where pwsh >nul 2>nul && set "PS=pwsh"
if not defined PS (
    where powershell >nul 2>nul && set "PS=powershell"
)
if not defined PS (
    echo.
    echo [ERROR] Neither "pwsh" nor "powershell" was found in PATH.
    echo         Windows ships with powershell.exe - check your PATH.
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   Mao Pet - Restart Backend + Launch
echo ==========================================
echo.
echo   [1] Stop the OLD backend on port 8000
echo   [2] Start the backend from %REPO%
echo   [3] Verify the DSH plugin routes are live
echo   [4] Launch the pet if it is not running
echo.
echo   PowerShell : %PS%
echo   Args       : %*
echo.
echo   Note: the running pet window is NOT restarted by default.
echo         It reconnects to the backend automatically.
echo         After editing main.js / preload.js, run this again with -ForcePet.
echo.

%PS% -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo Restart done! Backend now serves the DSH plugin routes.
) else (
    echo [WARN] The restart script returned exit code %RC%.
    echo        Check start_mio.log / backend_err.log in the repo root.
)
echo.
pause
exit /b %RC%
