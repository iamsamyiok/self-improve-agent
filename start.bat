@echo off
title dual-agent
chcp 65001 >nul
cd /d "%~dp0"

rem ---------- 代理工具兼容（Clash 等）：仅本脚本进程内直连 localhost，不改系统/注册表设置 ----------
set "NO_PROXY=localhost,127.0.0.1"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "http_proxy="
set "https_proxy="

rem ---------- 一键启动：挑空闲端口 → 前台起服务（就绪后服务自动打开浏览器） ----------
rem 自定义起始端口：set DUAL_AGENT_PORT=3800 && start.bat

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 18+ 版本：https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=3788"
if not "%DUAL_AGENT_PORT%"=="" set "PORT=%DUAL_AGENT_PORT%"
set /a TRIES=0

:pickport
node tools\probe.js %PORT% free >nul 2>nul
if errorlevel 1 goto notfree
goto startsvr

:notfree
rem 端口有响应：若已是本程序在跑，直接开浏览器复用
node tools\probe.js %PORT% ours >nul 2>nul
if not errorlevel 1 (
  start "" http://localhost:%PORT%/
  exit /b 0
)
set /a TRIES+=1
if %TRIES% gtr 8 (
  echo 端口 3788-3796 都被其他程序占用，请检查后重试
  pause
  exit /b 1
)
set /a PORT+=1
goto pickport

:startsvr
echo 正在启动 dual-agent（端口 %PORT%，就绪后自动打开浏览器）...
echo 全部网页关闭且无任务执行时，约 1 分钟后自动退出；关闭本窗口立即停止。
rem 前台运行：关闭窗口即停止服务；Ctrl+C 优雅退出
node server.js --port %PORT%

echo.
echo 服务已停止
pause
