const fs = require('fs');
const path = require('path');

const crypto = require('crypto');

// =================== PASTAS (auth / data / backups) ===================
const ROOT_DIR = __dirname;
const AUTH_DIR = path.join(ROOT_DIR, 'auth');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BACKUP_DIR = path.join(ROOT_DIR, 'backups');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
ensureDir(AUTH_DIR);
ensureDir(DATA_DIR);
ensureDir(BACKUP_DIR);


// =================== MODOS DE TESTE ===================
const DRY_RUN =
  String(process.env.DRY_RUN || '').toLowerCase() === '1' ||
  String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const DISABLE_AUTOMATION =
  String(process.env.DISABLE_AUTOMATION || '').toLowerCase() === '1' ||
  String(process.env.DISABLE_AUTOMATION || '').toLowerCase() === 'true';


// =================== SEGURANÇA DO PAINEL ===================
// Defina no Railway/PC: PANEL_PASSWORD=SuaSenhaForte
const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD || 'iron123');
const PANEL_COOKIE_NAME = 'ig_panel';
const PANEL_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const panelSessions = new Map(); // token -> expiresAt

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  header.split(';').forEach(part => {
    const [k, ...rest] = part.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(rest.join('=') || '');
  });
  return out;
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function setCookie(res, name, val, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(val)}`];
  if (opts.maxAgeMs) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  parts.push('Path=/');
  parts.push('HttpOnly');
  // SameSite Lax evita CSRF básico sem quebrar fetch same-origin
  parts.push('SameSite=Lax');
  // Em localhost não precisa Secure; em https é melhor
  if (opts.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function requirePanelAuth(req, res, next) {
  // libera login e assets
  if (req.path === '/login' || req.path === '/logout') return next();

  // API do painel também exige auth
  const cookies = parseCookies(req);
  const token = cookies[PANEL_COOKIE_NAME];
  const exp = token ? panelSessions.get(token) : null;

  if (token && exp && exp > Date.now()) return next();

  // Se for API, retorna 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  return res.redirect('/login');
}


// =================== IMPORTS WHATSAPP ===================

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

// =================== CONFIG ===================

const DAY_MS = 24 * 60 * 60 * 1000;

// Funil de vendas
const FIRST_STEP_MS = 4 * 60 * 60 * 1000; // 1º follow-up: 4 horas
const STEPS_DAYS = [3, 7, 15]; // depois: 3d, 7d, 15d
const EXTRA_INTERVAL_DAYS = 30; // depois a cada 30 dias forever

// Agenda confirmada (recordatórios)
const AGENDA_OFFSETS_DAYS = [7, 3, 1]; // 7d / 3d / 1d antes

// Janela de envio
const START_HOUR = 9;
const END_HOUR = 22;

// Comandos teus
const CMD_PAUSE = '#falamos no futuro';
const CMD_STOP = '#okok';
const CMD_CLIENT = '#cliente';
const CMD_STATS = '#stats';
const CMD_EXPORT = '#exportar';

// Ignorar mensagens antigas
const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

// Arquivos de persistência
const DATA_FILE = path.join(DATA_DIR, 'clientes.json');
const MSG_FILE = path.join(DATA_DIR, 'mensajes.json');
const BLOCK_FILE = path.join(DATA_DIR, 'bloqueados.json');
const PAUSE_FILE = path.join(DATA_DIR, 'pausados.json');
const AGENDA_FILE = path.join(DATA_DIR, 'agendas.json');
const PROGRAM_FILE = path.join(DATA_DIR, 'programados.json');
const CHAT_FILE = path.join(DATA_DIR, 'chats.json');

let clients = {};
let messagesConfig = {};
let chatStore = {};
let blocked = {};
let paused = {};
let agendas = {};
let scheduledStarts = {};

let sock = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

let messageQueue = []; // { jid, kind: 'funil'|'agenda'|'startFunil', key? }
let botSentRecently = new Set();
let scheduledQueue = new Set();

// =================== LOAD/SAVE ===================

function listDataJSONFiles() {
  try {
    ensureDir(DATA_DIR);
    return fs.readdirSync(DATA_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => path.join(DATA_DIR, f));
  } catch (_) {
    return [];
  }
}

function runBackupNow() {
  try {
    ensureDir(BACKUP_DIR);
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const outDir = path.join(BACKUP_DIR, day);
    ensureDir(outDir);

    const files = listDataJSONFiles();
    for (const f of files) {
      const base = path.basename(f);
      const dest = path.join(outDir, base);
      fs.copyFileSync(f, dest);
    }
    console.log('[BACKUP] OK ->', outDir, `(${files.length} arquivos)`);
  } catch (e) {
    console.error('[BACKUP] Falhou:', e.message);
  }
}

function scheduleDailyBackup(hour = 3, minute = 5) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const ms = next.getTime() - now.getTime();

  setTimeout(() => {
    runBackupNow();
    setInterval(runBackupNow, 24 * 60 * 60 * 1000);
  }, ms);
}




function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function loadJSON(file, fallback) {
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) {
      atomicWrite(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) {
      atomicWrite(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    return JSON.parse(raw);
  } catch (e) {
    try {
      // Se corrompeu, salva uma cópia e reseta
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const corrupt = `${file}.corrupt.${ts}`;
      try { fs.copyFileSync(file, corrupt); } catch (_) {}
      atomicWrite(file, JSON.stringify(fallback, null, 2));
    } catch (_) {}
    console.error(`Erro ao ler ${path.basename(file)}:`, e.message);
    return fallback;
  }
}

function saveJSON(file, data) {
  try {
    ensureDir(path.dirname(file));
    atomicWrite(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Erro ao salvar ${path.basename(file)}:`, e.message);
  }
}


function defaultMessages() {
  return {
    step0:
      'Olá! Tudo bem? Vi que você pediu informações sobre a proteção Iron Glass. Posso te ajudar em algo mais?',
    step1:
      'Passando pra lembrar da proteção Iron Glass que conversamos. Ainda tem interesse em proteger seu veículo?',
    step2:
      'Só pra não te deixar sem retorno: seguimos à disposição pra cuidar dos vidros do seu carro com Iron Glass.',
    step3:
      'Último lembrete: quando quiser falar sobre proteção de vidros, pode me chamar aqui 😊',
    extra:
      'Estamos sempre à disposição pra tirar dúvidas sobre a proteção Iron Glass.',
    postSale30:
      'Oi! Tudo bem com a proteção Iron Glass do seu carro? Se estiver gostando, você indicaria alguém que também queira proteger o veículo?',
    agendaPrefix:
      'Perfeito, sua agenda está confirmada conosco! Qualquer dúvida estou à disposição.',
    agendaConfirmTemplate:
      '📅 Confirmação de Agendamento - Iron Glass\n\nPrezado cliente,\nconfirmamos seu agendamento para o dia {{DATA}} às {{HORA}}h\n\n🚗 Veículo: {{VEICULO}}\n🛡️ Produto: {{PRODUTO}}\n💰 Valor total: {{VALOR}}\n💵 Sinal recebido: {{SINAL}} ({{PAGAMENTO}})\n📍 Endereço: {{ENDERECO}}\n\nAgradecemos a confiança em Iron Glass. Nossa equipe estará aguardando você na data marcada.',
    agendaReminderTemplate:
      '📌 Lembrete Iron Glass: faltam {{DIAS}} dia(s) para sua instalação.\n📅 {{DATA}} às {{HORA}}h\n🚗 {{VEICULO}} | 🛡️ {{PRODUTO}}\n📍 {{ENDERECO}}\nSe precisar remarcar, responda aqui.',
    quickReplies: [
      'Oi, tudo bem? 😊',
      'Consigo te explicar rapidinho como funciona Iron Glass.',
      'Podemos agendar sua instalação hoje mesmo.',
    ],
  };
}

function computeStats() {
  const keys = new Set();
  const addKeys = (obj) => {
    if (!obj) return;
    for (const k of Object.keys(obj)) keys.add(k);
  };

  addKeys(clients);
  addKeys(blocked);
  addKeys(paused);
  addKeys(scheduledStarts);
  addKeys(chatStore);

  // agendas pode ser {jid: container}
  addKeys(agendas);

  const total = keys.size;

  let blockedCount = 0;
  let pausedCount = 0;
  let agendaCount = 0;
  let clientsCount = 0;
  let activeCount = 0;

  for (const jid of keys) {
    if (blocked && blocked[jid]) blockedCount += 1;
    if (paused && paused[jid]) pausedCount += 1;

    const a = agendas && agendas[jid];
    if (a && (a.appointmentTs || (a.reminders && a.reminders.length))) agendaCount += 1;

    const c = clients && clients[jid];
    if (c && c.isClient) clientsCount += 1;

    if (!(blocked && blocked[jid])) activeCount += 1;
  }

  return {
    total,
    active: activeCount,
    clients: clientsCount,
    agendas: agendaCount,
    paused: pausedCount,
    blocked: blockedCount,
  };
}

function toCSV(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = ['numero', 'jid', 'etapa', 'estado', 'ultima_interacao', 'agenda'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      esc(r.numero),
      esc(r.jid),
      esc(r.etapa),
      esc(r.estado),
      esc(r.ultima_interacao),
      esc(r.agenda),
    ].join(','));
  }
  return lines.join('\n');
}

function buildExportRows() {
  const keys = new Set([
    ...Object.keys(clients || {}),
    ...Object.keys(chatStore || {}),
    ...Object.keys(agendas || {}),
    ...Object.keys(paused || {}),
    ...Object.keys(blocked || {}),
    ...Object.keys(scheduledStarts || {}),
  ]);

  const rows = [];
  for (const jid of keys) {
    const num = String(jid).split('@')[0] || jid;

    const c = clients[jid] || {};
    const st = blocked[jid] ? 'bloqueado' : paused[jid] ? 'pausado' : c.isClient ? 'cliente' : 'ativo';

    const last = c.lastContact || (chatStore[jid] && chatStore[jid].lastMessageAt) || '';
    const lastFmt = last ? new Date(last).toISOString() : '';

    const agenda = agendas[jid] && agendas[jid].appointmentTs ? new Date(agendas[jid].appointmentTs).toISOString() : '';

    rows.push({
      numero: num,
      jid,
      etapa: typeof c.stepIndex === 'number' ? c.stepIndex : '',
      estado: st,
      ultima_interacao: lastFmt,
      agenda,
    });
  }

  // Ordena por última interação desc
  rows.sort((a, b) => String(b.ultima_interacao).localeCompare(String(a.ultima_interacao)));
  return rows;
}

async function sendCSVTo(jid) {
  const rows = buildExportRows();
  const csv = toCSV(rows);
  const buf = Buffer.from(csv, 'utf8');
  const fname = `clientes_${new Date().toISOString().slice(0,10)}.csv`;

  if (!sock) throw new Error('Socket não inicializado');

  if (DRY_RUN) {
    console.log('[DRY_RUN] Enviaria CSV para', jid, '->', fname, 'bytes', buf.length);
    return;
  }

  await sock.sendMessage(jid, {
    document: buf,
    fileName: fname,
    mimetype: 'text/csv',
    caption: `📄 Exportação de clientes (${rows.length})`,
  });
}


function loadAll() {
  clients = loadJSON(DATA_FILE, {});
  messagesConfig = loadJSON(MSG_FILE, defaultMessages());

// Backup diário automático (03:05)
scheduleDailyBackup();


  // Garantir estrutura mínima
  if (!Array.isArray(messagesConfig.quickReplies)) {
    messagesConfig.quickReplies = defaultMessages().quickReplies;
    saveMessages();
  }

  blocked = loadJSON(BLOCK_FILE, {});
  paused = loadJSON(PAUSE_FILE, {});
  agendas = loadJSON(AGENDA_FILE, {});
  scheduledStarts = loadJSON(PROGRAM_FILE, {});
  chatStore = loadJSON(CHAT_FILE, {});
}

function saveClients() {
  saveJSON(DATA_FILE, clients);
}
function saveMessages() {
  saveJSON(MSG_FILE, messagesConfig);
}
function saveBlocked() {
  saveJSON(BLOCK_FILE, blocked);
}
function savePaused() {
  saveJSON(PAUSE_FILE, paused);
}
function saveAgendas() {
  saveJSON(AGENDA_FILE, agendas);
}
function saveProgramados() {
  saveJSON(PROGRAM_FILE, scheduledStarts);
}
function saveChats() {
  saveJSON(CHAT_FILE, chatStore);
}

// =================== UTILS ===================

