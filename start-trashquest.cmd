@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-trashquest.ps1"
echo.
if errorlevel 1 (
  echo TrashQuest did not start. Review the error above.
) else (
  echo TrashQuest started successfully. You may close this launcher window.
)
pause
