@echo off
echo.
echo  =========================================================
echo   Stream to Android Player - Native Host Installer
echo  =========================================================
echo.

set DIR=%~dp0
set HOST_BAT=%DIR%host.bat

:: Use Python to write the manifest files so backslashes are correctly escaped in JSON
echo [1/3] Writing Firefox manifest...
python -c "import json, sys; d={'name':'stream_player_host','description':'Stream to Android Player Native Host','path': r'%HOST_BAT%','type':'stdio','allowed_extensions':['faisalbhuiyan@mozilla']}; open(r'%DIR%firefox_manifest.json','w').write(json.dumps(d,indent=2))"
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python failed. Please make sure Python is installed and in your PATH.
    pause
    exit /b 1
)
echo   -> Written: %DIR%firefox_manifest.json

echo [2/3] Enter your Chrome/Edge Extension ID.
echo       (Open chrome://extensions or edge://extensions, enable
echo        Developer Mode, and copy the ID from the extension card.)
echo       Leave blank if you only use Firefox.
echo.
set /p EXT_ID=Extension ID (leave blank for Firefox only): 

if "%EXT_ID%"=="" (
    echo   Skipping Chrome/Edge manifest.
) else (
    python -c "import json; d={'name':'stream_player_host','description':'Stream to Android Player Native Host','path': r'%HOST_BAT%','type':'stdio','allowed_origins':['chrome-extension://%EXT_ID%/']}; open(r'%DIR%chrome_manifest.json','w').write(json.dumps(d,indent=2))"
    echo   -> Written: %DIR%chrome_manifest.json
)

echo [3/3] Registering in Windows Registry...
set REG_KEY_FF=HKCU\Software\Mozilla\NativeMessagingHosts\stream_player_host
reg add "%REG_KEY_FF%" /ve /t REG_SZ /d "%DIR%firefox_manifest.json" /f >nul
echo   -> Firefox registered.

if NOT "%EXT_ID%"=="" (
    set REG_KEY_CHROME=HKCU\Software\Google\Chrome\NativeMessagingHosts\stream_player_host
    reg add "%REG_KEY_CHROME%" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f >nul

    set REG_KEY_EDGE=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\stream_player_host
    reg add "%REG_KEY_EDGE%" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f >nul
    echo   -> Chrome/Edge registered.
)

echo.
echo  =========================================================
echo   Done! Host path: %HOST_BAT%
echo.
echo   Restart Firefox and reload the extension to apply.
echo  =========================================================
echo.
pause
