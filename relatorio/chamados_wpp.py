#!/usr/bin/env python3
"""
Contabiliza chamados de suporte a partir de conversas exportadas do WhatsApp.

Uso:
    python3 chamados_wpp.py PASTA_OU_ARQUIVOS... [--de 20/10/2026] [--ate 19/11/2026]
                            [--atendente "Nome no WhatsApp"] [--pausa 30] [--novo 4]
                            [--saida chamados.xlsx]

Aceita .txt e .zip exportados ("Exportar conversa > Sem mídia"), Android ou iPhone.

Regras:
- Chamado abre quando o cliente manda mensagem e não há chamado aberto naquela conversa.
- Chamado fecha quando:
    * atendente manda o modelo ("Solicitante/Usuário: ...") com (X) Finalizado, ou
    * a conversa fica parada mais que --novo horas (padrão 4h).
- "ok", "obrigado", "valeu" etc. logo depois de fechar não abrem chamado novo.
- Tempo gasto (opção B) = soma dos intervalos entre mensagens seguidas do chamado,
  descartando intervalos maiores que --pausa minutos (padrão 30).
- Também calcula o tempo corrido (1ª msg até última) e o tempo de 1ª resposta, só para referência.
"""
import argparse
import io
import os
import re
import sys
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, date

# ---------------------------------------------------------------- parsing

# Android: 20/10/2026 09:15 - Nome: msg   |   20/10/2026, 09:15 - Nome: msg
RE_ANDROID = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[aApP]\.?\s?[mM]\.?)?\s+-\s+(.*)$"
)
# iPhone: [20/10/2026, 09:15:32] Nome: msg
RE_IOS = re.compile(
    r"^\[(\d{1,2}/\d{1,2}/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[aApP]\.?\s?[mM]\.?)?\]\s+(.*)$"
)
INVISIVEIS = dict.fromkeys(map(ord, "‎‏‪‬﻿"), None)


@dataclass
class Msg:
    ts: datetime
    autor: str
    texto: str


def _dt(d, h):
    dia, mes, ano = d.split("/")
    ano = int(ano)
    if ano < 100:
        ano += 2000
    partes = [int(x) for x in h.split(":")]
    seg = partes[2] if len(partes) > 2 else 0
    return datetime(ano, int(mes), int(dia), partes[0], partes[1], seg)


def parse_texto(conteudo):
    msgs = []
    for linha in conteudo.splitlines():
        linha = linha.translate(INVISIVEIS)
        m = RE_IOS.match(linha) or RE_ANDROID.match(linha)
        if m:
            d, h, resto = m.groups()
            if ": " in resto:
                autor, texto = resto.split(": ", 1)
            else:  # mensagem de sistema (criptografia, entrou no grupo etc.)
                continue
            try:
                msgs.append(Msg(_dt(d, h), autor.strip(), texto))
            except ValueError:
                continue
        elif msgs:
            msgs[-1].texto += "\n" + linha
    return msgs


def nome_conversa(nome_arquivo):
    base = os.path.splitext(os.path.basename(nome_arquivo))[0]
    for pref in ("Conversa do WhatsApp com ", "WhatsApp Chat with ", "WhatsApp Chat - ", "_chat"):
        if base.startswith(pref):
            base = base[len(pref):]
    return base.strip(" -_") or nome_arquivo


def carregar(caminhos):
    """Retorna lista de (nome_conversa, [Msg])."""
    conversas = []

    def add(nome, conteudo_bytes):
        txt = conteudo_bytes.decode("utf-8", errors="replace")
        msgs = parse_texto(txt)
        if msgs:
            conversas.append((nome, msgs))

    arquivos = []
    for c in caminhos:
        if os.path.isdir(c):
            for raiz, _, fs in os.walk(c):
                arquivos += [os.path.join(raiz, f) for f in sorted(fs)]
        else:
            arquivos.append(c)

    for a in arquivos:
        low = a.lower()
        if low.endswith(".zip"):
            with zipfile.ZipFile(a) as z:
                for n in z.namelist():
                    if n.lower().endswith(".txt"):
                        nome = nome_conversa(a if os.path.basename(n) == "_chat.txt" else n)
                        add(nome, z.read(n))
        elif low.endswith(".txt"):
            with open(a, "rb") as f:
                add(nome_conversa(a), f.read())
    return conversas


# ---------------------------------------------------------------- modelo de chamado

RE_MODELO = re.compile(r"solicitante\s*/\s*usu[aá]rio\s*:", re.I)


