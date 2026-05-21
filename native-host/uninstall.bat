@echo off
echo Uninstalling Native Messaging Host Registry Keys...

set REG_KEY_FF=HKCU\Software\Mozilla\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_FF%" /f >nul 2>&1

set REG_KEY_CHROME=HKCU\Software\Google\Chrome\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_CHROME%" /f >nul 2>&1

set REG_KEY_EDGE=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_EDGE%" /f >nul 2>&1

echo.
echo Uninstalled successfully! Registry entries have been removed.
echo.
pause
