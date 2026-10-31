@echo off
setlocal
:: Removes the vlc:// / mpv:// registration made by register-windows.bat (current user only).
:: Usage: unregister-windows.bat [vlc] [mpv]      (default: vlc)
set "SCHEMES=%*"
if "%SCHEMES%"=="" set "SCHEMES=vlc"
for %%S in (%SCHEMES%) do (
    reg delete "HKCU\Software\Classes\%%S" /f >nul 2>&1
    echo Removed %%S://
)
pause
endlocal
