@echo off
title dual-agent - 演示模式
chcp 65001 >nul
cd /d "%~dp0"

rem 演示模式：无需配置任何 API，体验完整流程（端口探测/代理兼容/自动开浏览器与 start.bat 一致）
set "DUAL_AGENT_MOCK=1"
call start.bat
