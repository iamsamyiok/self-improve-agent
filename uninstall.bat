@echo off
rem hwj 卸载器 — 从 PATH 移除 hwj 命令（仓库本体不动，双击 hwj.bat/start.bat 仍可用）
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [hwj] 需要 Node.js 18+ 才能运行卸载器。也可手动删除：
  echo        %%LOCALAPPDATA%%\Microsoft\WindowsApps\hwj.cmd
  pause
  exit /b 1
)

node bin\hwj.js uninstall
echo.
pause
