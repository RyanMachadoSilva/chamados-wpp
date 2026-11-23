# chamados-wpp

Bot que conecta no WhatsApp do suporte (só leitura), guarda as conversas individuais e gera o relatório de chamados e horas de atendimento.

## Como funciona

- Ao parear pelo QR code, o celular manda o histórico das conversas e o bot grava tudo.
- Depois ele continua gravando as mensagens novas, 24h.
- **Ele nunca responde clientes.** Só escreve para o número pessoal configurado em `RELATORIO_PARA` (ou na conversa "Você" do suporte, se não configurado).

## Pedir o relatório

Do seu WhatsApp pessoal (`RELATORIO_PARA`), mande para o número do suporte, ou mande na conversa "Você" do próprio suporte:

| Mensagem | Período |
|---|---|
| `/relatorio` | dia 20 do mês passado até hoje |
| `/relatorio 20/10 19/11` | período escolhido (ano atual) |
| `/relatorio 20/10/2026 19/11/2026` | com ano |

O bot manda o resumo e a planilha (.xlsx) no seu pessoal. As mensagens entre o pessoal e o suporte não contam como chamado.

## Regras da contagem

- Toda mensagem de cliente abre chamado, se não houver um aberto na conversa.
- Fecha quando vocês mandam o modelo com **(X) Finalizado**, ou após `NOVO_HORAS` (4h) parado.
- "ok", "obrigado" etc. logo depois de fechar não abrem chamado.
- **Tempo gasto** = soma dos intervalos entre mensagens seguidas, ignorando intervalos maiores que `PAUSA_MIN` (30 min).

## Instalação na VPS

```bash
cd ~ && git clone https://github.com/RyanMachadoSilva/chamados-wpp.git
cd chamados-wpp
cp .env.example .env && nano .env      # coloque o seu número pessoal em RELATORIO_PARA
docker compose up -d --build && docker compose logs -f
```
Escaneie o QR com o celular **do número de suporte**. Quando aparecer `✅ Conectado`, acompanhe as linhas `[histórico]` e depois saia com Ctrl+C (o bot continua rodando).

## Comandos úteis

| O quê | Comando |
|---|---|
| Ver o log | `docker compose logs -f` |
| Copiar conversas e relatórios para a VPS | `bash scripts/exportar.sh` |
| Gerar relatório pelo terminal | `docker compose exec chamados python3 relatorio/chamados_wpp.py /app/estado/data/conversas --de 20/10/2026 --atendente Suporte --saida /app/estado/data/relatorios/manual.xlsx` |
| Atualizar | automático pelo GitHub Actions, ou `bash scripts/deploy.sh` |

## Deploy automático

Todo push na `main` dispara `.github/workflows/deploy.yml`, que entra na VPS e roda `scripts/deploy.sh`. Usa os secrets `VPS_HOST`, `VPS_USER` e `VPS_SSH_KEY` (chave própria deste repositório, restrita na VPS a rodar só o deploy). Sem os secrets, o workflow apenas pula o deploy.
