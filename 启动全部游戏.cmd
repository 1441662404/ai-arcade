@echo off
chcp 65001 >nul
title AI Arcade - 本地游戏服务器

set "BASE=%~dp0"

echo.
echo   ============================================
echo    AI Arcade - 正在启动七款游戏
echo   ============================================
echo.

echo   [1/7] 沉浸驾驶        http://localhost:3001
start "沉浸驾驶 :3001" cmd /c "cd /d "%BASE%沉浸驾驶" && set PORT=3001 && node server.js"

echo   [2/7] 山路传说        http://localhost:3002
start "山路传说 :3002" cmd /c "cd /d "%BASE%山路传说" && set PORT=3002 && node server.js"

echo   [3/7] 战火英雄        http://localhost:3003
start "战火英雄 :3003" cmd /c "cd /d "%BASE%战火英雄" && set PORT=3003 && node server.js"

echo   [4/7] 便便英雄        http://localhost:3004
start "便便英雄 :3004" cmd /c "cd /d "%BASE%便便英雄" && set PORT=3004 && node server.js"

echo   [5/7] 足球盛宴        http://localhost:3005
start "足球盛宴 :3005" cmd /c "cd /d "%BASE%足球盛宴" && set PORT=3005 && node server.js"

echo   [6/7] 云端之刺        http://localhost:3006
start "云端之刺 :3006" cmd /c "cd /d "%BASE%Cloud Thorn\sky-dogfight" && set PORT=3006 && node server.js"

echo   [7/7] 山道飞骑        http://localhost:3007
start "山道飞骑 :3007" cmd /c "cd /d "%BASE%Nbike" && set PORT=3007 && node server.js"

echo.
echo   七个服务已在各自的窗口启动。
echo   浏览器打开上面的地址即可游玩。
echo.
echo   关闭对应窗口 = 停止该游戏。
echo   全部关闭后重新运行本脚本即可再次启动。
echo.

timeout /t 3 >nul
start "" "http://localhost:3001"

echo   已在浏览器打开沉浸驾驶，其余游戏请手动访问上面的地址。
echo.
pause
