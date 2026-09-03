@echo off
rem dual-agent 一键发布打包 — 白名单导出（绝不包含 API key / 会话 / 运行数据）
rem 产物：dist\dual-agent-<版本>.zip（PowerShell Compress-Archive，Windows 自带，零依赖）
rem 干净仓库直接打包；本机若有运行数据（.data/ workspaces/）也不会进入包内（白名单机制）
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title dual-agent 发布打包

where node >nul 2>nul
if errorlevel 1 (
  echo [release] 需要 Node.js 18+：https://nodejs.org/
  pause
  exit /b 1
)

node tools\release.js %*
set "EC=%errorlevel%"
if "%EC%"=="0" (
  echo.
  echo 打包完成。发布建议：
  echo   1. 上传 dist\dual-agent-*.zip 到 GitHub Release / 网盘
  echo   2. 用户解压后：双击 install.bat 装入 PATH，即可任意目录使用 hwj 命令
  echo   3. 首次启动会引导配置内层 API（/config），或双击 demo.bat 免配置体验
)
if not "%~1"=="--check" if not "%~1"=="--list" pause
endlocal & exit /b %EC%