function isInsideWindow(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  return h >= START_HOUR && h < END_HOUR;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function cleanText(t) {
  if (!t) return '';
  return t.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function getMsgBody(msg) {
  const m = msg.message;
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage) return m.extendedTextMessage.text || '';
  if (m.imageMessage && m.imageMessage.caption) return m.imageMessage.caption;
  if (m.videoMessage && m.videoMessage.caption) return m.videoMessage.caption;
  return '';
}

function getMsgMs(msg) {
  if (msg.messageTimestamp) return Number(msg.messageTimestamp) * 1000;
  return Date.now();
}

// detecta confirmação manual no teu texto
function parseAgendaConfirmation(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (
    !lower.includes('confirmação') &&
    !lower.includes('confirmacion') &&
    !lower.includes('agendamento') &&
    !lower.includes('agenda')
  )
    return null;

  const dateMatch = lower.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!dateMatch) return null;

  let d = dateMatch[1],
    m = dateMatch[2],
    y = dateMatch[3];
  if (y.length === 2) y = '20' + y;

  const timeMatch = lower.match(/(\d{1,2})\s*[:h]\s*(\d{2})/i);
  let hh = '09',
    mm = '00';
  if (timeMatch) {
    hh = String(timeMatch[1]).padStart(2, '0');
    mm = String(timeMatch[2]).padStart(2, '0');
  }

  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(
    2,
    '0'
  )}T${hh}:${mm}:00`;
  const ts = new Date(iso).getTime();
  if (isNaN(ts)) return null;
  return ts;
}

// =================== CHAT STORE (PAINEL) ===================

function ensureChat(jid) {
  if (!chatStore[jid]) {
    chatStore[jid] = {
      jid,
      messages: [],
      unread: 0,
      lastMessageAt: 0,
      pinned: false,
      name: jid,
    };
  }
  return chatStore[jid];
}

function upsertChatMessage(jid, fromMe, text, timestamp) {
  const chat = ensureChat(jid);
  chat.messages.push({
    fromMe,
    text,
    timestamp,
  });
  chat.lastMessageAt = timestamp || Date.now();
  if (!fromMe) chat.unread += 1;
  saveChats();
  updateBeepLoop();
  sseBroadcast({ type: 'message', jid, message: { fromMe, text, timestamp } });
  sseBroadcast({ type: 'chat', jid, meta: { jid: chat.jid, name: chat.name, unread: chat.unread, lastMessageAt: chat.lastMessageAt, lastMessage: text, pinned: !!chat.pinned } });
}


// =================== TEMPLATE & AGENDA HELPERS ===================

function renderTemplate(tpl, vars = {}) {
  const safe = String(tpl ?? '');
  return safe.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => {
    const key = String(k || '').toUpperCase();
    const val = vars[key];
    return val === undefined || val === null ? '' : String(val);
  });
}

function formatBRDate(ts) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function formatBRTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

function normalizeToJid(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits + '@s.whatsapp.net';
}

// =================== ADMIN (para comandos #stats / #exportar) ===================
// Opcional: ADMIN_NUMBERS="5511999999999,5511888888888"
const ADMIN_NUMBERS = String(process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ADMIN_JIDS = new Set(ADMIN_NUMBERS.map(normalizeToJid).filter(Boolean));
let MY_JID = null;

function isAdminContext(jid) {
  if (!jid) return false;
  if (MY_JID && jid === MY_JID) return true; // mensagem para mim
  if (ADMIN_JIDS.has(jid)) return true;
  return false;
}


function getAgendaContainer(jid) {
  const v = agendas[jid];
  if (!v) return null;
  if (Array.isArray(v)) return { reminders: v, details: {}, appointmentTs: null };
  if (typeof v === 'object') {
    return {
      appointmentTs: v.appointmentTs || null,
      details: v.details || {},
      reminders: Array.isArray(v.reminders) ? v.reminders : [],
    };
  }
  return null;
}

function setAgendaContainer(jid, container) {
  agendas[jid] = container;
  saveAgendas();
}

function getAgendaReminders(jid) {
  const c = getAgendaContainer(jid);
  return c ? c.reminders : [];
}

function hasActiveAgenda(jid) {
  return getAgendaReminders(jid).length > 0;
}

// Replica a lógica do "fromMe" do WhatsApp, mas para mensagens enviadas pelo painel (/send)
function processAgentMessage(jid, body, sentAt = Date.now()) {
  if (!jid || !body) return;
  const lower = String(body).toLowerCase();

  // Comandos
  if (lower.includes(CMD_STOP)) {
    blockFollowUp(jid);
    return;
  }
  if (lower.includes(CMD_PAUSE72)) {
    pauseFollowUp(jid, 72);
    return;
  }
  if (lower.includes(CMD_CLIENT)) {
    markAsClient(jid);
    return;
  }

  // Detecta confirmação de agenda no texto
  const conf = parseAgendaConfirmation(body);
  if (conf && conf.ts) {
    scheduleAgenda(jid, conf.ts, { source: 'manual' });
    console.log('[AGENDA] Confirmação detectada (painel) -> lembretes criados', jid);
    return;
  }

  // Se não for comando, salva no chat store
  if (body && body.trim() && !body.trim().startsWith('#')) {
    upsertChatMessage(jid, true, body, sentAt);
  }

  // Regras para reiniciar funil
  if (blocked[jid]) return;

  if (hasActiveAgenda(jid)) {
    console.log('[PAINEL] Cliente com agenda ativa; não reinicia funil ->', jid);
    return;
  }
  const c = clients[jid];
  if (c && c.isClient) {
    console.log('[PAINEL] Cliente pós-venda; não reinicia funil normal ->', jid);
    return;
  }

  if (paused[jid]) {
    const pausedAt = paused[jid].pauseUntil || 0;
    if (sentAt < pausedAt) {
      console.log('[PAINEL] Cliente pausado; não reinicia funil ->', jid);
      return;
    }
    delete paused[jid];
    savePaused();
  }

  // reinicia funil (4h)
  if (!clients[jid]) {
    clients[jid] = {
      jid,
      stepIndex: 0,
      nextFollowUpAt: sentAt + FIRST_FOLLOWUP_HOURS * 60 * 60 * 1000,
      ignoreNextFromMe: false,
      isClient: false,
      lastIncomingAt: 0,
    };
  } else {
    clients[jid].stepIndex = 0;
    clients[jid].nextFollowUpAt = sentAt + FIRST_FOLLOWUP_HOURS * 60 * 60 * 1000;
  }
  saveClients();
  console.log('[FUNIL] Reiniciado (painel) ->', jid);
}


function markChatRead(jid) {
  const chat = ensureChat(jid);
  chat.unread = 0;
  saveChats();
  updateBeepLoop();
  sseBroadcast({ type: 'chat', jid, meta: { jid: chat.jid, name: chat.name, unread: chat.unread, lastMessageAt: chat.lastMessageAt, lastMessage: (chat.messages && chat.messages.length ? chat.messages[chat.messages.length-1].text : ''), pinned: !!chat.pinned } });
}

function hasUnread() {
  return Object.values(chatStore).some((c) => c.unread > 0);
}

// =================== EXPRESS / HTTP ===================

const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);

const sseClients = new Set();

function sseWrite(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {}
}

function sseBroadcast(data) {
  for (const res of Array.from(sseClients)) {
    try {
      sseWrite(res, data);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

app.get('/sse', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  sseClients.add(res);
  sseWrite(res, { type: 'hello', ts: Date.now() });

  const ping = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch (e) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requirePanelAuth);


app.get('/', (req, res) => {
  res.redirect('/admin');
});


app.get('/login', (req, res) => {
  const html = `
  <!doctype html>
  <html lang="pt-br">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Iron Glass • Login</title>
    <style>
      *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
      body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 800px at 20% 20%, #0b1223 0%, #020617 55%, #000 100%);color:#e2e8f0}
      .card{width:min(420px,92vw);background:rgba(15,23,42,.7);border:1px solid rgba(148,163,184,.18);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.55);padding:22px}
      h1{font-size:18px;margin:0 0 8px 0;letter-spacing:.4px}
      p{margin:0 0 16px 0;color:#94a3b8;font-size:13px}
      input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid rgba(148,163,184,.25);background:rgba(2,6,23,.55);color:#e2e8f0;outline:none}
      button{width:100%;margin-top:12px;padding:12px 14px;border-radius:12px;border:0;background:linear-gradient(90deg,#2563eb,#60a5fa);color:#fff;font-weight:700;cursor:pointer}
      .err{margin-top:10px;color:#fca5a5;font-size:13px;display:none}
      .brand{display:flex;gap:10px;align-items:center;margin-bottom:10px}
      .badge{width:38px;height:38px;border-radius:14px;background:linear-gradient(135deg,#0ea5e9,#1d4ed8);display:flex;align-items:center;justify-content:center;font-weight:900}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="brand"><div class="badge">IG</div><div><h1>Painel Iron Glass</h1><p>Digite sua senha para acessar.</p></div></div>
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Senha do painel" autofocus />
        <button type="submit">Entrar</button>
      </form>
      <div class="err" id="err">Senha incorreta.</div>
      <script>
        const u = new URL(location.href);
        if (u.searchParams.get('err') === '1') document.getElementById('err').style.display = 'block';
      </script>
    </div>
  </body>
  </html>`;
  res.send(html);
});

app.post('/login', (req, res) => {
  const pass = String((req.body && req.body.password) || '');
  if (pass !== PANEL_PASSWORD) return res.redirect('/login?err=1');

  const token = newToken();
  panelSessions.set(token, Date.now() + PANEL_COOKIE_TTL_MS);
  setCookie(res, PANEL_COOKIE_NAME, token, { maxAgeMs: PANEL_COOKIE_TTL_MS });

  return res.redirect('/admin?tab=chat');
});

app.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[PANEL_COOKIE_NAME];
  if (token) panelSessions.delete(token);
  clearCookie(res, PANEL_COOKIE_NAME);
  res.redirect('/login');
});

app.get('/admin', (req, res) => {
  const tab = req.query.tab || 'chat';

  if (tab === 'config') {
    return renderConfigPage(req, res);
  }
  if (tab === 'program') {
    return renderProgramPage(req, res);
  }
  if (tab === 'calendar') {
    return renderCalendarPage(req, res);
  }

  return renderChatPage(req, res);
});

function renderChatPage(req, res) {
  // Ordena: pinned primeiro, depois por última mensagem
  const chats = Object.values(chatStore || {}).sort((a, b) => {
    const ap = a && a.pinned ? 1 : 0;
    const bp = b && b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const at = Number(a && a.lastMessageAt ? a.lastMessageAt : 0);
    const bt = Number(b && b.lastMessageAt ? b.lastMessageAt : 0);
    return bt - at;
  });

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const quickArray = Array.isArray(messagesConfig?.quickReplies)
    ? messagesConfig.quickReplies
    : defaultMessages().quickReplies;

  const quickRepliesHtml = quickArray
    .map((qRaw) => {
      const q = String(qRaw ?? '');
      const safeLabel = esc(q);
      const safeJs = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `
      <button class="quick-reply" onclick="appendQuickReply('${safeJs}')">
        ${safeLabel}
      </button>
    `;
    })
    .join('');

  const chatItemsHtml = chats
    .map((c) => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const lastMsg = msgs.length ? (msgs[msgs.length - 1].text || '') : '';
      const lastTime = c.lastMessageAt
        ? new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
          })
        : '--:--';
      const initials = (c.name || c.jid || '')
        .split('@')[0]
        .replace(/\D/g, '')
        .slice(-4);

      const pinIcon = c.pinned ? '📌' : '📍';

      return `
      <div class="chat-item" data-jid="${esc(c.jid)}" onclick="selectChat('${esc(c.jid)}')">
        <div class="avatar">${esc(initials || 'IG')}</div>
        <div class="info">
          <div class="top-row">
            <div class="name">${esc(c.name || c.jid)}</div>
            <div class="time">${esc(lastTime)}</div>
          </div>
          <div class="last-message">${esc(lastMsg)}</div>
        </div>
        <button class="pin-btn" title="Anclar" onclick="togglePin(event, '${esc(c.jid)}')">${pinIcon}</button>
        ${c.unread ? `<div class="unread">${Number(c.unread || 0)}</div>` : ''}
      </div>
    `;
    })
    .join('');

  const html = `
  <!DOCTYPE html>
  <html lang="pt-br">
  <head>
    <meta charset="UTF-8" />
    <title>Iron Glass - Painel</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #111827, #020617, #000);
        color: #e5e7eb;
        height: 100vh;
        display: flex;
        flex-direction: column;
      }
      header {
        padding: 12px 20px;
        border-bottom: 1px solid rgba(148,163,184,0.2);
        display: flex;
        align-items: center;
        justify-content: space-between;
        backdrop-filter: blur(12px);
        background: linear-gradient(to right, rgba(15,23,42,0.95), rgba(30,64,175,0.6));
        box-shadow: 0 15px 45px rgba(15,23,42,0.8);
        position: relative;
        z-index: 10;
      }
      header .logo {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      header .logo-icon {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        background: radial-gradient(circle at 30% 20%, #facc15, #f97316 40%, #0f172a 75%, #020617 100%);
        box-shadow:
          0 0 20px rgba(250,204,21,0.7),
          0 0 50px rgba(37,99,235,0.6),
          inset 0 0 15px rgba(15,23,42,0.9);
        position: relative;
        overflow: hidden;
      }
      header .logo-icon::before {
        content: "";
        position: absolute;
        inset: 3px;
        border-radius: 10px;
        border: 1px solid rgba(248,250,252,0.1);
        box-shadow:
          0 0 10px rgba(59,130,246,0.4),
          inset 0 0 10px rgba(15,23,42,0.9);
      }
      header .logo-text {
        display: flex;
        flex-direction: column;
      }
      header .logo-text span:first-child {
        font-weight: 700;
        letter-spacing: 0.08em;
        font-size: 13px;
        text-transform: uppercase;
        color: #e5e7eb;
      }
      header .logo-text span:last-child {
        font-size: 11px;
        color: #9ca3af;
      }
      header .status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: #9ca3af;
        justify-content: flex-end;
      }
      header .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: ${isConnected ? '#22c55e' : '#ef4444'};
        box-shadow: 0 0 10px rgba(34,197,94,0.8);
      }
      header .pill {
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(15,23,42,0.7);
        border: 1px solid rgba(148,163,184,0.5);
        color: #e5e7eb;
        font-size: 11px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      header .pill span {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(37,99,235,0.25);
        border: 1px solid rgba(59,130,246,0.5);
        font-size: 10px;
        text-transform: uppercase;
      }

      .tabs {
        margin-top: 8px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .tab {
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,184,0.5);
        color: #e5e7eb;
        text-decoration: none;
        background: rgba(15,23,42,0.6);
      }
      .tab.active {
        background: rgba(37,99,235,0.7);
        border-color: rgba(129,140,248,0.9);
      }

      main { flex: 1; display: flex; overflow: hidden; }

      .sidebar {
        width: 320px;
        max-width: 340px;
        border-right: 1px solid rgba(148,163,184,0.2);
        background: linear-gradient(to bottom, rgba(15,23,42,0.85), rgba(15,23,42,0.95));
        display: flex;
        flex-direction: column;
      }

      .sidebar-header {
        padding: 10px 14px;
        display: flex;
        align-items: center;
        gap: 10px;
        border-bottom: 1px solid rgba(148,163,184,0.2);
      }
      .sidebar-header input {
        flex: 1;
        background: rgba(15,23,42,0.9);
        border-radius: 999px;
        border: 1px solid rgba(55,65,81,0.9);
        padding: 6px 10px;
        font-size: 12px;
        color: #e5e7eb;
        outline: none;
      }
      .sidebar-header input::placeholder { color: #6b7280; }
      .sidebar-header button {
        border-radius: 999px;
        border: 1px solid rgba(55,65,81,0.9);
        background: radial-gradient(circle at top left, rgba(59,130,246,0.3), rgba(15,23,42,0.95));
        color: #e5e7eb;
        font-size: 11px;
        padding: 6px 10px;
        cursor: pointer;
        white-space: nowrap;
      }
      .sidebar-header button:hover {
        background: radial-gradient(circle at top left, rgba(59,130,246,0.5), rgba(15,23,42,0.95));
      }

      .chat-list { flex: 1; overflow-y: auto; padding: 8px 6px; }

      .chat-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        margin-bottom: 4px;
        border-radius: 12px;
        cursor: pointer;
        transition: background 0.15s ease, transform 0.1s ease, box-shadow 0.15s ease;
        border: 1px solid transparent;
      }
      .chat-item:hover {
        background: radial-gradient(circle at top left, rgba(30,64,175,0.35), rgba(15,23,42,1));
        box-shadow: 0 8px 25px rgba(15,23,42,0.8);
        transform: translateY(-1px);
        border-color: rgba(59,130,246,0.5);
      }
      .chat-item.active {
        background: radial-gradient(circle at top left, rgba(37,99,235,0.4), rgba(15,23,42,1));
        border-color: rgba(129,140,248,0.8);
        box-shadow:
          0 0 0 1px rgba(129,140,248,0.5),
          0 10px 35px rgba(30,64,175,0.9);
      }
      .chat-item .avatar {
        width: 32px;
        height: 32px;
        border-radius: 10px;
        background: radial-gradient(circle at top left, #1d4ed8, #0f172a);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 600;
        color: #e5e7eb;
        box-shadow:
          0 0 12px rgba(37,99,235,0.7),
          inset 0 0 8px rgba(15,23,42,0.9);
        flex-shrink: 0;
      }
      .chat-item .info { flex: 1; min-width: 0; }
      .chat-item .info .top-row { display: flex; justify-content: space-between; margin-bottom: 2px; gap: 6px; }
      .chat-item .info .name { font-size: 13px; font-weight: 600; color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .chat-item .info .time { font-size: 11px; color: #9ca3af; flex-shrink: 0; }
      .chat-item .info .last-message { font-size: 11px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 175px; }

      .pin-btn{
        width: 30px;
        height: 30px;
        border-radius: 10px;
        border: 1px solid rgba(55,65,81,0.9);
        background: rgba(15,23,42,0.9);
        color: #e5e7eb;
        cursor: pointer;
        display:flex;
        align-items:center;
        justify-content:center;
        flex-shrink: 0;
      }
      .pin-btn:hover{ border-color: rgba(59,130,246,0.8); }

      .chat-item .unread {
        min-width: 18px;
        height: 18px;
        border-radius: 999px;
        background: radial-gradient(circle at top left, #f97316, #b91c1c);
        color: white;
        font-size: 11px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow:
          0 0 10px rgba(248,113,113,0.8),
          0 0 25px rgba(248,250,252,0.4);
        flex-shrink: 0;
      }

      .chat-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        background: radial-gradient(circle at top left, #020617, #020617, #030712);
      }
      .chat-header {
        padding: 10px 16px;
        border-bottom: 1px solid rgba(148,163,184,0.2);
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: linear-gradient(to right, rgba(15,23,42,0.9), rgba(30,64,175,0.4));
      }
      .chat-header .title { display: flex; flex-direction: column; }
      .chat-header .title span:first-child { font-size: 14px; font-weight: 600; color: #e5e7eb; }
      .chat-header .title span:last-child { font-size: 11px; color: #9ca3af; }
      .chat-header .tags { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .chat-header .tag { font-size: 10px; padding: 3px 8px; border-radius: 999px; border: 1px solid rgba(148,163,184,0.6); color: #e5e7eb; background: rgba(15,23,42,0.8); }

      .messages { flex: 1; padding: 12px 16px; overflow-y: auto; }
      .msg {
        max-width: 70%;
        margin-bottom: 8px;
        padding: 8px 10px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.35;
        word-wrap: break-word;
        overflow-wrap: break-word;
        white-space: pre-wrap;
      }
      .msg.me {
        margin-left: auto;
        background: linear-gradient(to bottom right, #1d4ed8, #4f46e5);
        color: white;
        border-bottom-right-radius: 4px;
      }
      .msg.them {
        margin-right: auto;
        background: rgba(15,23,42,0.9);
        border: 1px solid rgba(55,65,81,0.9);
        color: #e5e7eb;
        border-bottom-left-radius: 4px;
      }
      .msg .time {
        margin-top: 4px;
        font-size: 10px;
        color: #9ca3af;
        text-align: right;
      }

      .input-area {
        padding: 10px 14px;
        border-top: 1px solid rgba(148,163,184,0.2);
        background: linear-gradient(to bottom, rgba(15,23,42,0.96), rgba(15,23,42,1));
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .input-row { display: flex; gap: 8px; align-items: flex-end; }
      .input-row textarea {
        flex: 1;
        resize: none;
        min-height: 42px;
        max-height: 120px;
        padding: 8px 10px;
        border-radius: 12px;
        border: 1px solid rgba(55,65,81,0.9);
        background: rgba(15,23,42,0.9);
        color: #e5e7eb;
        font-size: 13px;
        outline: none;
      }
      .input-row textarea::placeholder { color: #6b7280; }
      .input-row button {
        padding: 8px 14px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(to right, #22c55e, #16a34a);
        color: white;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 30px rgba(22,163,74,0.8);
      }
      .input-row button:hover { background: linear-gradient(to right, #16a34a, #15803d); }

      .quick-replies { display: flex; flex-wrap: wrap; gap: 6px; }
      .quick-reply {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid rgba(55,65,81,0.9);
        background: rgba(15,23,42,0.9);
        color: #e5e7eb;
        cursor: pointer;
      }
      .quick-reply:hover { border-color: rgba(59,130,246,0.8); }

      .messages::-webkit-scrollbar,
      .chat-list::-webkit-scrollbar { width: 6px; }
      .messages::-webkit-scrollbar-thumb,
      .chat-list::-webkit-scrollbar-thumb { background: rgba(75,85,99,0.8); border-radius: 999px; }
      .messages::-webkit-scrollbar-track,
      .chat-list::-webkit-scrollbar-track { background: transparent; }

      @media (max-width: 900px) {
        .sidebar { width: 260px; }
        .chat-item .info .last-message { max-width: 140px; }
      }
      @media (max-width: 700px) {
        main { flex-direction: column; }
        .sidebar { width: 100%; max-width: 100%; height: 40vh; }
        .chat-area { height: 60vh; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="logo">
        <div class="logo-icon"></div>
        <div class="logo-text">
          <span>IRON GLASS</span>
          <span>Central de Conversas</span>
        </div>
      </div>
      <div>
        <div class="status">
          <div class="status-dot"></div>
          <span>${isConnected ? 'WhatsApp conectado' : 'WhatsApp desconectado'}</span>
          <div class="pill">Seg. Inteligente <span>Follow-up</span></div>
        </div>
        <div class="tabs">
          <a href="/admin?tab=chat" class="tab active">Conversas</a>
          <a href="/admin?tab=config" class="tab">Configuração</a>
          <a href="/admin?tab=program" class="tab">Programados</a>
          <a href="/admin?tab=calendar" class="tab">Calendário</a>
        </div>
      </div>
    </header>
    <main>
      <section class="sidebar">
        <div class="sidebar-header">
          <input id="search" placeholder="Buscar contato..." oninput="filterChats()" />
          <button onclick="refreshChats()">Atualizar</button>
          <button id="btn-sound" onclick="enableSound()">Som 🔊</button>
        </div>
        <div class="chat-list" id="chat-list">
          ${chatItemsHtml}
        </div>
      </section>
      <section class="chat-area">
        <div class="chat-header">
          <div class="title">
            <span id="chat-title">Selecione um contato</span>
            <span id="chat-subtitle">Histórico completo da conversa</span>
          </div>
          <div class="tags">
            <div class="tag">Follow-up 4h / 3 / 7 / 15</div>
            <div class="tag">Agenda & Pós-venda</div>
          </div>
        </div>
        <div class="messages" id="messages"></div>
        <div class="input-area">
          <div class="quick-replies" id="quick-replies">
            ${quickRepliesHtml}
          </div>
          <div class="input-row">
            <textarea id="msg-input" placeholder="Digite uma mensagem para enviar pelo seu WhatsApp..."></textarea>
            <button onclick="sendFromPanel()">Enviar</button>
          </div>
        </div>
      </section>
    </main>

    <script>
      let currentJid = null;
      let lastTotal = 0;

      // ================== SOM FORTE (WebAudio) ==================
      let audioEnabled = false;
      let audioCtx = null;
      let beepTimer = null;

      function enableSound() {
        try {
          audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
          audioEnabled = true;
          localStorage.setItem('ig_audio', '1');
          document.getElementById('btn-sound').textContent = 'Som ✅';
          playBeepOnce();
        } catch (e) {
          alert('Seu navegador bloqueou o som. Clique novamente.');
        }
      }

      function playBeepOnce() {
        if (!audioEnabled) return;
        if (!audioCtx) return;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'square';
        o.frequency.value = 880; // mais forte
        g.gain.value = 0.12;
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start();
        setTimeout(() => { try { o.stop(); } catch(e) {} }, 180);
      }

      function startBeepLoop() {
        if (!audioEnabled) return;
        if (beepTimer) return;
        beepTimer = setInterval(() => {
          if (!hasUnreadFlag()) {
            stopBeepLoop();
            return;
          }
          playBeepOnce();
        }, 1200);
      }
      function stopBeepLoop() {
        if (beepTimer) clearInterval(beepTimer);
        beepTimer = null;
      }

      // ================== UTILS ==================
      function fmtTime(ts) {
        try {
          const d = new Date(ts);
          return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return '--:--'; }
      }

      function isAtBottom(el) {
        const slack = 30;
        return (el.scrollTop + el.clientHeight + slack) >= el.scrollHeight;
      }

      // ================== PIN ==================
      async function togglePin(ev, jid) {
        ev.preventDefault();
        ev.stopPropagation();

        const el = document.querySelector('.chat-item[data-jid="' + CSS.escape(jid) + '"]');
        const btn = el ? el.querySelector('.pin-btn') : null;
        const isPinned = btn && btn.textContent.includes('📌');
        const next = !isPinned;

        try {
          await fetch('/api/chat/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid, pinned: next })
          });
          // Recarrega para reordenar (pinned primeiro) – não apaga histórico, só reordena.
          window.location.reload();
        } catch (e) {
          alert('Falha ao anclar: ' + (e.message || e));
        }
      }

      // ================== CHAT SELECT ==================
      async function selectChat(jid) {
        currentJid = jid;

        document.querySelectorAll('.chat-item').forEach(el => {
          el.classList.toggle('active', el.dataset.jid === jid);
        });

        try {
          const r = await fetch('/chats/' + encodeURIComponent(jid) + '?limit=400', { cache: 'no-store' });
          const data = await r.json();

          const title = document.getElementById('chat-title');
          const messagesDiv = document.getElementById('messages');

          title.textContent = data.name || jid;
          const stayBottom = isAtBottom(messagesDiv);

          messagesDiv.innerHTML = '';
          (data.messages || []).forEach(m => {
            const div = document.createElement('div');
            div.className = 'msg ' + (m.fromMe ? 'me' : 'them');
            div.textContent = m.text || '';
            const timeSpan = document.createElement('div');
            timeSpan.className = 'time';
            timeSpan.textContent = fmtTime(m.timestamp);
            div.appendChild(timeSpan);
            messagesDiv.appendChild(div);
          });

          lastTotal = Number(data.totalMessages || (data.messages ? data.messages.length : 0));

          if (stayBottom) {
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }

          fetch('/chats/' + encodeURIComponent(jid) + '/read', { method: 'POST' }).catch(()=>{});
          syncUnreadAndBeep();
        } catch (e) {
          alert('Erro ao abrir conversa: ' + (e.message || e));
        }
      }

      function refreshChats() {
        window.location.reload();
      }

      function appendQuickReply(text) {
        const input = document.getElementById('msg-input');
        if (!input.value) input.value = text;
        else input.value += '\\n' + text;
        input.focus();
      }

      async function sendFromPanel() {
        const input = document.getElementById('msg-input');
        const text = (input.value || '').trim();
        if (!currentJid || !text) return;

        try {
          await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: currentJid, text })
          });

          input.value = '';
          // Recarrega só o chat atual (leve)
          await selectChat(currentJid);
        } catch (e) {
          alert('Falha ao enviar: ' + (e.message || e));
        }
      }

      function hasUnreadFlag() {
        const items = document.querySelectorAll('.chat-item .unread');
        return items.length > 0;
      }

      function syncUnreadAndBeep() {
        if (hasUnreadFlag()) startBeepLoop();
        else stopBeepLoop();
      }

      // ================== LIVE (SEM TRAVAR) ==================
      let pollMetaRunning = false;
      let pollChatRunning = false;

      async function pollMeta() {
        if (pollMetaRunning) return;
        pollMetaRunning = true;
        try {
          const r = await fetch('/api/chats', { cache: 'no-store' });
          const data = await r.json();
          const chats = (data && data.chats) ? data.chats : [];
          // Só atualiza badges e preview; não re-renderiza a lista toda.
          for (const c of chats) {
            const row = document.querySelector('.chat-item[data-jid="' + CSS.escape(c.jid) + '"]');
            if (!row) continue;

            // unread
            const oldUnread = row.querySelector('.unread');
            const newUnread = Number(c.unread || 0);

            if (newUnread > 0) {
              if (oldUnread) oldUnread.textContent = String(newUnread);
              else {
                const d = document.createElement('div');
                d.className = 'unread';
                d.textContent = String(newUnread);
                row.appendChild(d);
              }
            } else {
              if (oldUnread) oldUnread.remove();
            }

            // last msg + time
            const lastMsgEl = row.querySelector('.last-message');
            if (lastMsgEl && typeof c.lastMessage === 'string') {
              const t = c.lastMessage;
              if (lastMsgEl.textContent !== t) lastMsgEl.textContent = t;
            }
            const timeEl = row.querySelector('.time');
            if (timeEl && c.lastMessageAt) {
              const t2 = new Date(c.lastMessageAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
              if (timeEl.textContent !== t2) timeEl.textContent = t2;
            }

            // pin icon (não muda sozinho, mas mantém certo)
            const pinBtn = row.querySelector('.pin-btn');
            if (pinBtn) pinBtn.textContent = c.pinned ? '📌' : '📍';
          }

          syncUnreadAndBeep();
        } catch (e) {
          // não trava
        } finally {
          pollMetaRunning = false;
        }
      }

      async function pollCurrentChat() {
        if (!currentJid) return;
        if (pollChatRunning) return;
        pollChatRunning = true;
        try {
          const r = await fetch('/chats/' + encodeURIComponent(currentJid) + '?limit=400', { cache: 'no-store' });
          const data = await r.json();
          const total = Number(data.totalMessages || 0);
          if (total !== lastTotal) {
            // atualiza a conversa sem piscar demais
            const messagesDiv = document.getElementById('messages');
            const stayBottom = isAtBottom(messagesDiv);

            messagesDiv.innerHTML = '';
            (data.messages || []).forEach(m => {
              const div = document.createElement('div');
              div.className = 'msg ' + (m.fromMe ? 'me' : 'them');
              div.textContent = m.text || '';
              const timeSpan = document.createElement('div');
              timeSpan.className = 'time';
              timeSpan.textContent = fmtTime(m.timestamp);
              div.appendChild(timeSpan);
              messagesDiv.appendChild(div);
            });

            lastTotal = total;
            if (stayBottom) messagesDiv.scrollTop = messagesDiv.scrollHeight;
          }
        } catch (e) {
          // ignora
        } finally {
          pollChatRunning = false;
        }
      }

      function filterChats() {
        const q = (document.getElementById('search').value || '').toLowerCase().trim();
        document.querySelectorAll('.chat-item').forEach(row => {
          const name = (row.querySelector('.name')?.textContent || '').toLowerCase();
          const jid = (row.dataset.jid || '').toLowerCase();
          const show = !q || name.includes(q) || jid.includes(q);
          row.style.display = show ? '' : 'none';
        });
      }

      // Auto enable som se já liberado antes
      (function initSoundPref(){
        try {
          if (localStorage.getItem('ig_audio') === '1') {
            // não chama play até o usuário interagir (alguns navegadores), mas deixa marcado
            document.getElementById('btn-sound').textContent = 'Som 🔊';
          }
        } catch(e) {}
      })();

      // Poll leve (não congela): meta a cada 4s, chat aberto a cada 2s
      setInterval(pollMeta, 4000);
      setInterval(pollCurrentChat, 2000);
      pollMeta();
      syncUnreadAndBeep();
    </script>
  </body>
  </html>
  `;

  res.send(html);
}


function renderConfigPage(req, res) {
  const msg = messagesConfig;
  const quickList = Array.isArray(msg.quickReplies)
    ? msg.quickReplies
    : defaultMessages().quickReplies;
  const quickRepliesText = quickList
    .map((s) => String(s ?? ''))
    .join('\n');

  const html = `
  <!DOCTYPE html>
  <html lang="pt-br">
  <head>
    <meta charset="UTF-8" />
    <title>Iron Glass - Configuração</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #111827, #020617, #000);
        color: #e5e7eb;
        margin: 0;
        padding: 0;
      }
      header {
        padding: 12px 20px;
        border-bottom: 1px solid rgba(148,163,184,0.2);
        display: flex;
        align-items: center;
        justify-content: space-between;
        backdrop-filter: blur(12px);
        background: linear-gradient(to right, rgba(15,23,42,0.95), rgba(30,64,175,0.6));
        box-shadow: 0 15px 45px rgba(15,23,42,0.8);
      }
      header .logo {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      header .logo-icon {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        background: radial-gradient(circle at 30% 20%, #facc15, #f97316 40%, #0f172a 75%, #020617 100%);
        box-shadow:
          0 0 20px rgba(250,204,21,0.7),
          0 0 50px rgba(37,99,235,0.6),
          inset 0 0 15px rgba(15,23,42,0.9);
        position: relative;
        overflow: hidden;
      }
      header .logo-text {
        display: flex;
        flex-direction: column;
      }
      header .logo-text span:first-child {
        font-weight: 700;
        letter-spacing: 0.08em;
        font-size: 13px;
        text-transform: uppercase;
        color: #e5e7eb;
      }
      header .logo-text span:last-child {
        font-size: 11px;
        color: #9ca3af;
      }
      .tabs {
        display: flex;
        gap: 8px;
      }
      .tab {
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,184,0.5);
        color: #e5e7eb;
        text-decoration: none;
        background: rgba(15,23,42,0.6);
      }
      .tab.active {
        background: rgba(37,99,235,0.7);
        border-color: rgba(129,140,248,0.9);
      }
      main {
        padding: 16px;
        max-width: 900px;
        margin: 0 auto;
      }
      h2 {
        margin-bottom: 10px;
        font-size: 18px;
      }
      form {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
      }
      label {
        font-size: 13px;
        color: #e5e7eb;
      }
      textarea {
        width: 100%;
        min-height: 60px;
        border-radius: 8px;
        border: 1px solid rgba(55,65,81,0.9);
        background: rgba(15,23,42,0.9);
        color: #e5e7eb;
        padding: 8px;
        font-size: 13px;
      }
      .field {
        margin-bottom: 8px;
      }
      button {
        padding: 8px 14px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(to right, #22c55e, #16a34a);
        color: white;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 30px rgba(22,163,74,0.8);
      }
      button:hover {
        background: linear-gradient(to right, #16a34a, #15803d);
      }
      .quick-replies-label {
        font-size: 12px;
        color: #9ca3af;
        margin-top: -4px;
      }
    </style>
  </head>
  <body>
    <header>
      <div class="logo">
        <div class="logo-icon"></div>
        <div class="logo-text">
          <span>IRON GLASS</span>
          <span>Configuração de mensagens</span>
        </div>
      </div>
      <div class="tabs">
        <a href="/admin?tab=chat" class="tab">Conversas</a>
        <a href="/admin?tab=config" class="tab active">Configuração</a>
        <a href="/admin?tab=program" class="tab">Programados</a>
          <a href="/admin?tab=calendar" class="tab">Calendário</a>
      </div>
    </header>
    <main>
      <h2>Mensagens de follow-up e pós-venda</h2>
      <form method="POST" action="/config">
        <div class="field">
          <label>1º follow-up (4h)</label>
          <textarea name="step0">${String(msg.step0 || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>2º follow-up (3 dias)</label>
          <textarea name="step1">${String(msg.step1 || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>3º follow-up (7 dias)</label>
          <textarea name="step2">${String(msg.step2 || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>4º follow-up (15 dias)</label>
          <textarea name="step3">${String(msg.step3 || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>Mensagem extra (após 15 dias / a cada 30 dias)</label>
          <textarea name="extra">${String(msg.extra || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>Mensagem de pós-venda (30 dias)</label>
          <textarea name="postSale30">${String(msg.postSale30 || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>Prefixo para lembrete de agenda</label>
          <textarea name="agendaPrefix">${String(msg.agendaPrefix || '')
            .replace(/</g, '&lt;')}</textarea>
        </div>
        <div class="field">
          <label>Respostas rápidas (uma por linha)</label>
          <textarea name="quickReplies">${quickRepliesText
            .replace(/</g, '&lt;')}</textarea>
          <div class="quick-replies-label">
            Essas respostas aparecem como botões rápidos no chat (apenas para você).
          </div>
        </div>
        <button type="submit">Salvar mensagens</button>
      </form>
    </main>
  </body>
  </html>
  `;

  res.send(html);
}

function renderProgramPage(req, res) {
  const entries = Object.entries(scheduledStarts || {})
    .map(([jid, data]) => {
      return {
        jid,
        at: data.at,
        text: data.text || '',
      };
    })
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  const listHtml = entries
    .map(
      (e) => `
    <tr>
      <td>${e.jid}</td>
      <td>${e.at ? new Date(e.at).toLocaleString('pt-BR') : '-'}</td>
      <td>${(e.text || '').replace(/</g, '&lt;')}</td>
      <td>
        <form method="POST" action="/program/cancel" style="display:inline;">
          <input type="hidden" name="jid" value="${e.jid}" />
          <button type="submit">Cancelar</button>
        </form>
      </td>
    </tr>
  `
    )
    .join('');

  const html = `
  <!DOCTYPE html>
  <html lang="pt-br">
  <head>
    <meta charset="UTF-8" />
    <title>Iron Glass - Programados</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #111827, #020617, #000);
        color: #e5e7eb;
        margin: 0;
        padding: 0;
      }
      header {
        padding: 12px 20px;
        border-bottom: 1px solid rgba(148,163,184,0.2);
        display: flex;
        align-items: center;
        justify-content: space-between;
        backdrop-filter: blur(12px);
        background: linear-gradient(to right, rgba(15,23,42,0.95), rgba(30,64,175,0.6));
        box-shadow: 0 15px 45px rgba(15,23,42,0.8);
      }
      header .logo {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      header .logo-icon {
        width: 34px;
        height: 34px;
        border-radius: 12px;
        background: radial-gradient(circle at 30% 20%, #facc15, #f97316 40%, #0f172a 75%, #020617 100%);
        box-shadow:
          0 0 20px rgba(250,204,21,0.7),
          0 0 50px rgba(37,99,235,0.6),
          inset 0 0 15px rgba(15,23,42,0.9);
        position: relative;
        overflow: hidden;
      }
      header .logo-text {
        display: flex;
        flex-direction: column;
      }
      header .logo-text span:first-child {
        font-weight: 700;
        letter-spacing: 0.08em;
        font-size: 13px;
        text-transform: uppercase;
        color: #e5e7eb;
      }
      header .logo-text span:last-child {
        font-size: 11px;
        color: #9ca3af;
      }
      .tabs {
        display: flex;
        gap: 8px;
      }
      .tab {
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,184,0.5);
        color: #e5e7eb;
        text-decoration: none;
        background: rgba(15,23,42,0.6);
      }
      .tab.active {
        background: rgba(37,99,235,0.7);
        border-color: rgba(129,140,248,0.9);
      }
      main {
        padding: 16px;
        max-width: 900px;
        margin: 0 auto;
      }
      h2 {
        margin-bottom: 10px;
        font-size: 18px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 12px;
      }
      th, td {
        border: 1px solid rgba(55,65,81,0.8);
        padding: 6px 8px;
        font-size: 12px;
      }
      th {
        background: rgba(15,23,42,0.9);
      }
      button {
        padding: 4px 10px;
        border-radius: 999px;
        border: none;
        background: linear-gradient(to right, #ef4444, #b91c1c);
        color: white;
        font-size: 11px;
        cursor: pointer;
      }
      button:hover {
        background: linear-gradient(to right, #b91c1c, #7f1d1d);
      }
      input[type="text"], input[type="datetime-local"], textarea {
        width: 100%;
        border-radius: 8px;
        border: 1px solid rgba(55,65,81,0.9);
        background: rgba(15,23,42,0.9);
        color: #e5e7eb;
        padding: 6px;
        font-size: 12px;
        margin-bottom: 6px;
      }
      textarea {
        min-height: 60px;
      }
      .form-row {
        display: grid;
        grid-template-columns: 1.2fr 1fr;
        gap: 10px;
      }
      .form-row > div {
        display: flex;
        flex-direction: column;
      }
      label {
        font-size: 12px;
        margin-bottom: 4px;
      }
      .submit-row {
        margin-top: 8px;
      }
      .info {
        font-size: 11px;
        color: #9ca3af;
        margin-top: 6px;
      }
    </style>
  </head>
  <body>
    <header>
      <div class="logo">
        <div class="logo-icon"></div>
        <div class="logo-text">
          <span>IRON GLASS</span>
          <span>Mensagens programadas</span>
        </div>
      </div>
      <div class="tabs">
        <a href="/admin?tab=chat" class="tab">Conversas</a>
        <a href="/admin?tab=config" class="tab">Configuração</a>
        <a href="/admin?tab=program" class="tab active">Programados</a>
          <a href="/admin?tab=calendar" class="tab">Calendário</a>
      </div>
    </header>
    <main>
      <h2>Programar mensagem inicial para um contato</h2>
      <form method="POST" action="/program">
        <div class="form-row">
          <div>
            <label>Número WhatsApp (com DDD e país, ex: 5599999999999)</label>
            <input type="text" name="jid" required />
          </div>
          <div>
            <label>Data e horário para envio</label>
            <input type="datetime-local" name="at" required />
          </div>
        </div>
        <div>
          <label>Mensagem a ser enviada</label>
          <textarea name="text" required></textarea>
        </div>
        <div class="submit-row">
          <button type="submit">Programar mensagem</button>
        </div>
        <div class="info">
          Após a mensagem programada ser enviada, o contato entra automaticamente no funil normal (4h, 3, 7, 15 dias).
        </div>
      </form>

      <h2>Mensagens programadas ativas</h2>
      <table>
        <thead>
          <tr>
            <th>Contato</th>
            <th>Data / hora</th>
            <th>Mensagem</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          ${
            listHtml || '<tr><td colspan="4">Nenhuma mensagem programada.</td></tr>'
          }
        </tbody>
      </table>
    </main>
  </body>
  </html>
  `;

  res.send(html);
}


function renderCalendarPage(req, res) {
  const html = `
  <!DOCTYPE html>
  <html lang="pt-br">
  <head>
    <meta charset="UTF-8" />
    <title>Iron Glass - Calendário</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #111827, #020617, #000);
        color: #e5e7eb;
        margin: 0;
        min-height: 100vh;
      }
      header {
        padding: 12px 20px;
        background: linear-gradient(to right, rgba(15,23,42,0.95), rgba(30,64,175,0.6));
        box-shadow: 0 15px 45px rgba(15,23,42,0.8);
        position: sticky;
        top: 0;
        z-index: 10;
      }
      header .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .logo { display: flex; align-items: center; gap: 10px; }
      .logo-icon { width: 34px; height: 34px; border-radius: 12px; background: radial-gradient(circle at top left, rgba(59,130,246,0.9), rgba(30,64,175,0.3)); box-shadow: 0 10px 25px rgba(37,99,235,0.35); }
      .logo-text span:first-child { font-weight: 800; letter-spacing: 0.12em; font-size: 14px; display:block; }
      .logo-text span:last-child { color: #93c5fd; font-size: 12px; display:block; margin-top:-2px; }
      .tabs { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .tab {
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(55,65,81,0.7);
        color: #e5e7eb;
        text-decoration: none;
        background: rgba(15,23,42,0.55);
        font-size: 13px;
      }
      .tab.active {
        background: rgba(37,99,235,0.7);
        border-color: rgba(129,140,248,0.9);
      }
      main { max-width: 1100px; margin: 0 auto; padding: 16px; display: grid; grid-template-columns: 1fr; gap: 14px; }
      .card {
        border: 1px solid rgba(55,65,81,0.75);
        background: rgba(2,6,23,0.72);
        border-radius: 14px;
        padding: 14px;
        box-shadow: 0 18px 55px rgba(0,0,0,0.35);
      }
      h2 { margin: 0 0 10px; font-size: 16px; }
      .muted { color: #9ca3af; font-size: 12px; }
      label { display:block; font-size: 12px; color: #cbd5e1; margin: 8px 0 6px; }
      input, textarea, select {
        width: 100%;
        border-radius: 10px;
        border: 1px solid rgba(55,65,81,0.9);
        background: rgba(15,23,42,0.9);
        color: #e5e7eb;
        padding: 10px;
        font-size: 13px;
      }
      textarea { min-height: 110px; resize: vertical; }
      .row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
      .row2 { display:grid; grid-template-columns: 2fr 1fr 1fr; gap:10px; }
      .row3 { display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; }
      @media (max-width: 980px) { .row{grid-template-columns: repeat(2, 1fr);} .row2{grid-template-columns: 1fr;} .row3{grid-template-columns: 1fr;} }
      .btn {
        margin-top: 10px;
        background: linear-gradient(to right, #2563eb, #1d4ed8);
        border: 1px solid rgba(96,165,250,0.35);
        color: white;
        padding: 10px 14px;
        border-radius: 12px;
        cursor: pointer;
        font-weight: 700;
      }
      .btn.secondary {
        background: rgba(15,23,42,0.85);
        border-color: rgba(55,65,81,0.9);
        font-weight: 600;
      }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { padding: 10px 8px; border-bottom: 1px solid rgba(55,65,81,0.65); font-size: 13px; text-align: left; vertical-align: top; }
      th { color: #93c5fd; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; }
      .tag { display:inline-block; padding: 4px 8px; border-radius: 999px; border:1px solid rgba(55,65,81,0.7); background: rgba(15,23,42,0.6); font-size: 12px; color:#e5e7eb; }
      .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      @media (max-width: 980px) { .grid2{grid-template-columns: 1fr;} }
      .vars code { background: rgba(15,23,42,0.85); border:1px solid rgba(55,65,81,0.8); padding: 2px 6px; border-radius: 8px; }
    </style>
  </head>
  <body>
    <header>
      <div class="top">
        <div class="logo">
          <div class="logo-icon"></div>
          <div class="logo-text">
            <span>IRON GLASS</span>
            <span>Calendário e Templates</span>
          </div>
        </div>
        <div class="muted" id="conn">Status: ...</div>
      </div>
      <div class="tabs">
        <a href="/admin?tab=chat" class="tab">Conversas</a>
        <a href="/admin?tab=config" class="tab">Configuração</a>
        <a href="/admin?tab=program" class="tab">Programados</a>
        <a href="/admin?tab=calendar" class="tab active">Calendário</a>
      </div>
    </header>

    <main>
      <div class="grid2">
        <div class="card">
          <h2>✅ Confirmação de agenda (enviar agora + criar lembretes)</h2>
          <div class="muted">Preencha os dados e o bot envia a confirmação usando o template + agenda lembretes (7/3/1).</div>

          <div class="row2">
            <div>
              <label>Número do cliente</label>
              <input id="a_phone" placeholder="Ex: 5511999999999" />
            </div>
            <div>
              <label>Dia (dd/mm/aaaa)</label>
              <input id="a_date" placeholder="20/12/2025" />
            </div>
            <div>
              <label>Hora (hh:mm)</label>
              <input id="a_time" placeholder="14:30" />
            </div>
          </div>

          <div class="row">
            <div>
              <label>Veículo</label>
              <input id="a_vehicle" placeholder="Ex: BYD SONG" />
            </div>
            <div>
              <label>Produto</label>
              <input id="a_product" placeholder="Ex: Iron Glass Plus" />
            </div>
            <div>
              <label>Valor total</label>
              <input id="a_value" placeholder="Ex: R$ 12.900,00" />
            </div>
            <div>
              <label>Sinal recebido</label>
              <input id="a_deposit" placeholder="Ex: R$ 1.075,00" />
            </div>
            <div>
              <label>Forma de pagamento</label>
              <input id="a_payment" placeholder="Ex: PIX confirmado" />
            </div>
            <div>
              <label>Endereço</label>
              <input id="a_address" placeholder="Ex: R. Prof. Atílio Innocenti, 910" />
            </div>
          </div>

          <label>Observações (opcional)</label>
          <input id="a_notes" placeholder="Ex: Box 12, Shopping X" />

          <button class="btn" onclick="sendAgendaConfirm()">Enviar confirmação + programar lembretes</button>
          <button class="btn secondary" onclick="cancelAgenda()">Cancelar agenda deste número</button>

          <div class="vars muted" style="margin-top:10px">
            Variáveis do template: 
            <code>{{DATA}}</code> <code>{{HORA}}</code> <code>{{VEICULO}}</code> <code>{{PRODUTO}}</code> <code>{{VALOR}}</code> <code>{{SINAL}}</code> <code>{{PAGAMENTO}}</code> <code>{{ENDERECO}}</code> <code>{{DIAS}}</code>
          </div>
        </div>

        <div class="card">
          <h2>✍️ Templates de mensagens</h2>
          <div class="muted">Edite e salve. O bot usa esses textos para confirmação, lembretes e pós-venda.</div>

          <label>Template: Confirmação de agenda</label>
          <textarea id="tpl_confirm"></textarea>

          <label>Template: Seguimento/lembrte de agenda (7/3/1)</label>
          <textarea id="tpl_reminder"></textarea>

          <label>Template: Pós-venda (30 dias)</label>
          <textarea id="tpl_post"></textarea>

          <button class="btn" onclick="saveTemplates()">Salvar templates</button>
        </div>
      </div>

      <div class="card">
        <h2>📅 Calendário (agenda + lembretes + pós-venda)</h2>
        <div class="row3">
          <div>
            <label>De (opcional)</label>
            <input id="f_from" placeholder="2025-12-01" />
          </div>
          <div>
            <label>Até (opcional)</label>
            <input id="f_to" placeholder="2026-01-31" />
          </div>
          <div style="display:flex; align-items:end; gap:10px;">
            <button class="btn" onclick="loadCalendar()">Atualizar calendário</button>
            <button class="btn secondary" onclick="loadTemplates()">Recarregar templates</button>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Tipo</th>
              <th>Contato</th>
              <th>Detalhes</th>
            </tr>
          </thead>
          <tbody id="cal_body">
            <tr><td colspan="4" class="muted">Carregando…</td></tr>
          </tbody>
        </table>
      </div>
    </main>

    <script>
      async function api(path, opts) {
        const res = await fetch(path, opts || {});
        const txt = await res.text();
        let json = null;
        try { json = JSON.parse(txt); } catch(e) {}
        if (!res.ok) throw new Error((json && json.error) ? json.error : txt);
        return json || {};
      }

      async function loadTemplates() {
        const cfg = await api('/api/templates');
        document.getElementById('tpl_confirm').value = cfg.agendaConfirmTemplate || '';
        document.getElementById('tpl_reminder').value = cfg.agendaReminderTemplate || '';
        document.getElementById('tpl_post').value = cfg.postSaleTemplate || cfg.postSale30 || '';
      }

      async function saveTemplates() {
        const body = {
          agendaConfirmTemplate: document.getElementById('tpl_confirm').value,
          agendaReminderTemplate: document.getElementById('tpl_reminder').value,
          postSaleTemplate: document.getElementById('tpl_post').value
        };
        await api('/api/templates', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        alert('Templates salvos ✅');
      }

      async function sendAgendaConfirm() {
        const payload = {
          phone: document.getElementById('a_phone').value,
          date: document.getElementById('a_date').value,
          time: document.getElementById('a_time').value,
          vehicle: document.getElementById('a_vehicle').value,
          product: document.getElementById('a_product').value,
          value: document.getElementById('a_value').value,
          deposit: document.getElementById('a_deposit').value,
          payment: document.getElementById('a_payment').value,
          address: document.getElementById('a_address').value,
          notes: document.getElementById('a_notes').value
        };
        await api('/api/agenda/confirm', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload)
        });
        alert('Confirmação enviada + lembretes criados ✅');
        await loadCalendar();
      }

      async function cancelAgenda() {
        const phone = document.getElementById('a_phone').value;
        if (!phone) return alert('Informe o número');
        await api('/api/agenda/cancel', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ phone })
        });
        alert('Agenda cancelada ✅');
        await loadCalendar();
      }

      function typeLabel(t) {
        if (t === 'AGENDA') return '📅 Agenda';
        if (t === 'AGENDA_REMINDER') return '📌 Lembrete agenda';
        if (t === 'POSVENDA') return '🧾 Pós-venda';
        if (t === 'FUNIL') return '🔁 Funil';
        if (t === 'PROGRAMADO') return '⏱️ Programado';
        return t;
      }

      async function loadCalendar() {
        const from = document.getElementById('f_from').value.trim();
        const to = document.getElementById('f_to').value.trim();
        const qs = new URLSearchParams();
        if (from) qs.set('from', from);
        if (to) qs.set('to', to);
        const data = await api('/api/calendar' + (qs.toString() ? ('?' + qs.toString()) : ''));
        const tbody = document.getElementById('cal_body');
        if (!data.events || data.events.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="muted">Sem eventos no período.</td></tr>';
          return;
        }
        tbody.innerHTML = data.events.map(ev => {
          const det = ev.details || {};
          const detailText = [
            det.VEICULO || det.veiculo ? ('🚗 ' + (det.VEICULO || det.veiculo)) : '',
            det.PRODUTO || det.produto ? ('🛡️ ' + (det.PRODUTO || det.produto)) : '',
            det.ENDERECO || det.endereco ? ('📍 ' + (det.ENDERECO || det.endereco)) : '',
            ev.daysBefore != null ? ('⏳ ' + ev.daysBefore + ' dia(s)') : '',
            det.notes ? ('📝 ' + det.notes) : ''
          ].filter(Boolean).join(' | ');
          const when = new Date(ev.at).toLocaleString('pt-BR');
          return '<tr>' +
            '<td>' + when + '</td>' +
            '<td><span class="tag">' + typeLabel(ev.type) + '</span></td>' +
            '<td>' + ev.jid + '</td>' +
            '<td>' + (detailText || (ev.text || '')) + '</td>' +
          '</tr>';
        }).join('');
      }

      (async () => {
        try {
          const st = await api('/api/status');
          document.getElementById('conn').innerText = 'Status: ' + (st.connected ? 'WhatsApp conectado ✅' : 'Desconectado ⚠️');
        } catch(e) {}
        await loadTemplates();
        await loadCalendar();
      })();
    </script>
  </body>
  </html>
  `;
  res.send(html);
}

// =================== ROTAS AUXILIARES ===================

app.get('/chats/:jid', (req, res) => {
  const jid = req.params.jid;
  const chat = chatStore[jid] || { jid, messages: [], unread: 0, lastMessageAt: 0, pinned: false, name: jid };

  // Evita travar o navegador: por padrão, devolve só os últimos N itens
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit || 400)));
  const msgs = Array.isArray(chat.messages) ? chat.messages : [];
  const start = Math.max(0, msgs.length - limit);
  const slice = msgs.slice(start);

  res.json({
    jid: chat.jid,
    name: chat.name || chat.jid,
    unread: Number(chat.unread || 0),
    lastMessageAt: chat.lastMessageAt || 0,
    pinned: chat.pinned === true,
    messages: slice,
    totalMessages: msgs.length
  });
});

app.post('/chats/:jid/read', (req, res) => {
  const jid = req.params.jid;
  markChatRead(jid);
  res.json({ ok: true });
});


app.get('/api/chats', (req, res) => {
  const metas = Object.values(chatStore || {}).map((c) => {
    const lastMsg = (c.messages && c.messages.length) ? c.messages[c.messages.length - 1].text : '';
    return {
      jid: c.jid,
      name: c.name || c.jid,
      unread: Number(c.unread || 0),
      lastMessageAt: c.lastMessageAt || 0,
      lastMessage: lastMsg || '',
      pinned: c.pinned === true,
    };
  });
  metas.sort((a, b) => {
    if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0);
  });
  res.json({ ok: true, chats: metas });
});


app.post('/send', async (req, res) => {
  try {
    // Acepta ambos nombres por si el front manda "message" o "text"
    const rawJid = String(req.body.jid || req.body.to || '').trim();
    const text = String(req.body.text ?? req.body.message ?? '').trim();

    if (!rawJid || !text) return res.status(400).json({ ok: false, error: 'missing_jid_or_text' });

    // Normaliza JID (si viene solo número)
    const jid = rawJid.includes('@') ? rawJid : `${rawJid.replace(/\D/g, '')}@s.whatsapp.net`;

    // 1) ENVÍA por WhatsApp
    await safeSendText(jid, text);

    // 2) GUARDA en historial del panel (esto es lo que te falta)
    //    Lo guardamos como "fromMe: true"
    upsertChatMessage(jid, true, text, Date.now());

    // (Opcional) marca como leído en el panel (para que no quede unread raro)
    // markChatRead(jid);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[SEND] Error:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'send_failed' });
  }
});




app.post('/api/chat/pin', (req, res) => {
  try {
    const body = req.body || {};
    const jid = String(body.jid || '').trim();
    const pinned = !!body.pinned;
    if (!jid) return res.status(400).json({ error: 'jid inválido' });

    const chat = ensureChat(jid);
    chat.pinned = pinned;
    saveChats();

    const lastMsg = (chat.messages && chat.messages.length) ? chat.messages[chat.messages.length - 1].text : '';
    const meta = {
      jid: chat.jid,
      name: chat.name || chat.jid,
      unread: chat.unread || 0,
      lastMessageAt: chat.lastMessageAt || Date.now(),
      lastMessage: lastMsg || '',
      pinned: chat.pinned === true,
    };
    sseBroadcast({ type: 'chat', jid: chat.jid, meta });
    return res.json(meta);
  } catch (e) {
    return res.status(500).json({ error: 'erro ao pin' });
  }
});

app.get('/api/templates', (req, res) => {
  // Retorna templates atuais (com fallback para defaults)
  const cfg = messagesConfig || defaultMessages();
  res.json({
    agendaConfirmTemplate: cfg.agendaConfirmTemplate || defaultMessages().agendaConfirmTemplate,
    agendaReminderTemplate: cfg.agendaReminderTemplate || defaultMessages().agendaReminderTemplate,
    postSaleTemplate: cfg.postSaleTemplate || cfg.postSale30 || defaultMessages().postSale30,
    postSale30: cfg.postSale30 || defaultMessages().postSale30,
  });
});

app.post('/api/templates', (req, res) => {
  const body = req.body || {};
  messagesConfig = messagesConfig || defaultMessages();

  if (typeof body.agendaConfirmTemplate === 'string') {
    messagesConfig.agendaConfirmTemplate = body.agendaConfirmTemplate;
  }
  if (typeof body.agendaReminderTemplate === 'string') {
    messagesConfig.agendaReminderTemplate = body.agendaReminderTemplate;
  }
  if (typeof body.postSaleTemplate === 'string') {
    messagesConfig.postSaleTemplate = body.postSaleTemplate;
    // compat: também atualiza postSale30
    messagesConfig.postSale30 = body.postSaleTemplate;
  }

  saveMessages();
  res.json({ ok: true });
});

function parseBRDateTime(dateStr, timeStr) {
  const m = String(dateStr || '').match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (!m) return null;
  let dd = parseInt(m[1], 10);
  let mm = parseInt(m[2], 10);
  let yy = parseInt(m[3], 10);
  if (yy < 100) yy += 2000;

  let hh = 9, mi = 0;
  const t = String(timeStr || '').match(/(\d{1,2})\s*[:h]\s*(\d{2})/i);
  if (t) {
    hh = parseInt(t[1], 10);
    mi = parseInt(t[2], 10);
  }
  const dt = new Date(yy, mm - 1, dd, hh, mi, 0, 0);
  return dt.getTime();
}

app.post('/api/agenda/confirm', async (req, res) => {
  try {
    if (!sock) return res.status(500).json({ error: 'WhatsApp não inicializado' });

    const b = req.body || {};
    const jid = normalizeToJid(b.phone);
    if (!jid) return res.status(400).json({ error: 'Número inválido' });

    const ts = parseBRDateTime(b.date, b.time);
    if (!ts) return res.status(400).json({ error: 'Data inválida. Use dd/mm/aaaa' });

    const details = {
      VEICULO: b.vehicle || '',
      PRODUTO: b.product || '',
      VALOR: b.value || '',
      SINAL: b.deposit || '',
      PAGAMENTO: b.payment || '',
      ENDERECO: b.address || '',
      notes: b.notes || '',
    };

    // Envia confirmação usando template
    const vars = {
      DATA: formatBRDate(ts),
      HORA: formatBRTime(ts),
      VEICULO: details.VEICULO,
      PRODUTO: details.PRODUTO,
      VALOR: details.VALOR,
      SINAL: details.SINAL,
      PAGAMENTO: details.PAGAMENTO,
      ENDERECO: details.ENDERECO,
      DIAS: '',
    };

    const tpl =
      messagesConfig.agendaConfirmTemplate ||
      defaultMessages().agendaConfirmTemplate;

    const msg = renderTemplate(tpl, vars).trim();
    if (!msg) return res.status(400).json({ error: 'Template de confirmação está vazio' });

    await sendText(jid, msg);

    // Guarda detalhes + cria lembretes
    scheduleAgenda(jid, ts, details);

    // Também registra no painel
    upsertChatMessage(jid, true, msg, Date.now());

    res.json({ ok: true });
  } catch (e) {
    console.error('Erro /api/agenda/confirm:', e);
    res.status(500).json({ error: 'Falha ao confirmar agenda' });
  }
});

app.post('/api/agenda/cancel', (req, res) => {
  const b = req.body || {};
  const jid = normalizeToJid(b.phone || b.jid);
  if (!jid) return res.status(400).json({ error: 'Número inválido' });

  delete agendas[jid];
  saveAgendas();
  res.json({ ok: true });
});

app.get('/api/calendar', (req, res) => {
  const from = String(req.query.from || '').trim(); // YYYY-MM-DD
  const to = String(req.query.to || '').trim();

  let fromTs = null, toTs = null;
  if (from) {
    const m = from.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) fromTs = new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]), 0,0,0,0).getTime();
  }
  if (to) {
    const m = to.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) toTs = new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]), 23,59,59,999).getTime();
  }

  const events = [];

  // Agenda + lembretes
  for (const [jid, raw] of Object.entries(agendas || {})) {
    const c = getAgendaContainer(jid);
    if (!c) continue;

    if (c.appointmentTs) {
      events.push({
        type: 'AGENDA',
        at: c.appointmentTs,
        jid,
        details: c.details || {},
      });
    }
    for (const r of (c.reminders || [])) {
      events.push({
        type: 'AGENDA_REMINDER',
        at: r.at,
        jid,
        daysBefore: r.daysBefore,
        details: c.details || {},
      });
    }
  }

  // Funil / pós-venda (próximo envio)
  for (const [jid, c] of Object.entries(clients || {})) {
    if (!c || !c.nextFollowUpAt) continue;
    const type = c.isClient ? 'POSVENDA' : 'FUNIL';
    events.push({
      type,
      at: c.nextFollowUpAt,
      jid,
      details: {},
      text: c.isClient ? 'Mensagem de pós-venda agendada' : ('Próximo follow-up (etapa ' + (c.stepIndex || 0) + ')'),
    });
  }

  // Programados (mensagem inicial)
  for (const [jid, p] of Object.entries(programados || {})) {
    if (!p || !p.at) continue;
    events.push({
      type: 'PROGRAMADO',
      at: p.at,
      jid,
      text: p.text || '',
      details: {},
    });
  }

  // filtro
  const filtered = events.filter(ev => {
    if (fromTs && ev.at < fromTs) return false;
    if (toTs && ev.at > toTs) return false;
    return true;
  }).sort((a,b) => a.at - b.at);

  res.json({ events: filtered });
});


app.post('/config', (req, res) => {
  const body = req.body || {};
  messagesConfig.step0 = body.step0 || messagesConfig.step0;
  messagesConfig.step1 = body.step1 || messagesConfig.step1;
  messagesConfig.step2 = body.step2 || messagesConfig.step2;
  messagesConfig.step3 = body.step3 || messagesConfig.step3;
  messagesConfig.extra = body.extra || messagesConfig.extra;
  messagesConfig.postSale30 = body.postSale30 || messagesConfig.postSale30;
  messagesConfig.agendaPrefix = body.agendaPrefix || messagesConfig.agendaPrefix;
  messagesConfig.quickReplies = (body.quickReplies || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  saveMessages();
  res.redirect('/admin?tab=config');
});

app.post('/program', (req, res) => {
  const { jid, at, text } = req.body || {};
  if (!jid || !at || !text) {
    return res.status(400).send('Campos obrigatórios faltando');
  }

  const normalized = jid.replace(/\D/g, '') + '@s.whatsapp.net';
  const ts = new Date(at).getTime();
  if (isNaN(ts)) {
    return res.status(400).send('Data/hora inválida');
  }

  scheduledStarts[normalized] = {
    at: ts,
    text: text.trim(),
  };
  saveProgramados();

  console.log(
    '[PROGRAM] Mensagem inicial programada para',
    normalized,
    'em',
    new Date(ts).toISOString()
  );

  res.redirect('/admin?tab=program');
});

app.post('/program/cancel', (req, res) => {
  const { jid } = req.body || {};
  if (jid && scheduledStarts[jid]) {
    delete scheduledStarts[jid];
    saveProgramados();
    scheduledQueue.delete(jid);
    console.log('[PROGRAM] Cancelada mensagem programada para', jid);
  }
  res.redirect('/admin?tab=program');
});

// =================== BEEP LOOP (NODE) ===================

let beepLoop = null;
let sendingNow = false;

function playBeep() {
  // Som real é no front-end (<audio>); aqui é apenas placeholder.
}

function startBeepLoop() {
  if (beepLoop) return;
  beepLoop = setInterval(() => {
    if (!hasUnread()) {
      stopBeepLoop();
      return;
    }
    playBeep();
  }, 5000);
}

function stopBeepLoop() {
  if (beepLoop) {
    clearInterval(beepLoop);
    beepLoop = null;
  }
}

function updateBeepLoop() {
  if (hasUnread()) startBeepLoop();
  else stopBeepLoop();
}

// =================== AGENDA & PROGRAMADOS HELPERS ===================


function scheduleAgenda(jid, appointmentTs, details = {}) {
  const reminders = AGENDA_OFFSETS_DAYS.map((daysBefore) => {
    const at = appointmentTs - daysBefore * DAY_MS;
    const key = `${appointmentTs}-${daysBefore}`;
    return { at, key, daysBefore, appointmentTs };
  }).filter((r) => r.at > Date.now());

  const prev = getAgendaContainer(jid) || { reminders: [], details: {}, appointmentTs: null };
  const mergedDetails = { ...(prev.details || {}), ...(details || {}) };

  const container = {
    appointmentTs,
    details: mergedDetails,
    reminders,
  };

  setAgendaContainer(jid, container);


  // Atualiza status do cliente e agenda início do pós-venda (+30 dias após a instalação)
  try {
    const c = clients[jid] || {};
    c.appointmentTs = appointmentTs;
    c.agendaConfirmedAt = Date.now();
    c.postSaleStartAt = appointmentTs + 30 * DAY_MS;
    clients[jid] = c;
    saveClients();
    // Para de enviar funil automaticamente após confirmar agenda
    stopFollowUp(jid);
  } catch (_) {}

  console.log(
    '[AGENDA] Criada agenda para',
    jid,
    '->',
    new Date(appointmentTs).toISOString()
  );
}

function cancelAgenda(jid) {
  if (agendas[jid]) {
    delete agendas[jid];
    saveAgendas();
  }
  console.log('[AGENDA] Agenda cancelada (fila limpa) para', jid);
}

// =================== SCHEDULER ===================

function startScheduleChecker() {
  if (DISABLE_AUTOMATION) return;
  setInterval(() => {
    const now = Date.now();

    // funil
    for (const [jid, c] of Object.entries(clients)) {
      if (blocked[jid]) continue;
      if (paused[jid]) continue;
      if (isGroupJid(jid)) continue;
      if (!c.nextFollowUpAt) continue;
      if (now >= c.nextFollowUpAt) {
        const already = messageQueue.some(
          (m) => m.jid === jid && m.kind === 'funil'
        );
        if (!already) {
          messageQueue.push({ jid, kind: 'funil' });
          console.log('[QUEUE] Funil enfileirado para', jid);
        }
      }
    }


    // pós-venda (início automático 30 dias após agenda)
    for (const [jid, c] of Object.entries(clients)) {
      if (blocked[jid]) continue;
      if (paused[jid]) continue;
      if (isGroupJid(jid)) continue;
      if (!c.postSaleStartAt) continue;
      if (now >= c.postSaleStartAt) {
        console.log('[POS] Iniciando pós-venda automático para', jid);
        startPostSaleMonthly(jid);
        delete c.postSaleStartAt;
        saveClients();
      }
    }

    // agenda
    for (const [jid, arr] of Object.entries(agendas)) {
      if (isGroupJid(jid)) continue;
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (now >= item.at) {
          const already = messageQueue.some(
            (m) => m.jid === jid && m.kind === 'agenda' && m.key === item.key
          );
          if (!already) {
            messageQueue.push({ jid, kind: 'agenda', key: item.key });
            console.log('[QUEUE] Agenda enfileirada para', jid, item.key);
          }
        }
      }
    }

    // mensagens iniciais programadas
    for (const [jid, s] of Object.entries(scheduledStarts || {})) {
      if (isGroupJid(jid)) continue;
      if (!s || !s.at) continue;

      if (now >= s.at) {
        const already = messageQueue.some(
          (m) => m.jid === jid && m.kind === 'startFunil'
        );
        if (!already && !scheduledQueue.has(jid)) {
          messageQueue.push({ jid, kind: 'startFunil' });
          scheduledQueue.add(jid);
          console.log('[QUEUE] Mensagem inicial programada enfileirada para', jid);
        }
      }
    }
  }, 60 * 1000);
}

function startMessageSender() {
  if (DISABLE_AUTOMATION) return;

  setInterval(async () => {
    if (sendingNow) return;
    const item = messageQueue.shift();
    if (!item) return;

    if (!isConnected) {
      messageQueue.unshift(item);
      return;
    }

    const now = Date.now();
    if (!isInsideWindow(now)) {
      messageQueue.push(item);
      return;
    }

    sendingNow = true;
    const jitterMs = 8000 + Math.floor(Math.random() * 90000);
    await new Promise((r) => setTimeout(r, jitterMs));

    try {
      const { jid, kind, key } = item;

      if (isGroupJid(jid)) {
        console.log('[SKIP] Ignorando grupo (sem automação):', jid);
        if (clients[jid]) { delete clients[jid]; saveClients(); }
        if (agendas[jid]) { delete agendas[jid]; saveAgendas(); }
        if (paused[jid]) { delete paused[jid]; savePaused(); }
        if (scheduledStarts[jid]) { delete scheduledStarts[jid]; saveProgramados(); }
        scheduledQueue.delete(jid);
        return;
      }

      if (kind === 'funil') {
        const c = clients[jid];
        if (!c) {
          sendingNow = false;
          return;
        }

        let msgKey = 'extra';

        if (c.isClient) {
          msgKey = 'postSale30';
        } else if (
          c.stepIndex >= 0 &&
          c.stepIndex <= STEPS_DAYS.length - 1
        ) {
          msgKey = `step${c.stepIndex}`;
        }

        const texto =
          messagesConfig[msgKey] ||
          (c.isClient ? messagesConfig.postSale30 : null) ||
          messagesConfig.extra ||
          'Olá! Tudo bem?';

        c.ignoreNextFromMe = true;
        saveClients();

        if (!DRY_RUN) {
          await sendText(jid, texto);
        } else {
          console.log('[DRY_RUN] Enviaria para', jid, '->', texto);
        }

        const sentAt = Date.now();
        c.lastContact = sentAt;

        if (c.isClient) {
          c.stepIndex = STEPS_DAYS.length;
          c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
          console.log(
            '[PÓS-VENDA] Follow-up mensal enviado para',
            jid,
            '-> próxima em',
            EXTRA_INTERVAL_DAYS,
            'dias'
          );
        } else if (c.stepIndex === 0) {
          if (STEPS_DAYS.length > 0) {
            c.stepIndex = 1;
            const dias = STEPS_DAYS[0];
            c.nextFollowUpAt = sentAt + dias * DAY_MS;
            console.log(
              '[FUNIL] Follow-up (4h) enviado para',
              jid,
              '-> próxima etapa em',
              dias,
              'dias'
            );
          } else {
            c.stepIndex = 1;
            c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
            console.log(
              '[FUNIL] Follow-up (4h) enviado para',
              jid,
              '-> próxima etapa em',
              EXTRA_INTERVAL_DAYS,
              'dias'
            );
          }
        } else {
          const idx = c.stepIndex;
          if (idx < STEPS_DAYS.length) {
            c.stepIndex += 1;
            const dias = STEPS_DAYS[idx];
            c.nextFollowUpAt = sentAt + dias * DAY_MS;
            console.log(
              '[FUNIL] Follow-up enviado para',
              jid,
              '-> próxima etapa em',
              dias,
              'dias'
            );
          } else {
            c.stepIndex += 1;
            c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
            console.log(
              '[FUNIL] Follow-up enviado para',
              jid,
              '-> agora será a cada',
              EXTRA_INTERVAL_DAYS,
              'dias'
            );
          }
        }

        saveClients();
      }

      if (kind === 'agenda') {
        const arr = agendas[jid];

        if (!Array.isArray(arr)) {
          console.log(
            '[AGENDA] Ignorado lembrete porque agenda não existe mais ->',
            jid
          );
        } else {
          const idx = arr.findIndex((x) => x.key === key);
          if (idx === -1) {
            console.log('[AGENDA] Lembrete não encontrado ->', jid, key);
          } else {
            const itemAgenda = arr[idx];

            // Variáveis para template
            const appointmentTs =
              itemAgenda.appointmentTs ||
              Number(String(itemAgenda.key || '').split('-')[0]) ||
              (container && container.appointmentTs) ||
              null;

            const det = (container && container.details) ? container.details : {};
            const vars = {
              DATA: appointmentTs ? formatBRDate(appointmentTs) : '',
              HORA: appointmentTs ? formatBRTime(appointmentTs) : '',
              DIAS: itemAgenda.daysBefore ?? '',
              VEICULO: det.VEICULO || det.veiculo || '',
              PRODUTO: det.PRODUTO || det.produto || '',
              VALOR: det.VALOR || det.valor || '',
              SINAL: det.SINAL || det.sinal || '',
              PAGAMENTO: det.PAGAMENTO || det.pagamento || '',
              ENDERECO: det.ENDERECO || det.endereco || det.address || '',
            };

            const tpl =
              messagesConfig.agendaReminderTemplate ||
              messagesConfig.agendaPrefix ||
              'Lembrete da sua instalação Iron Glass.';

            const baseMsg = renderTemplate(tpl, vars).trim() || 'Lembrete da sua instalação Iron Glass.';

            if (!DRY_RUN) {
              await sendText(jid, baseMsg);
            } else {
              console.log(
                '[DRY_RUN] Lembrete de agenda para',
                jid,
                '->',
                baseMsg
              );
            }

            arr.splice(idx, 1);
            const cont = getAgendaContainer(jid);
            if (cont && !Array.isArray(cont)) {
              cont.reminders = arr;
              setAgendaContainer(jid, cont);
            } else {
              agendas[jid] = arr;
              saveAgendas();
            }

            console.log('[AGENDA] Lembrete enviado ->', jid, itemAgenda.key);
          }
        }
      }

      if (kind === 'startFunil') {
        const data = scheduledStarts[jid];

        if (!data || !data.at) {
          console.log(
            '[PROGRAM] Nenhum dado encontrado para mensagem programada ->',
            jid
          );
          scheduledQueue.delete(jid);
        } else if (blocked[jid]) {
          console.log(
            '[PROGRAM] Cliente bloqueado; ignorando mensagem programada ->',
            jid
          );
          delete scheduledStarts[jid];
          saveProgramados();
          scheduledQueue.delete(jid);
        } else {
          const texto =
            (data.text && data.text.trim()) ||
            messagesConfig.step0 ||
            'Olá! Tudo bem?';

          if (!DRY_RUN) {
            await sendText(jid, texto);
          } else {
            console.log(
              '[DRY_RUN] Mensagem inicial programada para',
              jid,
              '->',
              texto
            );
          }

          console.log(
            '[PROGRAM] Mensagem inicial programada enviada ->',
            jid
          );

          startFollowUp(jid);

          delete scheduledStarts[jid];
          saveProgramados();
          scheduledQueue.delete(jid);
        }
      }
    } catch (err) {
      console.error('[ERRO] Ao enviar mensagem para', item.jid, err?.message || err);
      messageQueue.unshift(item);
    } finally {
      sendingNow = false;
    }
  }, 60 * 1000);
}

// =================== FUNIL ===================

function startFollowUp(jid) {
  if (blocked[jid]) return;

  const now = Date.now();
  clients[jid] = {
    lastContact: now,
    stepIndex: 0,
    nextFollowUpAt: now + FIRST_STEP_MS,
    ignoreNextFromMe: false,
  };
  console.log(
    '[FUNIL] Iniciado / reiniciado para',
    jid,
    '-> próximo em 4 horas'
  );
  saveClients();
}

function startPostSaleMonthly(jid) {
  if (blocked[jid]) return;

  const now = Date.now();
  const c = clients[jid] || {};

  c.isClient = true;
  c.stepIndex = STEPS_DAYS.length;
  c.lastContact = now;
  c.nextFollowUpAt = now + EXTRA_INTERVAL_DAYS * DAY_MS;
  c.ignoreNextFromMe = false;

  clients[jid] = c;
  saveClients();

  if (paused[jid]) {
    delete paused[jid];
    savePaused();
  }

  console.log(
    '[PÓS-VENDA] Seguimento mensal ativado para',
    jid,
    '-> próxima em',
    EXTRA_INTERVAL_DAYS,
    'dias'
  );
}

function stopFollowUp(jid) {
  if (clients[jid]) {
    delete clients[jid];
    saveClients();
  }
}

function pauseFollowUp(jid) {
  paused[jid] = { pausedAt: Date.now() };
  savePaused();

  messageQueue = messageQueue.filter(
    (item) => !(item.jid === jid && item.kind === 'funil')
  );

  stopFollowUp(jid);
  console.log('[FUNIL] Pausado para', jid);
}

function blockFollowUp(jid, reason = 'STOP') {
  blocked[jid] = { blockedAt: Date.now(), reason };
  saveBlocked();

  pauseFollowUp(jid);
  stopFollowUp(jid);
  cancelAgenda(jid);

  if (scheduledStarts[jid]) {
    delete scheduledStarts[jid];
    saveProgramados();
    scheduledQueue.delete(jid);
  }

  console.log(
    '[BLOCK] Cliente bloqueado de todos os fluxos ->',
    jid,
    'motivo:',
    reason
  );
}

// =================== WHATSAPP HELPERS ===================

async function sendText(jid, text) {
  if (!sock) throw new Error('Socket WhatsApp não está pronto');
  const clean = text.replace(/\n\n+/g, '\n\n').trim();
  const res = await sock.sendMessage(jid, { text: clean });
  botSentRecently.add(jid);
  setTimeout(() => botSentRecently.delete(jid), 5000);
  return res;
}

// =================== WHATSAPP HANDLER ===================

function setupMessageHandler() {
  if (!sock) return;

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;

    let jid = remoteJid;
    if (remoteJid && remoteJid.endsWith('@lid')) {
      const real = msg.key.senderPn || msg.key.participant;
      if (real && real.endsWith('@s.whatsapp.net')) jid = real;
    }

    if (
      !remoteJid ||
      remoteJid === 'status@broadcast' ||
      remoteJid.endsWith('@g.us') || // grupos (ignorar)
      remoteJid.endsWith('@newsletter') ||
      msg.key.remoteJid === 'status@broadcast'
    ) {
      return;
    }

    const body = cleanText(getMsgBody(msg));
    const lower = body.toLowerCase();
    const ts = getMsgMs(msg);

    if (!body) return;

    if (Date.now() - ts > RECENT_WINDOW_MS) {
      console.log('[IGNORADO] Mensagem antiga (replay) de', jid);
      return;
    }

    const c = clients[jid];

    if (fromMe) {
      if (botSentRecently.has(jid)) {
        console.log('[BOT MSG] Ignorada (botSentRecently) ->', jid);
        return;
      }

      if (lower.includes(CMD_STOP)) {
        if (c && c.ignoreNextFromMe) {
          c.ignoreNextFromMe = false;
          saveClients();
        }
        blockFollowUp(jid, 'MANUAL_STOP');
        return;
      }

      if (lower.includes(CMD_PAUSE)) {
        if (c && c.ignoreNextFromMe) {
          c.ignoreNextFromMe = false;
          saveClients();
        }
        pauseFollowUp(jid);
        return;
      }

      if (lower.includes(CMD_CLIENT)) {
        if (c && c.ignoreNextFromMe) {
          c.ignoreNextFromMe = false;
          saveClients();
        }

        cancelAgenda(jid);

        messageQueue = messageQueue.filter(
          (item) => !(item.jid === jid && item.kind === 'funil')
        );

        if (scheduledStarts[jid]) {
          delete scheduledStarts[jid];
          saveProgramados();
          scheduledQueue.delete(jid);
        }

        startPostSaleMonthly(jid);
        console.log(
          '[PÓS-VENDA] Marcado como cliente via comando #cliente ->',
          jid
        );
        return;
      }


      // ===== comandos admin (usar preferencialmente em "Mensagem para mim") =====
      if (lower.startsWith(CMD_STATS) && isAdminContext(jid)) {
        const s = computeStats();
        const txt =
          `📊 *Iron Glass • Stats*\n` +
          `• Total contatos: ${s.total}\n` +
          `• Ativos: ${s.active}\n` +
          `• Clientes (pós-venda): ${s.clients}\n` +
          `• Com agenda: ${s.agendas}\n` +
          `• Pausados: ${s.paused}\n` +
          `• Bloqueados: ${s.blocked}`;
        await sendText(jid, txt);
        upsertChatMessage(jid, true, txt, Date.now());
        return;
      }

      if (lower.startsWith(CMD_EXPORT) && isAdminContext(jid)) {
        await sendCSVTo(jid);
        upsertChatMessage(jid, true, '📄 Exportação CSV enviada.', Date.now());
        return;
      }

      const apptTs = parseAgendaConfirmation(body);
      if (apptTs) {
        if (c && c.ignoreNextFromMe) {
          c.ignoreNextFromMe = false;
          saveClients();
        }
        scheduleAgenda(jid, apptTs);
        stopFollowUp(jid);
        console.log(
          '[AGENDA] Confirmação detectada na sua msg -> lembretes criados',
          jid
        );
        return;
      }

      if (c && c.ignoreNextFromMe) {
        c.ignoreNextFromMe = false;
        saveClients();
        console.log('[BOT MSG] Ignorada para não reiniciar funil ->', jid);
        return;
      }

      if (body && body.trim() && !body.trim().startsWith('#')) {
        upsertChatMessage(jid, true, body, Date.now());
      }

      if (!blocked[jid]) {
        const now = Date.now();

        if (hasActiveAgenda(jid)) {
          console.log(
            '[MINHA MSG] Cliente com agenda ativa; não reinicia funil ->',
            jid
          );
        } else if (c && c.isClient) {
          console.log(
            '[MINHA MSG] Cliente marcado como pós-venda; não reinicia funil normal ->',
            jid
          );
        } else {
          if (paused[jid]) {
            const pausedAt = paused[jid].pausedAt || paused[jid];
            const PAUSE_MS = 72 * 60 * 60 * 1000;
            const until = pausedAt + PAUSE_MS;

            if (now < until) {
              console.log(
                '[PAUSE] Cliente em pausa até',
                new Date(until).toISOString(),
                '-> não reinicia funil',
                jid
              );
              return;
            } else {
              delete paused[jid];
              savePaused();
              console.log(
                '[PAUSE] Pausa expirada; próximo contato volta para funil ->',
                jid
              );
            }
          }

          const prog = scheduledStarts[jid];
          if (prog && prog.at && now < prog.at) {
            console.log(
              '[MINHA MSG] Cliente com mensagem programada futura; não reinicia funil ainda ->',
              jid
            );
          } else {
            console.log('[MINHA MSG] Reiniciando funil para', jid);
            startFollowUp(jid);
          }
        }
      }
      return;
    }

    console.log('[CLIENTE]', jid, '->', body);
    upsertChatMessage(jid, false, body, Date.now());

    if (blocked[jid]) return;

    if (paused[jid]) {
      const pausedAt = paused[jid].pausedAt || paused[jid];
      const PAUSE_MS = 72 * 60 * 60 * 1000;
      const until = pausedAt + PAUSE_MS;

      if (Date.now() < until) {
        console.log(
          '[PAUSE] Cliente em pausa até',
          new Date(until).toISOString(),
          '-> não reinicia funil',
          jid
        );
        return;
      } else {
        delete paused[jid];
        savePaused();
        console.log(
          '[PAUSE] Pausa expirada, cliente volta ao funil ->',
          jid
        );
      }
    }

    const c2 = clients[jid];

    if (c2 && c2.isClient) {
      c2.lastContact = Date.now();
      saveClients();
      console.log(
        '[PÓS-VENDA] Mensagem recebida de cliente; mantém apenas fluxo mensal ->',
        jid
      );
      return;
    }

    // Cliente respondeu; apenas atualiza painel, sem reiniciar funil automaticamente.
  });
}

// =================== START BOT / QR ===================

async function cleanupSocket() {
  try {
    if (sock?.ev) sock.ev.removeAllListeners();
    if (sock?.ws) sock.ws.close();
    if (sock?.end) sock.end();
  } catch (_) {}
  sock = null;
  isConnected = false;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(30000, 3000 * reconnectAttempts);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await startBot();
  }, delay);
}

async function startBot() {
  try {
    await cleanupSocket();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'info' });

    sock = makeWASocket({
      version,
      printQRInTerminal: true,
      auth: state,
      logger,
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.clear();
        console.log('📱 Escaneie este QR com o WhatsApp:');
        qrcode.generate(qr, { small: true });
        console.log(
          '\nNo celular: WhatsApp > Dispositivos conectados > Conectar um dispositivo.\n'
        );
      }

      if (connection === 'open') {
        isConnected = true;
        reconnectAttempts = 0;
        console.log('✅ WhatsApp conectado!');
      } else if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log('⚠️ Conexão fechada. Código:', statusCode);

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('🔁 Tentando reconectar...');
          scheduleReconnect();
        } else {
          console.log(
            '❌ Sessão encerrada. Apague a pasta "auth" para conectar novamente do zero.'
          );
        }
      }
    });

    setupMessageHandler();
  } catch (err) {
    console.error('Erro ao iniciar bot:', err);
    scheduleReconnect();
  }
}

// =================== START ===================

loadAll();
startScheduleChecker();
startMessageSender();
startBot();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🌐 Painel web disponível em http://localhost:${PORT}/admin`);
  console.log(`💬 Conversas ao vivo em http://localhost:${PORT}/admin?tab=chat`);
});
