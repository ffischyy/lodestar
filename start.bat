@echo off
REM Lodestar launcher for Windows. Double-click to start.
REM First run creates a private Python environment in .venv and installs packages (2-5 minutes).
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Lodestar

set "PY="
for %%V in (3.12 3.13 3.11) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>nul && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) else 1)" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo  Lodestar needs Python 3.11, 3.12 or 3.13 ^(64-bit^).
  echo  Install Python 3.12 from https://www.python.org/downloads/windows/
  echo  and tick "Add python.exe to PATH" during setup. Then run start.bat again.
  echo.
  start "" https://www.python.org/downloads/windows/
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo  Creating the Python environment with !PY! ...
  !PY! -m venv .venv || goto :fail
)

REM Reinstall packages only when requirements.txt changes.
set "STAMP=.venv\requirements.stamp"
fc /b "backend\requirements.txt" "%STAMP%" >nul 2>nul
if errorlevel 1 (
  echo  Installing packages. This takes a few minutes the first time...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
  ".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt || goto :fail
  copy /y "backend\requirements.txt" "%STAMP%" >nul
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo  Created .env from .env.example. Add API keys there or in the app under Data providers.
)

set LODESTAR_OPEN_BROWSER=1
cd backend
"..\.venv\Scripts\python.exe" -m lodestar.main
cd ..
echo.
echo  Lodestar has stopped.
pause
exit /b 0

:fail
echo.
echo  Setup failed. See the messages above, and TROUBLESHOOTING in README.md.
pause
exit /b 1
