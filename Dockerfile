FROM node:22-slim

# git: a Baileys baixa uma dependência do GitHub | tzdata: fuso | python3 + openpyxl: planilha do relatório
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tzdata python3 python3-openpyxl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    AUTH_DIR=/app/estado/auth \
    DATA_DIR=/app/estado/data

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY relatorio ./relatorio

CMD ["node", "src/index.js"]
