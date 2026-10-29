@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando na primeira vez...
  call npm install --no-audit --no-fund
)
node abrir.mjs %*
if errorlevel 1 pause
