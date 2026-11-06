@echo off
setlocal enabledelayedexpansion
title Fujiang Armor - check injection
rem 用法：双击检查默认实例；把隔离实例的数据目录拖到本文件上可检查隔离实例。

set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  for /d %%d in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if not defined NODE if exist "%%d\dependencies\node\bin\node.exe" set "NODE=%%d\dependencies\node\bin\node.exe"
  )
)
if not defined NODE (
  for /d %%d in ("%LOCALAPPDATA%\FujiangArmor\runtime\*") do (
    if not defined NODE if exist "%%d\node.exe" set "NODE=%%d\node.exe"
  )
)
if not defined NODE (
  echo ERROR: node.exe not found. Run install.ps1 once, or install Node.js 22+.
  if not "%DSH_CHECK_NO_PAUSE%"=="1" pause
  exit /b 2
)

if "%~1"=="" (
  "%NODE%" "%~dp0scripts\check-injection.mjs"
) else (
  "%NODE%" "%~dp0scripts\check-injection.mjs" --home "%~1"
)

set "RC=%ERRORLEVEL%"
echo.
if not "%DSH_CHECK_NO_PAUSE%"=="1" pause
exit /b %RC%
