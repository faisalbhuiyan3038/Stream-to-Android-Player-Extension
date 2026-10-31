@echo off
setlocal
:: Registers vlc:// (and optionally mpv://) so links from the extension open in the player.
:: Writes only to HKEY_CURRENT_USER (no administrator rights). Undo with unregister-windows.bat.
:: Usage: register-windows.bat [vlc] [mpv]      (default: vlc)

set "HANDLER=%~dp0handler.py"
set "PYW="
for /f "delims=" %%P in ('where pythonw 2^>nul') do if not defined PYW set "PYW=%%P"
if not defined PYW (
    echo pythonw.exe was not found on PATH. Install Python 3 from python.org and tick "Add to PATH".
    pause
    exit /b 1
)

set "SCHEMES=%*"
if "%SCHEMES%"=="" set "SCHEMES=vlc"

for %%S in (%SCHEMES%) do call :register %%S

echo.
echo Done. Handler: %HANDLER%
echo Using:         %PYW%
echo The first time you click a link the browser asks which application to use: choose the entry for Python / this script.
pause
endlocal
exit /b 0

:register
:: (a subroutine, so paths containing parentheses such as "Program Files (x86)" are safe)
echo Registering %1:// ...
reg add "HKCU\Software\Classes\%1" /ve /d "URL:%1 Protocol" /f >nul
reg add "HKCU\Software\Classes\%1" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\%1\shell\open\command" /ve /d "\"%PYW%\" \"%HANDLER%\" \"%%1\"" /f >nul
exit /b 0
