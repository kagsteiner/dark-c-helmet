# How to Build the C Chess Engine

Quick reference for building `vibechess_c.exe` when you're not often working with C.

---

## Prerequisites

- **Visual Studio 2022** (Community or other edition) with *Desktop development with C++*
- **CMake** (via `winget install Kitware.CMake` or VS Installer → C++ CMake tools)
- Both must be on your PATH **or** you use the VS developer shell (see below)

---

## Build Steps

### 1. Open the right shell

Use the **Developer PowerShell for VS 2022** (or *x64 Native Tools Command Prompt for VS 2022*):

- Press **Windows key** → type `Developer PowerShell for VS 2022` → run it

This ensures `cmake` and `cl` (MSVC) are in PATH.

### 2. Go to the project folder

```powershell
cd C:\Users\agste\OneDrive\Development\VibeEngineC
```

### 3. Build

**Option A — Use the build script**

```bat
build_c.bat
```

**Option B — Run CMake manually**

```powershell
cmake -S . -B build
cmake --build build --config Release
```

### 4. Where is the executable?

- Usually: `build\Release\vibechess_c.exe`
- Sometimes: `build\vibechess_c.exe` (if Release folder doesn't exist)

---

## Running the engine

```powershell
.\build\Release\vibechess_c.exe
```

Or double-click `darkengine_c.bat` — it builds (if needed) and then runs the engine.

---

## Quick reference

| Command | Purpose |
|--------|---------|
| `build_c.bat` | Build only (no run) |
| `darkengine_c.bat` | Build + run engine |
| `cmake -S . -B build` | Configure project |
| `cmake --build build --config Release` | Compile Release |
| `cmake --build build --target clean` | Clean build folder |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `cmake` not found | Use *Developer PowerShell for VS 2022* or add CMake bin to PATH |
| `cl` not found | Same — must use VS developer shell for MSVC |
| Build errors | Ensure *Desktop development with C++* is installed in VS Installer |
| Want a clean rebuild | Delete `build` folder, then run build steps again |
