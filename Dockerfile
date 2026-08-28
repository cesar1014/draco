# Imagem de produção: um processo só, servindo a página e a sinalização.
FROM node:20-alpine AS build
WORKDIR /app
# O `better-sqlite3` é nativo, e no Alpine (musl) não há binário pronto pra
# baixar: sem compilador o `npm ci` falha no meio do build.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/draco.sqlite
COPY package*.json ./
# As ferramentas de compilação entram e saem na mesma camada: elas são
# necessárias pro módulo nativo e não deveriam ficar numa imagem exposta.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci --omit=dev \
  && apk del .build-deps \
  && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
# O banco fica num volume: sem isto a conversa e os perfis morrem com o contêiner.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
# Sem root: o processo não precisa de privilégio nenhum, e um contêiner exposto
# na internet rodando como root é risco de graça.
USER node
EXPOSE 8080
CMD ["node", "server/index.js"]
