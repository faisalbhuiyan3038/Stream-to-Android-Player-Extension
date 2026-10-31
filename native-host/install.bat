@echo off
setlocal
echo.
echo  =========================================================
echo   Stream to Android Player - Native Host Installer
echo  =========================================================
echo.

set "DIR=%~dp0"
set "HOST_BAT=%DIR%host.bat"
set "EXT_ID=%~1"

:: Use Python to write the manifest files so backslashes are correctly escaped in JSON
echo [1/3] Writing Firefox manifest...
python -c "import json; d={'name':'stream_player_host','description':'Stream to Android Player Native Host','path': r'%HOST_BAT%','type':'stdio','allowed_extensions':['faisalbhuiyan@mozilla']}; open(r'%DIR%firefox_manifest.json','w').write(json.dumps(d,indent=2))"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python failed. Please make sure Python 3 is installed and in your PATH.
    pause
    exit /b 1
)
echo   Written: %DIR%firefox_manifest.json

if "%EXT_ID%"=="" (
    echo [2/3] Enter your Chrome/Edge/Brave Extension ID.
    echo       Open chrome://extensions or edge://extensions, enable Developer Mode,
    echo       and copy the ID from the extension card. Leave blank if you only use Firefox.
    echo.
    set /p EXT_ID=Extension ID ^(leave blank for Firefox only^):
) else (
    echo [2/3] Using extension ID from the command line: %EXT_ID%
)

if "%EXT_ID%"=="" (
    echo   Skipping Chromium manifest.
) else (
    python -c "import json; d={'name':'stream_player_host','description':'Stream to Android Player Native Host','path': r'%HOST_BAT%','type':'stdio','allowed_origins':['chrome-extension://%EXT_ID%/']}; open(r'%DIR%chrome_manifest.json','w').write(json.dumps(d,indent=2))"
    echo   Written: %DIR%chrome_manifest.json
)

echo [3/3] Registering in Windows Registry...
reg add "HKCU\Software\Mozilla\NativeMessagingHosts\stream_player_host" /ve /t REG_SZ /d "%DIR%firefox_manifest.json" /f >nul
echo   Firefox registered.

if NOT "%EXT_ID%"=="" (
    reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\stream_player_host" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f >nul
    reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\stream_player_host" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f >nul
    reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\stream_player_host" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f >nul
    reg add "HKCU\Software\Chromium\NativeMessagingHosts\stream_player_host" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f >nul
    echo   Chrome/Edge/Brave/Chromium registered.
)

echo.
echo  =========================================================
echo   Done! Host path: %HOST_BAT%
echo.
echo   Restart your browser to apply.
echo  =========================================================
echo.
pause
endlocal
