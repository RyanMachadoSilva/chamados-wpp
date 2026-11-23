// Bot de chamados: conecta no WhatsApp do suporte (só leitura), guarda as conversas
// individuais e gera o relatório de chamados quando pedido.
//
// - Ao parear, recebe o histórico sincronizado do celular e grava tudo.
// - Depois continua gravando as mensagens novas.
// - Na conversa "Você" (mensagem para si mesmo) do número de suporte, mande:
//       /relatorio                 -> do dia 20 do mês passado até hoje
//       /relatorio 20/10 19/11     -> período escolhido (ano atual se omitido)
//   O comando também pode ser mandado do número pessoal (RELATORIO_PARA) para o suporte.
//   O resumo e a planilha vão para o número pessoal (ou para a própria conversa, se não configurado).
// O bot NUNCA responde clientes: só escreve para o número pessoal ou na conversa consigo mesmo.
import 'dotenv/config';
import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

process.env.TZ ||= 'America/Sao_Paulo';

// esconde o ruído da biblioteca de criptografia do WhatsApp ("Closing session: SessionEntry {...}")
for (const nivel of ['log', 'info', 'warn']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    const t = typeof args[0] === 'string' ? args[0] : '';
    if (/^(Closing session|Closing open session|Removing old closed session|Session already closed|Decrypted message with closed session|Migrating session)/.test(t)) return;
    original(...args);
  };
}

const makeWASocket = baileys.makeWASocket ?? baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

const AUTH_DIR = process.env.AUTH_DIR || 'estado/auth';
const DATA_DIR = process.env.DATA_DIR || 'estado/data';
const CONVERSAS_DIR = path.join(DATA_DIR, 'conversas');
const RELATORIOS_DIR = path.join(DATA_DIR, 'relatorios');
const ARQ_MSGS = path.join(DATA_DIR, 'mensagens.jsonl');
const ARQ_NOMES = path.join(DATA_DIR, 'nomes.json');       // legado
const ARQ_CONTATOS = path.join(DATA_DIR, 'contatos.json');
const ARQ_ETIQUETAS = path.join(DATA_DIR, 'etiquetas.json');
const NOME_ATENDENTE = process.env.NOME_ATENDENTE || 'Suporte';
const GUARDAR_DESDE = process.env.GUARDAR_DESDE || ''; // dd/mm/aaaa opcional
const PAUSA_MIN = process.env.PAUSA_MIN || '30';
const NOVO_HORAS = process.env.NOVO_HORAS || '4';
const RELATORIO_PARA = (process.env.RELATORIO_PARA || '').replace(/\D/g, ''); // ex.: 5534999999999

fs.mkdirSync(CONVERSAS_DIR, { recursive: true });
fs.mkdirSync(RELATORIOS_DIR, { recursive: true });

// ---------- armazenamento ----------
const conversas = new Map(); // jid -> Map(id -> {ts, fromMe, texto})
// contatos[jid] = { agenda, wpp, empresa, pn, etiquetas: [ids] }
let contatos = {};
let etiquetas = {}; // id -> nome
try { contatos = JSON.parse(fs.readFileSync(ARQ_CONTATOS, 'utf8')); } catch {}
try { etiquetas = JSON.parse(fs.readFileSync(ARQ_ETIQUETAS, 'utf8')); } catch {}
try { // migra nomes.json antigo
  for (const [jid, n] of Object.entries(JSON.parse(fs.readFileSync(ARQ_NOMES, 'utf8')))) {
    contatos[jid] ||= {};
    contatos[jid].antigo ||= n;
  }
} catch {}
const ct = (jid) => (contatos[jid] ||= {});
const soNumero = (jid) => String(jid || '').split('@')[0].split(':')[0];
function definir(jid, campo, valor) {
  if (!jid || !valor || ct(jid)[campo] === valor) return;
  ct(jid)[campo] = valor;
  pendenteGravar = true;
}
// liga um @lid ao telefone real (e vice-versa)
function ligarPn(jid, outro) {
  if (!jid || !outro || jid === outro) return;
  if (outro.endsWith('@s.whatsapp.net')) definir(jid, 'pn', soNumero(outro));
  if (jid.endsWith('@s.whatsapp.net') && outro.endsWith('@lid')) definir(outro, 'pn', soNumero(jid));
}
function registrarContato(c) {
  const jid = c.id;
  if (!individual(jid)) return;
  definir(jid, 'agenda', c.name);
  definir(jid, 'wpp', c.notify);
  definir(jid, 'empresa', c.verifiedName);
  if (jid.endsWith('@s.whatsapp.net')) definir(jid, 'pn', soNumero(jid));
  ligarPn(jid, c.phoneNumber || c.jid);
  ligarPn(jid, c.lid);
}

