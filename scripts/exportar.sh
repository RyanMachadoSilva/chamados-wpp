#!/bin/bash
# Copia as conversas salvas e os relatórios do container para ~/chamados-export na VPS.
#   bash scripts/exportar.sh
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf ~/chamados-export && mkdir -p ~/chamados-export
docker compose cp chamados:/app/estado/data/conversas ~/chamados-export/
docker compose cp chamados:/app/estado/data/relatorios ~/chamados-export/
echo "Copiado para ~/chamados-export"
