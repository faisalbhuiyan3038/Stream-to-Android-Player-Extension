@echo off
echo.
echo  =========================================================
echo   Stream to Android Player - Native Host Uninstaller
echo  =========================================================
echo.

:: Firefox
set REG_KEY_FF=HKCU\Software\Mozilla\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_FF%" /f >nul 2>&1
echo   [x] Firefox registry key removed.

:: Chrome
set REG_KEY_CHROME=HKCU\Software\Google\Chrome\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_CHROME%" /f >nul 2>&1
echo   [x] Chrome registry key removed.

:: Edge
set REG_KEY_EDGE=HKCU\Software\Microsoft\Edge\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_EDGE%" /f >nul 2>&1
echo   [x] Edge registry key removed.

:: Chromium (some builds use a separate key)
set REG_KEY_CHROMIUM=HKCU\Software\Chromium\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_CHROMIUM%" /f >nul 2>&1
echo   [x] Chromium registry key removed.

:: Brave
set REG_KEY_BRAVE=HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_BRAVE%" /f >nul 2>&1
echo   [x] Brave registry key removed.

:: Opera
set REG_KEY_OPERA=HKCU\Software\Opera Software\NativeMessagingHosts\stream_player_host
reg delete "%REG_KEY_OPERA%" /f >nul 2>&1
echo   [x] Opera registry key removed.

:: Also check HKLM in case it was ever installed system-wide (requires admin)
reg delete "HKLM\Software\Mozilla\NativeMessagingHosts\stream_player_host" /f >nul 2>&1
reg delete "HKLM\Software\Google\Chrome\NativeMessagingHosts\stream_player_host" /f >nul 2>&1
reg delete "HKLM\Software\Microsoft\Edge\NativeMessagingHosts\stream_player_host" /f >nul 2>&1
echo   [x] System-wide keys checked (admin-level).

echo.
echo  =========================================================
echo   Uninstall complete. You may also delete the native-host
echo   folder if you no longer need it.
echo  =========================================================
echo.
pause