def ler_modelo(texto):
    """Extrai os campos do modelo, se a mensagem for o modelo."""
    if not RE_MODELO.search(texto):
        return None
    campos = {}
    chaves = {
        "solicitante": r"solicitante\s*/\s*usu[aá]rio",
        "problema": r"solicita[cç][aã]o\s*/\s*problema",
        "modulo": r"m[oó]dulo",
        "atividade": r"atividade\s+realizada",
        "obs": r"obs",
    }
    for k, rx in chaves.items():
        m = re.search(rx + r"\s*:\s*(.*?)(?=\n\s*\n|\n\s*\w[\w\s/]*:|\Z)", texto, re.I | re.S)
        campos[k] = m.group(1).strip() if m else ""
    st = re.search(r"status\s*:(.*)", texto, re.I)
    status = ""
    if st:
        s = st.group(1).lower()
        if re.search(r"\(\s*x\s*\)\s*finaliz", s):
            status = "Finalizado"
        elif re.search(r"\(\s*x\s*\)\s*em\s+andamento", s):
            status = "Em andamento"
    campos["status"] = status
    return campos


RE_AGRADECE = re.compile(
    r"^\W*(ok+|okay|blz|beleza|obrigad[oa]s?|obg|vlw|valeu|show|perfeito|top|certo|"
    r"combinado|joia|jóia|tmj|👍|🙏|bom dia|boa tarde|boa noite)[\s\W]*$", re.I
)


@dataclass
class Chamado:
    conversa: str
    cliente: str
    msgs: list = field(default_factory=list)
    modelo: dict = None
    fechado_por: str = ""

    @property
    def inicio(self):
        return self.msgs[0].ts

    @property
    def fim(self):
        return self.msgs[-1].ts


def segmentar(nome, msgs, atendentes, pausa, novo):
    """Quebra uma conversa em chamados."""
    clientes = Counter(m.autor for m in msgs if m.autor not in atendentes)
    cliente_padrao = clientes.most_common(1)[0][0] if clientes else nome
    chamados, atual, ultimo_fechado = [], None, None

    def fechar(motivo):
        nonlocal atual, ultimo_fechado
        if atual and atual.msgs:
            atual.fechado_por = motivo
            chamados.append(atual)
            ultimo_fechado = atual
        atual = None

    for m in msgs:
        e_nosso = m.autor in atendentes
        modelo = ler_modelo(m.texto) if e_nosso else None

        if atual and (m.ts - atual.fim) > timedelta(hours=novo):
            fechar("inatividade")

        if atual is None:
            if modelo:
                # modelo sem conversa antes: anexa ao último chamado se for recente, senão cria um
                if ultimo_fechado and ultimo_fechado.modelo is None and \
                        (m.ts - ultimo_fechado.fim) <= timedelta(hours=novo * 3):
                    ultimo_fechado.modelo = modelo
                    ultimo_fechado.fechado_por = "modelo"
                    continue
                atual = Chamado(nome, cliente_padrao)
            elif e_nosso:
                continue  # mensagem nossa solta (aviso, cobrança) não abre chamado
            else:
                recente = ultimo_fechado and (m.ts - ultimo_fechado.fim) <= timedelta(hours=novo)
                if recente and RE_AGRADECE.match(m.texto.strip()):
                    continue  # "obrigado" depois de fechar
                atual = Chamado(nome, m.autor)

        atual.msgs.append(m)
        if modelo:
            atual.modelo = modelo
            if modelo.get("status") != "Em andamento":
                fechar("modelo")
    fechar("fim do arquivo")
    return chamados


def tempo_ativo(chamado, pausa):
    total = timedelta()
    for a, b in zip(chamado.msgs, chamado.msgs[1:]):
        d = b.ts - a.ts
        if d <= timedelta(minutes=pausa):
            total += d
    return total


def primeira_resposta(chamado, atendentes):
    cli = next((m for m in chamado.msgs if m.autor not in atendentes), None)
    if not cli:
        return None
    resp = next((m for m in chamado.msgs if m.autor in atendentes and m.ts >= cli.ts), None)
    return (resp.ts - cli.ts) if resp else None


# ---------------------------------------------------------------- atendentes

