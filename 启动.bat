@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title SPECTRA - 音乐节奏游戏

set "PY="

rem ---- 1) WorkBuddy 内置的 Python ----
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\python\versions\*") do (
  if exist "%%D\python.exe" set "PY=%%D\python.exe"
)

rem ---- 2) py 启动器 ----
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%P in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do set "PY=%%P"
  )
)

rem ---- 3) PATH 里的 python（跳过 Microsoft Store 的占位程序）----
if not defined PY (
  for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined PY (
      echo %%P | findstr /i "WindowsApps" >nul
      if errorlevel 1 set "PY=%%P"
    )
  )
)

if not defined PY goto nopython

echo.
echo   正在启动 SPECTRA ...
echo   Python: %PY%
echo.
echo   浏览器会自动打开 http://127.0.0.1:8777/
echo   按 Ctrl+C 停止服务，然后关掉这个窗口。
echo.

"%PY%" "tools\serve.py" 8777
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="2" (
  echo   [OK] 服务本来就在运行，浏览器已经打开了。
  echo   这个窗口可以直接关掉，不影响使用。
  echo.
  echo   注意：浏览器地址栏必须是 http://127.0.0.1:8777/
  echo   如果显示的是 *.github.io 那种地址，B 站解析是不工作的。
  echo   B 站转 MP3 页面：http://127.0.0.1:8777/convert.html
) else (
  if "%CODE%"=="0" (
    echo   服务已停止。按任意键关闭窗口。
  ) else (
    echo   [错误] 服务退出，代码 %CODE%。日志在 tools\server.log
    echo   按任意键关闭窗口。
  )
)
pause >nul
exit /b 0

:nopython
echo.
echo   [错误] 没有找到可用的 Python。
echo.
echo   你机器上的 python 命令很可能是 Microsoft Store 的占位程序，
echo   并不是真正的 Python，所以 python tools\serve.py 敲下去没反应。
echo.
echo   解决办法（二选一）：
echo     1. 到 python.org 装 Python 3.11 以上，安装时勾选 "Add python.exe to PATH"
echo     2. 装上真正的 Python 后重开这个窗口
echo.
echo   也可以直接把这个 bat 放到 beatforge 目录双击运行 —— 它会自动找 Python。
echo.
pause
exit /b 1
