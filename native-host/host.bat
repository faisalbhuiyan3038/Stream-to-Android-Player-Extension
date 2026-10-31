@echo off
:: Try python, then python3, then py (Windows Store Python launcher)
where python >nul 2>&1
if %ERRORLEVEL% == 0 (
  python "%~dp0host.py"
  goto :end
)

where python3 >nul 2>&1
if %ERRORLEVEL% == 0 (
  python3 "%~dp0host.py"
  goto :end
)

where py >nul 2>&1
if %ERRORLEVEL% == 0 (
  py "%~dp0host.py"
  goto :end
)

echo Python 3 was not found on PATH. Install it from python.org and re-run install.bat. 1>&2

:end
