@echo off
title Discord Clone - aberto pros amigos
cd /d "%~dp0"

echo.
echo   ===============================================
echo     Discord Clone - abrindo pra internet
echo   ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js nao encontrado. Instale com:
  echo.
  echo       winget install --id OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo   cloudflared nao encontrado. E ele que cria o link https.
  echo   Instale com:
  echo.
  echo       winget install --id Cloudflare.cloudflared
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

if not exist .env (
  echo   AVISO: sem arquivo .env, a sala fica SEM SENHA.
  echo   Qualquer pessoa com o link entra na sua call.
  echo.
  echo   Para por senha: copie .env.example para .env e
  echo   preencha ROOM_PASSWORD. Depois rode isto de novo.
  echo.
  timeout /t 6 /nobreak >nul
)

echo   Gerando a versao de producao...
echo.
call npm run build
if errorlevel 1 (
  echo.
  echo   O build falhou. Veja a mensagem acima.
  pause
  exit /b 1
)

echo.
echo   ===============================================
echo     Procure abaixo a linha com
echo         https://alguma-coisa.trycloudflare.com
echo     Esse e o link que voce manda pros amigos.
echo   ===============================================
echo.
echo   Enquanto esta janela estiver aberta, o link funciona.
echo   Se fechar, o link morre - e o proximo sera diferente.
echo.

call npm run share
pause
