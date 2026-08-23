@echo off
title Discord Clone - local
cd /d "%~dp0"

echo.
echo   ===============================================
echo     Discord Clone - so nesta maquina
echo   ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js nao encontrado. Instale com:
  echo.
  echo       winget install --id OpenJS.NodeJS.LTS
  echo.
  echo   Depois feche e abra esta janela de novo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Primeira vez: instalando dependencias, demora um pouco...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   A instalacao falhou. Veja a mensagem acima.
    pause
    exit /b 1
  )
)

echo.
echo   Abra no navegador:  http://localhost:5173
echo.
echo   Para testar a call sozinho, abra o mesmo endereco numa
echo   janela anonima (Ctrl+Shift+N) com outro apelido.
echo.
echo   Para parar: feche esta janela.
echo.

call npm run dev
pause