const limiteInicio = (() => {
  if (!GUARDAR_DESDE) return 0;
  const [d, m, a] = GUARDAR_DESDE.split('/').map(Number);
  return new Date(a, m - 1, d).getTime() / 1000;
})();

function carregarSalvas() {
  if (!fs.existsSync(ARQ_MSGS)) return;
  for (const linha of fs.readFileSync(ARQ_MSGS, 'utf8').split('\n')) {
    if (!linha) continue;
    try {
      const r = JSON.parse(linha);
      if (!conversas.has(r.jid)) conversas.set(r.jid, new Map());
      conversas.get(r.jid).set(r.id, { ts: r.ts, fromMe: r.fromMe, texto: r.texto });
    } catch {}
  }
  const total = [...conversas.values()].reduce((s, m) => s + m.size, 0);
  console.log(`Carregadas ${total} mensagens de ${conversas.size} conversas já salvas.`);
}

const individual = (jid) => !!jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));

function textoDe(m) {
  const c = m.message || {};
  const msg = c.ephemeralMessage?.message || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message
    || c.documentWithCaptionMessage?.message || c.editedMessage?.message || c;
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || (msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.documentMessage || msg.stickerMessage
      ? '<Mídia oculta>' : null);
}

let pendenteGravar = false;
const buffer = [];

function guardar(m) {
  const jid = m.key?.remoteJid;
  if (!individual(jid) || ehMinhaConversa(jid) || ehPessoal(m)) return;
  const ts = Number(m.messageTimestamp || 0);
  if (!ts || ts < limiteInicio) return;
  const texto = textoDe(m);
  if (!texto) return;
  const fromMe = !!m.key.fromMe;
  if (jid.endsWith('@s.whatsapp.net')) definir(jid, 'pn', soNumero(jid));
  ligarPn(jid, m.key.remoteJidAlt || m.key.senderPn);
  if (!fromMe) {
    definir(jid, 'wpp', m.pushName);
    definir(jid, 'empresa', m.verifiedBizName);
  }
  if (!conversas.has(jid)) conversas.set(jid, new Map());
  const mapa = conversas.get(jid);
  if (mapa.has(m.key.id)) return;
  mapa.set(m.key.id, { ts, fromMe, texto });
  buffer.push(JSON.stringify({ jid, id: m.key.id, ts, fromMe, texto }));
  pendenteGravar = true;
}

const fmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: process.env.TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const quando = (ts) => fmt.format(new Date(ts * 1000)).replace(',', '');
const fmtTel = (n) => (n && /^55\d{10,11}$/.test(n)
  ? `+55 ${n.slice(2, 4)} ${n.slice(4, -4)}-${n.slice(-4)}` : n ? `+${n}` : '');
