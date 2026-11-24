@echo off
setlocal
set "HERE=%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"

set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)
if not defined NODE (
  echo [X] Node.js was not found.
  echo     Install Node.js LTS from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

echo Starting Spectro Dose Reader on http://127.0.0.1:%PORT%/
echo Close the "Spectro Dose Reader - server" window to stop the server.

if /i "%NODE%"=="node" (
  start "Spectro Dose Reader - server" node "%HERE%serve.mjs"
) else (
  start "Spectro Dose Reader - server" "%NODE%" "%HERE%serve.mjs"
)

ping 127.0.0.1 -n 3 >nul

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if defined BROWSER (
  start "" "%BROWSER%" "http://127.0.0.1:%PORT%/"
) else (
  start "" "http://127.0.0.1:%PORT%/"
)
exit /b 0
