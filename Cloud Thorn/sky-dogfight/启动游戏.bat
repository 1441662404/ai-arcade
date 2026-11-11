@echo off
chcp 65001 >nul
title Sky Dogfight · 苍穹空战
cd /d "%~dp0"

echo ==========================================
echo   Sky Dogfight · 苍穹空战
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 18 或更高版本。
  echo        下载地址: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\socket.io" (
  echo [1/2] 首次运行，正在安装依赖（express / socket.io）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [1/2] 依赖已就绪。
)

echo [2/2] 启动服务器，浏览器将自动打开 http://localhost:3000
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js

echo.
echo 服务器已停止。
pause
