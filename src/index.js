// Bot de chamados: conecta no WhatsApp do suporte (só leitura), guarda as conversas
// individuais e gera o relatório de chamados quando pedido.
//
// - Ao parear, recebe o histórico sincronizado do celular e grava tudo.
// - Depois continua gravando as mensagens novas.
// - Na conversa "Você" (mensagem para si mesmo) do número de suporte, mande:
//       /relatorio                 -> do dia 20 do mês passado até hoje
//       /relatorio 20/10 19/11     -> período escolhido (ano atual se omitido)
//   e o bot responde ali mesmo com o resumo e a planilha.
// O bot NUNCA responde clientes: só escreve na conversa consigo mesmo.
import 'dotenv/config';
import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

process.env.TZ ||= 'America/Sao_Paulo';

const makeWASocket = baileys.makeWASocket ?? baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

const AUTH_DIR = process.env.AUTH_DIR || 'estado/auth';
const DATA_DIR = process.env.DATA_DIR || 'estado/data';
const CONVERSAS_DIR = path.join(DATA_DIR, 'conversas');
const RELATORIOS_DIR = path.join(DATA_DIR, 'relatorios');
const ARQ_MSGS = path.join(DATA_DIR, 'mensagens.jsonl');
const ARQ_NOMES = path.join(DATA_DIR, 'nomes.json');
const NOME_ATENDENTE = process.env.NOME_ATENDENTE || 'Suporte';
const GUARDAR_DESDE = process.env.GUARDAR_DESDE || ''; // dd/mm/aaaa opcional
const PAUSA_MIN = process.env.PAUSA_MIN || '30';
const NOVO_HORAS = process.env.NOVO_HORAS || '4';

fs.mkdirSync(CONVERSAS_DIR, { recursive: true });
fs.mkdirSync(RELATORIOS_DIR, { recursive: true });

// ---------- armazenamento ----------
const conversas = new Map(); // jid -> Map(id -> {ts, fromMe, texto})
let nomes = {};
try { nomes = JSON.parse(fs.readFileSync(ARQ_NOMES, 'utf8')); } catch {}

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
  if (!individual(jid) || ehMinhaConversa(jid)) return;
  const ts = Number(m.messageTimestamp || 0);
  if (!ts || ts < limiteInicio) return;
  const texto = textoDe(m);
  if (!texto) return;
  const fromMe = !!m.key.fromMe;
  if (!fromMe && m.pushName && !nomes[jid]) nomes[jid] = m.pushName;
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
const nomeDe = (jid) => String(nomes[jid] || jid.split('@')[0]).replace(/[\\/:*?"<>|\n]/g, '_').trim();

function gravar() {
  if (!pendenteGravar) return;
  pendenteGravar = false;
  if (buffer.length) fs.appendFileSync(ARQ_MSGS, buffer.splice(0).join('\n') + '\n');
  fs.writeFileSync(ARQ_NOMES, JSON.stringify(nomes, null, 1));
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

function periodo(args) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const parse = (s) => {
    const [d, m, a] = s.split('/').map(Number);
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a ? (a < 100 ? 2000 + a : a) : ano}`;
  };
  const fmtD = (d) => d.toLocaleDateString('pt-BR');
  if (args.length >= 2) return [parse(args[0]), parse(args[1])];
  if (args.length === 1) return [parse(args[0]), fmtD(hoje)];
  return [fmtD(new Date(ano, hoje.getMonth() - 1, 20)), fmtD(hoje)];
}

function gerarRelatorio(de, ate) {
  gravar();
  const saida = path.join(RELATORIOS_DIR, `chamados_${de.replaceAll('/', '-')}_a_${ate.replaceAll('/', '-')}.xlsx`);
  const args = ['relatorio/chamados_wpp.py', CONVERSAS_DIR, '--de', de, '--ate', ate,
    '--atendente', NOME_ATENDENTE, '--pausa', PAUSA_MIN, '--novo', NOVO_HORAS, '--saida', saida];
  return new Promise((ok, erro) => execFile('python3', args, { timeout: 120_000 }, (e, stdout, stderr) =>
    e ? erro(new Error(stderr || e.message)) : ok({ saida, resumo: stdout.trim().split('\n').filter((l) => !l.startsWith('Planilha:')).join('\n') })));
}

async function tratarComando(m) {
  const texto = (textoDe(m) || '').trim();
  if (!texto.toLowerCase().startsWith('/relatorio')) return;
  const destino = m.key.remoteJid;
  const [de, ate] = periodo(texto.split(/\s+/).slice(1));
  console.log(`[relatório] pedido ${de} a ${ate}`);
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
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers?.macOS ? Browsers.macOS('Desktop') : ['Mac OS', 'Desktop', '14.4.1'],
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
    if (connection === 'open') console.log('✅ Conectado. Recebendo o histórico (pode levar alguns minutos)...');
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        console.log('❌ Sessão encerrada no celular. Rode: docker compose down -v && docker compose up -d (gera outro QR; apaga as mensagens salvas).');
        process.exit(1);
      }
      console.log('Conexão caiu, reconectando em 5s...');
      setTimeout(conectar, 5000);
    }
  });

  sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [], progress, isLatest }) => {
    for (const c of contacts) if (individual(c.id) && (c.name || c.notify)) nomes[c.id] = c.name || c.notify;
    for (const c of chats) if (individual(c.id) && c.name) nomes[c.id] = c.name;
    for (const m of messages) guardar(m);
    pendenteGravar = true;
    console.log(`[histórico] +${messages.length} msgs  progresso: ${progress ?? '?'}%${isLatest ? '  (último lote)' : ''}`);
  });

  sock.ev.on('contacts.upsert', (cs) => {
    for (const c of cs) if (individual(c.id) && (c.name || c.notify)) nomes[c.id] = c.name || c.notify;
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
      guardar(m);
    }
  });
}

process.on('SIGTERM', () => { gravar(); process.exit(0); });
process.on('SIGINT', () => { gravar(); process.exit(0); });

carregarSalvas();
await conectar();
