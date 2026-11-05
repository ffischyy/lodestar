@echo off
REM Runs the backend test suite (about 1 minute). Run start.bat once first to create the environment.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run start.bat once first so the Python environment exists.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r backend\requirements-dev.txt --quiet
cd backend
"..\.venv\Scripts\python.exe" -m pytest -v
cd ..
pause
