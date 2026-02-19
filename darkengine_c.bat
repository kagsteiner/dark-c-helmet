@echo off
setlocal

if not exist build mkdir build
cmake -S . -B build
if errorlevel 1 exit /b 1

cmake --build build --config Release
if errorlevel 1 exit /b 1

if exist build\Release\vibechess_c.exe (
  build\Release\vibechess_c.exe
) else (
  build\vibechess_c.exe
)
