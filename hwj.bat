@echo off
rem hwj 统一入口 — Windows 双击/终端启动
rem 双击出现选择菜单：[1] 永久安装（默认）[2] 临时使用（专用窗口，关窗即失效）[3] 直接启动
rem 终端带参数则直接透传：hwj tui / hwj gui / hwj run "任务" / hwj install / hwj help
rem 本机 Node.js 优先直接启动；未装/版本过低时降级 WSL。HWJ_HOME 可指定 dual-agent 的 WSL 侧绝对路径
setlocal
title hwj 终端智能体
chcp 65001 >nul
cd /d "%~dp0"

rem ---- 临时会话模式（菜单选项 2 打开的专用窗口，PATH 仅在本窗口生效） ----
if /i "%~1"=="__tempsession" goto tempsession

rem ---- 1. 本机 Node.js：存在且 ≥18 则直接启动 ----
where node >nul 2>nul
if errorlevel 1 goto trywsl
node -e "process.versions.node.split('.')[0]>=18||process.exit(1)" >nul 2>nul
if errorlevel 1 (
  set "NATIVE_OLD=1"
  goto trywsl
)

rem ---- 有参数：直接透传调度器（tui/gui/run/install/uninstall/help…） ----
if not "%~1"=="" goto dispatch

rem ---- 无参数（多为双击）：选择使用方式（菜单由 Node 输出，中文不经 cmd 解析） ----
:menu
set "CHOICE="
node bin\hwj.js _choose > "%TEMP%\hwj-choice.txt"
set /p CHOICE=<"%TEMP%\hwj-choice.txt"
del "%TEMP%\hwj-choice.txt" >nul 2>nul
if "%CHOICE%"=="1" goto perm
if "%CHOICE%"=="2" goto temp
if "%CHOICE%"=="3" goto launch
goto menu

:perm
node bin\hwj.js install
if errorlevel 1 goto failpause
echo.

:launch
set "MENU_LAUNCHED=1"

:dispatch
node bin\hwj.js %*
set "EC=%errorlevel%"
if "%EC%"=="0" if not defined MENU_LAUNCHED endlocal & exit /b 0
if not "%~1"=="" if not defined MENU_LAUNCHED endlocal & exit /b %EC%
echo.
echo [hwj] exited, code %EC%
pause
endlocal & exit /b %EC%

:temp
start "hwj temp session" cmd /k ""%~f0" __tempsession"
node bin\hwj.js _tempnote
pause
endlocal & exit /b 0

:tempsession
set "PATH=%~dp0;%PATH%"
title hwj temp session
node "%~dp0bin\hwj.js" _temphint
cd /d "%USERPROFILE%"
endlocal & exit /b 0

:trywsl
rem ---- 2. WSL 降级路径（本机无 Node 或版本过低时） ----
rem 注意：wsl.exe 存在不代表 WSL 可用——未装发行版时仅打印帮助文本，
rem 必须实测一条绝对路径命令（wsl -e 不经 shell，不做 PATH 查找）
wsl.exe -e /bin/true >nul 2>nul
if errorlevel 1 goto nowsl

rem 2a. HWJ_HOME 显式指定
if not "%HWJ_HOME%"=="" (
  wsl.exe -e bash -c "test -f '%HWJ_HOME%/hwj/hwj.js'" >nul 2>nul
  if not errorlevel 1 goto checknode
  echo [hwj] HWJ_HOME 指向的路径无效：%HWJ_HOME%（找不到 hwj/hwj.js）
  goto fail
)

rem 2b. 把双击位置（bat 所在 Windows 目录）映射为 WSL 路径
rem（WSL 不可用时 wslpath 会输出帮助文本乱码，以“/”开头校验兜底过滤）
set "WSHOME="
for /f "usebackq delims=" %%i in (`wsl.exe wslpath -a "%~dp0."`) do set "WSHOME=%%i"
if not "%WSHOME%"=="" if "%WSHOME:~0,1%"=="/" (
  wsl.exe -e bash -c "test -f '%WSHOME%/hwj/hwj.js'" >nul 2>nul
  if not errorlevel 1 goto checknode
)

rem 2c. 兜底探测常见安装位置
for %%d in (~/dual-agent /workspace/dual-agent ~/agents-chat/dual-agent) do (
  wsl.exe -e bash -c "test -f '%%d/hwj/hwj.js'" >nul 2>nul
  if not errorlevel 1 (
    set "WSHOME=%%d"
    goto checknode
  )
)

echo [hwj] WSL 内未找到 hwj/hwj.js——请确认 dual-agent 仓库位置。
echo        可设置环境变量 HWJ_HOME 指向 dual-agent 的 WSL 侧绝对路径（如 /workspace/dual-agent）后重试，
echo        或安装本机 Node.js（18+）：https://nodejs.org/ 后双击即可直接启动。
goto fail

:checknode
rem ---- 3. WSL 内 Node.js 存在性与版本（≥18） ----
wsl.exe -e bash -lc "command -v node >/dev/null 2>&1 || exit 1; v=$(node -v 2>/dev/null | sed 's/v//;s/\..*//'); [ \"$v\" -ge 18 ] 2>/dev/null || exit 2" >nul 2>nul
if errorlevel 2 goto badnode
if errorlevel 1 goto nonode

rem ---- 4. 经调度器启动（子命令透传） ----
wsl.exe -e bash -lc "cd '%WSHOME%' && exec node bin/hwj.js %*"
set "EC=%errorlevel%"
if "%EC%"=="0" endlocal & exit /b 0
if not "%~1"=="" endlocal & exit /b %EC%
echo.
echo [hwj] 已退出（代码 %EC%）
pause
endlocal & exit /b %EC%

:nowsl
echo [hwj] 无法启动：
if defined NATIVE_OLD (
  echo        - 本机 Node.js 版本低于 18（hwj 需要 18+），请升级：https://nodejs.org/
) else (
  echo        - 本机未安装 Node.js。推荐安装 18+ 版本后重试：https://nodejs.org/
)
echo        - 或经 WSL 运行，但当前 WSL 不可用或未安装发行版。安装方法（管理员 PowerShell）：
echo        wsl --install -d Ubuntu
echo        安装完成后重启电脑，再双击本脚本。
goto fail

:nonode
echo [hwj] 本机无 Node.js 且 WSL 内也未安装。推荐直接装本机 Node（https://nodejs.org/）；
echo        或在 WSL 终端内执行：
echo        sudo apt update ^&^& sudo apt install -y curl
echo        curl -fsSL https://deb.nodesource.com/setup_20.x ^| sudo -E bash -
echo        sudo apt install -y nodejs
goto fail

:badnode
echo [hwj] 本机与 WSL 内 Node.js 版本均低于 18（hwj 需要 18+）。推荐升级本机 Node：https://nodejs.org/
echo        或在 WSL 内升级：
echo        sudo apt remove -y nodejs ^&^& curl -fsSL https://deb.nodesource.com/setup_20.x ^| sudo -E bash - ^&^& sudo apt install -y nodejs
goto fail

:failpause
echo.
pause
endlocal
exit /b 1

:fail
echo.
pause
endlocal
exit /b 1