def detectar_atendentes(conversas):
    """Quem manda o modelo, ou quem aparece em quase todas as conversas, é atendente."""
    por_modelo = Counter()
    presenca = Counter()
    for _, msgs in conversas:
        for a in {m.autor for m in msgs}:
            presenca[a] += 1
        for m in msgs:
            if RE_MODELO.search(m.texto):
                por_modelo[m.autor] += 1
    if por_modelo:
        return set(por_modelo)
    if len(conversas) >= 2:
        corte = max(2, int(len(conversas) * 0.6))
        return {a for a, n in presenca.items() if n >= corte}
    return set()


# ---------------------------------------------------------------- saída

def hhmm(td):
    if td is None:
        return ""
    s = int(td.total_seconds())
    return f"{s // 3600}:{(s % 3600) // 60:02d}"


def horas(td):
    return round(td.total_seconds() / 3600, 2) if td is not None else None


def gerar_xlsx(linhas, params, caminho):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    neg = Font(bold=True)
    cab = PatternFill("solid", fgColor="DDE5F0")

    def tabela(ws, cabecalho, dados, larguras=None):
        ws.append(cabecalho)
        for c in ws[ws.max_row]:
            c.font, c.fill = neg, cab
        for d in dados:
            ws.append(d)
        for i, w in enumerate(larguras or [], 1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = ws.cell(row=2, column=1)

    # Resumo
    ws = wb.active
    ws.title = "Resumo"
    tot_h = sum(l["ativo_h"] for l in linhas)
    ws.append([f"Chamados de {params['de']:%d/%m/%Y} a {params['ate']:%d/%m/%Y}"])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([])
    ws.append(["Total de chamados", len(linhas)])
    ws.append(["Horas de atendimento (ativo)", round(tot_h, 2)])
    ws.append(["Média por chamado (h)", round(tot_h / len(linhas), 2) if linhas else 0])
    ws.append(["Com modelo preenchido", sum(1 for l in linhas if l["modelo"])])
    for r in range(3, 7):
        ws.cell(row=r, column=1).font = neg
    ws.column_dimensions["A"].width = 32
    ws.column_dimensions["B"].width = 14

    def agrupa(chave):
        g = defaultdict(lambda: [0, 0.0])
        for l in linhas:
            g[l[chave] or "(sem)"][0] += 1
            g[l[chave] or "(sem)"][1] += l["ativo_h"]
        return sorted(g.items(), key=lambda x: -x[1][1])

    ws2 = wb.create_sheet("Por cliente")
    tabela(ws2, ["Cliente", "Chamados", "Horas"],
           [[k, v[0], round(v[1], 2)] for k, v in agrupa("cliente")], [40, 12, 10])
    ws3 = wb.create_sheet("Por módulo")
    tabela(ws3, ["Módulo", "Chamados", "Horas"],
           [[k, v[0], round(v[1], 2)] for k, v in agrupa("modulo")], [30, 12, 10])
    ws4 = wb.create_sheet("Por dia")
    pd = defaultdict(lambda: [0, 0.0])
    for l in linhas:
        pd[l["inicio"].date()][0] += 1
        pd[l["inicio"].date()][1] += l["ativo_h"]
    tabela(ws4, ["Dia", "Chamados", "Horas"],
           [[k, v[0], round(v[1], 2)] for k, v in sorted(pd.items())], [12, 12, 10])
    for row in ws4.iter_rows(min_row=2, max_col=1):
        row[0].number_format = "DD/MM/YYYY"

    ws5 = wb.create_sheet("Chamados")
    cab5 = ["#", "Cliente (contato)", "Solicitante (modelo)", "Início", "Fim", "Msgs", "Tempo ativo (h)",
            "Tempo ativo", "Tempo corrido", "1ª resposta", "Módulo", "Solicitação/Problema",
            "Atividade realizada", "Status", "Fechado por", "1ª mensagem do cliente"]
    dados = []
    for i, l in enumerate(linhas, 1):
        dados.append([i, l["cliente"], l["solicitante"], l["inicio"], l["fim"], l["n"],
                      l["ativo_h"], l["ativo"], l["corrido"], l["resp"], l["modulo"],
                      l["problema"], l["atividade"], l["status"], l["fechado_por"], l["primeira"]])
    tabela(ws5, cab5, dados, [5, 26, 24, 16, 16, 6, 10, 10, 10, 10, 16, 40, 40, 13, 13, 50])
    for row in ws5.iter_rows(min_row=2):
        row[3].number_format = row[4].number_format = "DD/MM/YYYY HH:MM"
        for c in (row[11], row[12], row[15]):
            c.alignment = Alignment(wrap_text=False)

    ws6 = wb.create_sheet("Parâmetros")
    for k, v in [("Período", f"{params['de']:%d/%m/%Y} a {params['ate']:%d/%m/%Y}"),
                 ("Atendentes considerados", ", ".join(sorted(params["atendentes"]))),
                 ("Pausa máxima contada (min)", params["pausa"]),
                 ("Inatividade que fecha chamado (h)", params["novo"]),
                 ("Conversas lidas", params["n_conversas"]),
                 ("Regra do tempo", "Soma dos intervalos entre mensagens seguidas, "
                                    "ignorando intervalos acima da pausa máxima.")]:
        ws6.append([k, v])
    ws6.column_dimensions["A"].width = 34
    ws6.column_dimensions["B"].width = 80
    wb.save(caminho)


# ---------------------------------------------------------------- main

def periodo_padrao(hoje=None):
    hoje = hoje or date.today()
    mes, ano = (hoje.month - 1, hoje.year) if hoje.month > 1 else (12, hoje.year - 1)
    return date(ano, mes, 20), hoje


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("entradas", nargs="+", help="pasta(s), .txt ou .zip exportados")
    ap.add_argument("--de", help="dd/mm/aaaa (padrão: dia 20 do mês passado)")
    ap.add_argument("--ate", help="dd/mm/aaaa (padrão: hoje)")
    ap.add_argument("--atendente", action="append", default=[],
                    help="nome que aparece para vocês na exportação (pode repetir)")
    ap.add_argument("--pausa", type=int, default=30, help="minutos; intervalos maiores não contam")
    ap.add_argument("--novo", type=float, default=4, help="horas parado que fecham o chamado")
    ap.add_argument("--saida", default="chamados.xlsx")
    a = ap.parse_args()

    de, ate = periodo_padrao()
    if a.de:
        de = datetime.strptime(a.de, "%d/%m/%Y").date()
    if a.ate:
        ate = datetime.strptime(a.ate, "%d/%m/%Y").date()
    ini, fim = datetime.combine(de, datetime.min.time()), datetime.combine(ate, datetime.max.time())

    conversas = carregar(a.entradas)
    if not conversas:
        sys.exit("Nenhuma conversa encontrada nos arquivos informados.")
    atendentes = set(a.atendente) or detectar_atendentes(conversas)
    if not atendentes:
        autores = Counter(m.autor for _, ms in conversas for m in ms)
        sys.exit("Não consegui identificar quem são vocês. Rode de novo com --atendente \"Nome\".\n"
                 "Nomes encontrados: " + ", ".join(n for n, _ in autores.most_common(10)))

    linhas = []
    for nome, msgs in conversas:
        # corta um pouco antes do início para não pegar chamado pela metade
        msgs = [m for m in msgs if ini - timedelta(hours=a.novo) <= m.ts <= fim]
        for c in segmentar(nome, msgs, atendentes, a.pausa, a.novo):
            if c.inicio < ini:
                continue
            md = c.modelo or {}
            cli_msg = next((m.texto for m in c.msgs if m.autor not in atendentes), "")
            ativo = tempo_ativo(c, a.pausa)
            linhas.append(dict(
                conversa=nome, cliente=nome, solicitante=md.get("solicitante", ""),
                inicio=c.inicio, fim=c.fim, n=len(c.msgs),
                ativo_h=horas(ativo), ativo=hhmm(ativo), corrido=hhmm(c.fim - c.inicio),
                resp=hhmm(primeira_resposta(c, atendentes)),
                modulo=md.get("modulo", ""), problema=md.get("problema", ""),
                atividade=md.get("atividade", ""), status=md.get("status", ""),
                fechado_por=c.fechado_por, modelo=bool(c.modelo),
                primeira=cli_msg.replace("\n", " ")[:200],
            ))
    linhas.sort(key=lambda l: l["inicio"])

    params = dict(de=de, ate=ate, atendentes=atendentes, pausa=a.pausa, novo=a.novo,
                  n_conversas=len(conversas))
    gerar_xlsx(linhas, params, a.saida)

    tot = sum(l["ativo_h"] for l in linhas)
    print(f"Período: {de:%d/%m/%Y} a {ate:%d/%m/%Y}")
    print(f"Atendentes: {', '.join(sorted(atendentes))}")
    print(f"Conversas lidas: {len(conversas)}")
    print(f"Chamados: {len(linhas)}  |  Horas (ativo): {tot:.2f}  |  "
          f"com modelo: {sum(1 for l in linhas if l['modelo'])}")
    print(f"Planilha: {a.saida}")


if __name__ == "__main__":
    main()
