@echo off
rem Flatform Test: the v3 test build with its own name, app id and data folder (test-app\data), update checks off,
rem and mock Tripo, 3D AI Studio and Blender. It never touches your Flatform 0.5.0 library and never spends credits.
rem Delete test-app\data to start again from the sample library.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Flatform Test needs its packages. Run "npm install" in this folder first.
  pause
  exit /b 1
)
start "Flatform Test" "node_modules\electron\dist\electron.exe" . --flatform-test