function nomeLegivel(jid) {
  const c = contatos[jid] || {};
  return c.agenda || c.wpp || c.empresa || c.antigo || fmtTel(c.pn) || soNumero(jid);
}
const nomeDe = (jid) => String(nomeLegivel(jid)).replace(/[\\/:*?"<>|\n]/g, '_').trim();
const etiquetasDe = (jid) => (contatos[jid]?.etiquetas || []).map((id) => etiquetas[id]).filter(Boolean);

function gravar() {
  if (!pendenteGravar) return;
  pendenteGravar = false;
  if (buffer.length) fs.appendFileSync(ARQ_MSGS, buffer.splice(0).join('\n') + '\n');
  fs.writeFileSync(ARQ_CONTATOS, JSON.stringify(contatos, null, 1));
  fs.writeFileSync(ARQ_ETIQUETAS, JSON.stringify(etiquetas, null, 1));
  // reescreve os .txt no formato da exportação do WhatsApp (Android)
  for (const f of fs.readdirSync(CONVERSAS_DIR)) fs.unlinkSync(path.join(CONVERSAS_DIR, f));
  const usados = new Set();
  for (const [jid, msgs] of conversas) {
    let nome = nomeDe(jid);
    if (usados.has(nome)) nome = `${nome} (${jid.split('@')[0]})`;
    usados.add(nome);
    const linhas = [...msgs.values()].sort((a, b) => a.ts - b.ts)
      .map((x) => `${quando(x.ts)} - ${x.fromMe ? NOME_ATENDENTE : nome}: ${x.texto}`);
    fs.writeFileSync(path.join(CONVERSAS_DIR, `Conversa do WhatsApp com ${nome}.txt`), linhas.join('\n') + '\n');
  }
}
setInterval(gravar, 5000);

// ---------- conversa consigo mesmo (comandos) ----------
let sock;
const numero = (jid) => String(jid || '').split('@')[0].split(':')[0];
function ehMinhaConversa(jid) {
  if (!sock?.user) return false;
  const meus = [sock.user.id, sock.user.lid].filter(Boolean).map(numero);
  return meus.includes(numero(jid));
}

// número pessoal: aceita com e sem o 9 extra (contas antigas do Brasil não têm o 9 no WhatsApp)
const variantes = (n) => {
  const v = new Set([n]);
  if (/^55\d{2}9\d{8}$/.test(n)) v.add(n.slice(0, 4) + n.slice(5));
  if (/^55\d{2}\d{8}$/.test(n)) v.add(n.slice(0, 4) + '9' + n.slice(4));
  return v;
};
const NUMEROS_PESSOAL = RELATORIO_PARA ? variantes(RELATORIO_PARA) : new Set();
let lidPessoal = null;
function ehPessoal(m) {
  if (!NUMEROS_PESSOAL.size) return false;
  const k = m.key || {};
  return [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participant, k.participantAlt]
    .filter(Boolean).some((j) => NUMEROS_PESSOAL.has(numero(j)) || (lidPessoal && j === lidPessoal));
}

let jidPessoalCache = null;
async function jidPessoal() {
  if (jidPessoalCache) return jidPessoalCache;
  try {
    const [r] = await sock.onWhatsApp(RELATORIO_PARA);
    if (r?.exists && r.jid) jidPessoalCache = r.jid;
    if (r?.lid) lidPessoal = r.lid;
  } catch {}
  return jidPessoalCache || `${RELATORIO_PARA}@s.whatsapp.net`;
}

// Interpreta o período do comando /relatorio. Exemplos:
//   (vazio) -> dia 20 do mês passado até hoje      hoje | ontem
//   semana  -> últimos 7 dias                       mes | mês -> mês atual
//   mes passado                                     outubro | outubro 2025
//   20/10   -> de 20/10 até hoje                    20/10 19/11 | 20/10 a 19/11 | 20/10/2026 até 19/11/2026
const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro'];
function periodo(args) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const f = (d) => d.toLocaleDateString('pt-BR');
  const dia = (a, m, d) => new Date(a, m, d);
  const txt = args.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  const datas = txt.match(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g) || [];
  if (datas.length) {
    const parse = (x) => {
      const [d, m, a] = x.split('/').map(Number);
      return dia(a ? (a < 100 ? 2000 + a : a) : ano, m - 1, d);
    };
    let de = parse(datas[0]);
    const ate = datas[1] ? parse(datas[1]) : hoje;
    if (!datas[0].split('/')[2] && de > ate) de = dia(de.getFullYear() - 1, de.getMonth(), de.getDate());
    return [f(de), f(ate)];
  }
  if (!txt) return [f(dia(ano, hoje.getMonth() - 1, 20)), f(hoje)];
  if (txt === 'hoje') return [f(hoje), f(hoje)];
  if (txt === 'ontem') { const o = dia(ano, hoje.getMonth(), hoje.getDate() - 1); return [f(o), f(o)]; }
  if (txt === 'semana') return [f(dia(ano, hoje.getMonth(), hoje.getDate() - 6)), f(hoje)];
  if (txt === 'mes') return [f(dia(ano, hoje.getMonth(), 1)), f(hoje)];
  if (txt === 'mes passado') return [f(dia(ano, hoje.getMonth() - 1, 1)), f(dia(ano, hoje.getMonth(), 0))];
  const im = MESES.findIndex((m) => txt.startsWith(m));
  if (im >= 0) {
    const aInf = Number((txt.match(/\d{4}/) || [])[0]);
    const a = aInf || (im > hoje.getMonth() ? ano - 1 : ano);
    const ultimo = dia(a, im + 1, 0);
    return [f(dia(a, im, 1)), f(ultimo > hoje ? hoje : ultimo)];
  }
  return null;
}

function gerarRelatorio(de, ate) {
  gravar();
  const saida = path.join(RELATORIOS_DIR, `chamados_${de.replaceAll('/', '-')}_a_${ate.replaceAll('/', '-')}.xlsx`);
  const args = ['relatorio/chamados_wpp.py', CONVERSAS_DIR, '--de', de, '--ate', ate,
    '--atendente', NOME_ATENDENTE, '--pausa', PAUSA_MIN, '--novo', NOVO_HORAS, '--saida', saida];
  return new Promise((ok, erro) => execFile('python3', args, { timeout: 120_000 }, (e, stdout, stderr) =>
    e ? erro(new Error(stderr || e.message)) : ok({ saida, resumo: stdout.trim().split('\n').filter((l) => !l.startsWith('Planilha:')).join('\n') })));
}

// ---------- exportação para análise ----------
const paraData = (s, fimDoDia) => {
  const [d, m, a] = s.split('/').map(Number);
  return (fimDoDia ? new Date(a, m - 1, d, 23, 59, 59) : new Date(a, m - 1, d)).getTime() / 1000;
};

// tenta descobrir o telefone real de quem só aparece como @lid
async function resolverLids() {
  const lm = sock?.signalRepository?.lidMapping;
  if (!lm?.getPNForLID) return;
  for (const jid of conversas.keys()) {
    if (!jid.endsWith('@lid') || contatos[jid]?.pn) continue;
    try { ligarPn(jid, await lm.getPNForLID(jid)); } catch {}
  }
}

async function exportarConversas(de, ate) {
  await resolverLids();
  gravar();
  const ini = paraData(de), fim = paraData(ate, true);
  // junta a mesma pessoa que aparece como @lid e como telefone
  const grupos = new Map();
  for (const [jid, msgs] of conversas) {
    const chave = contatos[jid]?.pn || soNumero(jid);
    if (!grupos.has(chave)) grupos.set(chave, { jids: [], msgs: [] });
    const g = grupos.get(chave);
    g.jids.push(jid);
    for (const x of msgs.values()) if (x.ts >= ini && x.ts <= fim) g.msgs.push(x);
  }
  const blocos = [];
  let totalMsgs = 0;
  for (const [chave, g] of grupos) {
    if (!g.msgs.length) continue;
    g.msgs.sort((a, b) => a.ts - b.ts);
    totalMsgs += g.msgs.length;
    const junta = (campo) => [...new Set(g.jids.map((j) => contatos[j]?.[campo]).filter(Boolean))].join(' / ');
    const tags = [...new Set(g.jids.flatMap(etiquetasDe))];
    const nome = g.jids.map(nomeLegivel).find((n) => !/^\+?\d[\d\s-]+$/.test(n)) || nomeLegivel(g.jids[0]);
    const tel = fmtTel(junta('pn').split(' / ')[0]) || '(desconhecido)';
    const cab = [
      '='.repeat(70),
      `CONVERSA: ${nome}`,
      `Nome na agenda: ${junta('agenda') || '-'}`,
      `Nome no WhatsApp: ${junta('wpp') || '-'}`,
      ...(junta('empresa') ? [`Empresa (WhatsApp Business): ${junta('empresa')}`] : []),
      `Telefone: ${tel}`,
      `Etiquetas: ${tags.join(', ') || '-'}`,
      `Mensagens no período: ${g.msgs.length}`,
      '='.repeat(70),
    ];
    const linhas = g.msgs.map((x) => `${quando(x.ts)} - ${x.fromMe ? NOME_ATENDENTE : 'Cliente'}: ${x.texto}`);
    blocos.push({ primeira: g.msgs[0].ts, texto: [...cab, ...linhas, ''].join('\n') });
  }
  blocos.sort((a, b) => a.primeira - b.primeira);
  const topo = [
    `CONVERSAS DO SUPORTE - ${de} a ${ate}`,
    `Gerado em ${quando(Date.now() / 1000)}`,
    `Conversas: ${blocos.length} | Mensagens: ${totalMsgs}`,
    `"${NOME_ATENDENTE}" = mensagens enviadas pelo número de suporte. "Cliente" = mensagens recebidas.`,
    '',
  ].join('\n');
  const saida = path.join(RELATORIOS_DIR, `conversas_${de.replaceAll('/', '-')}_a_${ate.replaceAll('/', '-')}.txt`);
  fs.writeFileSync(saida, topo + '\n' + blocos.map((b) => b.texto).join('\n'));
  return { saida, conversas: blocos.length, mensagens: totalMsgs };
}

async function tratarComando(m) {
  const texto = (textoDe(m) || '').trim();
  const cmd = texto.toLowerCase().split(/\s+/)[0];
  if (!['/relatorio', '/relatório', '/planilha'].includes(cmd)) return;
  const destino = RELATORIO_PARA ? await jidPessoal() : m.key.remoteJid;
  const p = periodo(texto.split(/\s+/).slice(1));
  if (!p) {
    await sock.sendMessage(destino, { text: 'Não entendi o período. Exemplos (troque /relatorio por /planilha para a planilha automática):\n/relatorio\n/relatorio 20/10 a 19/11\n/relatorio outubro\n/relatorio mes passado\n/relatorio semana\n/relatorio hoje' });
    return;
  }
  const [de, ate] = p;
  console.log(`[${cmd}] pedido ${de} a ${ate}`);
  if (cmd !== '/planilha') {
    try {
      const r = await exportarConversas(de, ate);
      await sock.sendMessage(destino, {
        text: `Conversas de ${de} a ${ate}: ${r.conversas} conversas, ${r.mensagens} mensagens.\nManda o arquivo pro Claude interpretar os chamados.`,
      });
      await sock.sendMessage(destino, {
        document: fs.readFileSync(r.saida), fileName: path.basename(r.saida), mimetype: 'text/plain',
      });
    } catch (e) {
      console.error('[relatório] erro', e);
      await sock.sendMessage(destino, { text: `Erro ao gerar o arquivo:\n${String(e.message).slice(0, 500)}` });
    }
    return;
  }
  try {
    const { saida, resumo } = await gerarRelatorio(de, ate);
    await sock.sendMessage(destino, { text: resumo });
    await sock.sendMessage(destino, {
      document: fs.readFileSync(saida),
      fileName: path.basename(saida),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } catch (e) {
    console.error('[relatório] erro', e.message);
    await sock.sendMessage(destino, { text: `Erro ao gerar o relatório:\n${e.message.slice(0, 500)}` });
  }
}

// ---------- conexão ----------
// 1º tenta como "Desktop" (recebe mais histórico); se cair 3x seguidas sem conectar,
// usa a mesma identificação do assistente-wpp, que já funciona nesta VPS.
const NAVEGADORES = [
  ['desktop', () => (Browsers?.macOS ? Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '14.4.1'])],
  ['chrome', () => ['Chamados', 'Chrome', '1.0']],
];
let idxNavegador = process.env.NAVEGADOR === 'chrome' ? 1 : 0;
let falhasSeguidas = 0;
let jaConectou = false;

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  console.log(`Conectando (modo ${NAVEGADORES[idxNavegador][0]}, versão WA ${version?.join('.') ?? 'padrão'})...`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: NAVEGADORES[idxNavegador][1](),
    syncFullHistory: true,               // pede o histórico completo ao parear
    shouldSyncHistoryMessage: () => true,
    markOnlineOnConnect: false,          // não aparece "online" para os clientes
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nEscaneie no celular DO SUPORTE: Configurações > Aparelhos conectados > Conectar aparelho\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      jaConectou = true;
      falhasSeguidas = 0;
      console.log('✅ Conectado. Recebendo o histórico (pode levar alguns minutos)...');
      // pede de novo contatos/etiquetas (nomes da agenda e etiquetas do Business)
      setTimeout(async () => {
        try {
          await sock.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
          console.log(`[contatos] sincronizados. Etiquetas: ${Object.values(etiquetas).join(', ') || 'nenhuma'}`);
        } catch (e) { console.log('[contatos] não deu para sincronizar agora:', e.message); }
        resolverLids();
      }, 15_000);
      if (RELATORIO_PARA) jidPessoal().then((j) => console.log(`Relatórios vão para ${j}`));
      else console.log('RELATORIO_PARA não definido: relatórios vão para a conversa consigo mesmo.');
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        console.log('❌ Sessão encerrada no celular. Rode: docker compose down -v && docker compose up -d (gera outro QR; apaga as mensagens salvas).');
        process.exit(1);
      }
      const motivo = lastDisconnect?.error?.message || '?';
      console.log(`Conexão caiu (código ${codigo ?? '?'}: ${motivo}) [modo ${NAVEGADORES[idxNavegador][0]}], reconectando em 5s...`);
      if (!jaConectou && ++falhasSeguidas >= 3 && idxNavegador === 0) {
        idxNavegador = 1;
        falhasSeguidas = 0;
        console.log('Trocando para o modo chrome (igual ao assistente).');
      }
      setTimeout(conectar, 5000);
    }
  });

  sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [], progress, isLatest }) => {
    for (const c of contacts) registrarContato(c);
    for (const c of chats) {
      if (!individual(c.id)) continue;
      definir(c.id, 'agenda', c.name);
      ligarPn(c.id, c.pnJid || c.phoneNumber);
      ligarPn(c.id, c.lidJid);
    }
    for (const m of messages) guardar(m);
    pendenteGravar = true;
    console.log(`[histórico] +${messages.length} msgs  progresso: ${progress ?? '?'}%${isLatest ? '  (último lote)' : ''}`);
  });

  sock.ev.on('contacts.upsert', (cs) => cs.forEach(registrarContato));
  sock.ev.on('contacts.update', (cs) => cs.forEach(registrarContato));

  // telefone real de contatos que aparecem como @lid
  sock.ev.on('lid-mapping.update', (d) => {
    for (const x of [].concat(d?.mappings || d || [])) {
      const lid = x.lid || x.lidJid, pn = x.pn || x.pnJid;
      if (lid && pn) ligarPn(String(lid).includes('@') ? lid : `${lid}@lid`, String(pn).includes('@') ? pn : `${pn}@s.whatsapp.net`);
    }
  });

  // etiquetas do WhatsApp Business
  sock.ev.on('labels.edit', (l) => {
    if (!l?.id) return;
    if (l.deleted) delete etiquetas[l.id]; else etiquetas[l.id] = l.name;
    pendenteGravar = true;
  });
  sock.ev.on('labels.association', ({ association, type }) => {
    if (association?.type !== 'chat' || !association.chatId) return;
    const lista = new Set(ct(association.chatId).etiquetas || []);
    if (type === 'remove') lista.delete(association.labelId); else lista.add(association.labelId);
    ct(association.chatId).etiquetas = [...lista];
    pendenteGravar = true;
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      if (ehMinhaConversa(m.key?.remoteJid)) {
        const recente = Date.now() - Number(m.messageTimestamp || 0) * 1000 < 2 * 60_000;
        if (m.key.fromMe && recente && (type === 'notify' || type === 'append')) {
          await tratarComando(m).catch((e) => console.error('[erro]', e));
        }
        continue;
      }
      if (ehPessoal(m)) {
        const recente = Date.now() - Number(m.messageTimestamp || 0) * 1000 < 2 * 60_000;
        if (!m.key.fromMe && recente && type === 'notify') {
          await tratarComando(m).catch((e) => console.error('[erro]', e));
        }
        continue;
      }
      guardar(m);
    }
  });
}

process.on('SIGTERM', () => { gravar(); process.exit(0); });
process.on('SIGINT', () => { gravar(); process.exit(0); });

carregarSalvas();
await conectar();
