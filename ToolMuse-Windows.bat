@echo off
chcp 65001 >nul
title NextTool - Muse AI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Hay tai ban LTS tai https://nodejs.org roi chay lai file nay.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo Lan dau chay: dang cai thu vien va trinh duyet Chromium, vui long cho vai phut...
  call npm install
  if errorlevel 1 (
    echo Cai dat that bai. Kiem tra ket noi mang roi chay lai.
    pause
    exit /b 1
  )
)

echo Dang mo NextTool - Muse AI tai http://localhost:3456 ... (dong cua so nay de tat tool)
node launcher.js
pause
