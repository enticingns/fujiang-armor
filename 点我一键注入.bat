@echo off
setlocal
title Fujiang Armor Installer
echo.
echo  Select injection mode:
echo.
echo    [1] user session injection  (default, recommended)
echo        Prefix kernel to the last user message; survives system-rewriting gateways
echo.
echo    [2] legacy injection  (old version)
echo        system dual-layer sections: Order 100 kernel + Order 200 mirror
echo.
set "DSH_MODE=user"
set /p "DSH_SEL=Enter number and press Enter (blank = 1): "
if "%DSH_SEL%"=="2" set "DSH_MODE=legacy"
if /I "%DSH_SEL%"=="legacy" set "DSH_MODE=legacy"
echo.
echo Installing Fujiang Armor (mode: %DSH_MODE%)...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -InjectionMode %DSH_MODE% %*
set "DSH_INSTALL_RESULT=%ERRORLEVEL%"
echo.
if not "%DSH_INSTALL_RESULT%"=="0" echo Installation failed. See the message above.
if not "%DSH_INSTALL_NO_PAUSE%"=="1" pause
exit /b %DSH_INSTALL_RESULT%
