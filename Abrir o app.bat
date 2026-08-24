@echo off
title Draco - app
cd /d "%~dp0"

echo.
echo   ===============================================
echo     Draco - app de desktop
echo   ===============================================
echo.
echo   O app abre o site que ja esta no ar. A diferenca
echo   dele: ao compartilhar a tela, a escolha aparece
echo   com as miniaturas aqui dentro, sem sair do app.
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

if not exist desktop\node_modules (
  echo   Primeira vez: baixando o Electron ^(uns 100 MB^), demora.
  echo.
  call npm --prefix desktop install
  if errorlevel 1 (
    echo.
    echo   A instalacao falhou. Veja a mensagem acima.
    pause
    exit /b 1
  )
)

echo.
echo   Abrindo o app. Para fechar, feche a janela dele.
echo.

call npm --prefix desktop start
