# Servidor de updown-footprint (monorepo). Contexto de build: RAIZ del repo
#   docker build -f apps/server/Dockerfile .
# Corre con tsx igual que en local, porque @updown/protocol se consume como TypeScript fuente.
# Node 24: trae node:sqlite sin flags (la base de markets). Guia: docs/guides/deployment.md
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# 1) Solo manifiestos: la capa de dependencias se reutiliza mientras no cambie el lockfile.
#    apps/web/package.json se copia solo para que npm ci reconozca el workspace del lockfile; no se instala.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
# incluye devDependencies del servidor: tsx es el runtime
RUN npm ci --workspace @updown/server --include=dev --no-audit --no-fund

# 2) Codigo
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/server apps/server

WORKDIR /app/apps/server
# La base vive en el volumen montado en /data (ver PM_DB_PATH en la guia)
ENV PM_DB_PATH=/data/polymarket.db
EXPOSE 4000
# node directo (sin npm) para que SIGTERM llegue al proceso y la base se cierre limpia
CMD ["node", "--import", "tsx", "src/index.ts"]
