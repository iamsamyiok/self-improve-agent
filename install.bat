@echo off
rem hwj 安装器 — 双击即装：写入用户 PATH（WindowsApps shim），无需管理员/不改注册表
rem 安装后任意目录可用：hwj / hwj tui / hwj gui / hwj run "任务"；卸载双击 uninstall.bat 或 hwj uninstall
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [hwj] 需要 Node.js 18+，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

node bin\hwj.js install %*
echo.
pause
