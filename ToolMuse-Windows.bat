@echo off
chcp 65001 >nul
title NextTool - Muse AI
cd /d "%~dp0"

rem Uu tien Node.js di kem trong thu muc node\ (ban dong goi san), neu khong co thi dung Node.js da cai tren may.
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay Node.js. Hay tai ban dong goi san co kem Node.js, hoac cai Node.js ban LTS tai https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo Lan dau chay: dang cai thu vien va trinh duyet Chromium, vui long cho vai phut...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Cai dat that bai. Kiem tra ket noi mang roi chay lai.
    pause
    exit /b 1
  )
)

echo Dang mo NextTool - Muse AI tai http://localhost:3456 ... - dong cua so nay de tat tool
rem Viet tren 1 dong de cmd khong doc lai file .bat sau khi tool tu cap nhat ghi de file nay.
node launcher.js & pause & exit /b
