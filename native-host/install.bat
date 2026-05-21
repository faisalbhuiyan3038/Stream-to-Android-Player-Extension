@echo off
echo Installing Native Messaging Host...
set DIR=%~dp0

set REG_KEY_FF=HKCU\Software\Mozilla\NativeMessagingHosts\stream_player_host
reg add "%REG_KEY_FF%" /ve /t REG_SZ /d "%DIR%firefox_manifest.json" /f

set REG_KEY_CHROME=HKCU\Software\Google\Chrome\NativeMessagingHosts\stream_player_host
reg add "%REG_KEY_CHROME%" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f

set REG_KEY_EDGE=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\stream_player_host
reg add "%REG_KEY_EDGE%" /ve /t REG_SZ /d "%DIR%chrome_manifest.json" /f

echo.
echo Installed successfully! Note: You must replace 'chrome-extension://<REPLACE_WITH_YOUR_EXTENSION_ID>/'
echo in chrome_manifest.json with your actual extension ID if you use Chrome/Edge.
echo.
pause
