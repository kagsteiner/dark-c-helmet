@echo off
setlocal

echo Building VibeChess C engine...
if not exist build mkdir build

cmake -S . -B build
if errorlevel 1 (
  echo CMake configure failed.
  exit /b 1
)

cmake --build build --config Release
if errorlevel 1 (
  echo CMake build failed.
  exit /b 1
)

echo.
echo Build succeeded.
if exist build\Release\vibechess_c.exe (
  echo Executable: build\Release\vibechess_c.exe
) else if exist build\vibechess_c.exe (
  echo Executable: build\vibechess_c.exe
) else (
  echo Warning: Expected exe not found.
)
echo.
pause
