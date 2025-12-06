const fs = require('fs');
const path = require('path');
const P = require('pino');
const express = require('express');
const qrcode = require('qrcode-terminal');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

// =================== CONFIG ===================

const DAY_MS = 24 * 60 * 60 * 1000;

// Funil de follow-up (em dias)
const STEPS_DAYS = [3, 5, 7, 15];    // 3d / 5d / 7d / 15d
const EXTRA_INTERVAL_DAYS = 30;        // depois a cada 30 dias forever

// Agenda confirmada (recordatórios)
const AGENDA_OFFSETS_DAYS = [7, 3, 1]; // 7d / 3d / 1d antes

// Janela de envio
const START_HOUR = 9;
const END_HOUR = 22;

// Comandos teus (discretos) — SOMENTE VOCÊ CONTROLA
const CMD_PAUSE = '#falamos no futuro';
const CMD_STOP = '#okok';
const CMD_CLIENT = '#cliente';


// Número do Carlos para alertas do bot
const ALERT_JID = '5511999606543@s.whatsapp.net';

// Monitor de saúde do funil / bot
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // a cada 5 minutos
const HEALTH_OVERDUE_MINUTES = 60;             // considera travado se passar 60min do horário previsto
let lastHealthAlertAt = 0;

// Ignorar mensagens antigas (replay do WhatsApp ao reconectar)
const MAX_MESSAGE_AGE_MINUTES = 60;

// Caminhos de arquivos
const DATA_DIR = path.join(__dirname, 'data');
const CLIENTS_FILE = path.join(DATA_DIR, 'clientes.json');
const AGENDAS_FILE = path.join(DATA_DIR, 'agendas.json');
const BLOCKED_FILE = path.join(DATA_DIR, 'blocked.json');
const PAUSED_FILE = path.join(DATA_DIR, 'paused.json');
const SCHEDULED_FILE = path.join(DATA_DIR, 'programados.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// Garante que pasta data existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// =================== ESTADO EM MEMÓRIA ===================

let clients = {};
let agendas = {};
let blocked = {};
let paused = {};
let scheduled = [];
let messagesConfig = {};

let sock = null;
let isConnected = false;
let messageQueue = [];
let sendingNow = false;

// Para ignorar eco do bot
const botSentRecently = new Set();

// =================== HELPERS ===================

function loadJSON(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) return defaultValue;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return defaultValue;
    return JSON.parse(raw);
  } catch (err) {
    console.error('Erro ao ler', file, err);
    return defaultValue;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar', file, err);
  }
}

function loadAll() {
  clients = loadJSON(CLIENTS_FILE, {});
  agendas = loadJSON(AGENDAS_FILE, {});
  blocked = loadJSON(BLOCKED_FILE, {});
  paused = loadJSON(PAUSED_FILE, {});
  scheduled = loadJSON(SCHEDULED_FILE, []);
  messagesConfig = loadJSON(MESSAGES_FILE, {});

  console.log('✅ CRM carregado. Leads:', Object.keys(clients).length, ', mensagens:', Object.keys(messagesConfig).length);
}

function saveClients() {
  saveJSON(CLIENTS_FILE, clients);
}

function saveAgendas() {
  saveJSON(AGENDAS_FILE, agendas);
}

function saveBlocked() {
  saveJSON(BLOCKED_FILE, blocked);
}

function savePaused() {
  saveJSON(PAUSED_FILE, paused);
}

function saveScheduled() {
  saveJSON(SCHEDULED_FILE, scheduled);
}

function saveMessages() {
  saveJSON(MESSAGES_FILE, messagesConfig);
}

function isInsideWindow(date = new Date()) {
  const hour = date.getHours();
  return hour >= START_HOUR && hour < END_HOUR;
}

function minutesAgo(date) {
  const now = new Date();
  return (now - date) / (60 * 1000);
}

function isTooOld(messageTimestamp) {
  const msgDate = new Date(messageTimestamp * 1000);
  return minutesAgo(msgDate) > MAX_MESSAGE_AGE_MINUTES;
}

function markBotSent(jid) {
  botSentRecently.add(jid);
  setTimeout(() => botSentRecently.delete(jid), 10_000); // 10s pra ignorar eco
}

// =================== FUNIL / AGENDA / PROGRAMADOS ===================

function startFollowUp(jid) {
  if (blocked[jid]) return; // nunca reinicia pra bloqueado definitivo

  const now = Date.now();
  clients[jid] = {
    lastContact: now,
    stepIndex: 0,
    nextFollowUpAt: now + STEPS_DAYS[0] * DAY_MS,
    ignoreNextFromMe: false,
  };
  console.log('[FUNIL] Iniciado / reiniciado para', jid, '-> próximo em', STEPS_DAYS[0], 'dias');
  saveClients();
}

function startPostSaleMonthly(jid) {
  if (blocked[jid]) return;

  const now = Date.now();
  const c = clients[jid] || {};

  c.isClient = true; // marca como cliente pós-venda
  c.stepIndex = STEPS_DAYS.length; // posição sentinela: sempre usará mensagem pós-venda
  c.lastContact = now;
  c.nextFollowUpAt = now + EXTRA_INTERVAL_DAYS * DAY_MS;
  c.ignoreNextFromMe = false;

  clients[jid] = c;
  saveClients();

  // se estiver em pausa, remove para não travar o fluxo mensal
  if (paused[jid]) {
    delete paused[jid];
    savePaused();
  }

  console.log('[POS-VENDA] Ativado ciclo mensal para', jid);
}

function blockFollowUp(jid, reason = 'MANUAL') {
  blocked[jid] = { reason, at: Date.now() };
  delete clients[jid];
  saveBlocked();
  saveClients();

  console.log('[FUNIL] BLOQUEADO para', jid, 'motivo:', reason);
}

function pauseFollowUp(jid) {
  paused[jid] = { at: Date.now() };
  savePaused();
  console.log('[FUNIL] PAUSADO para', jid);
}

function resumeFollowUp(jid) {
  if (!paused[jid]) return;
  delete paused[jid];
  savePaused();
  console.log('[FUNIL] RESUMIDO para', jid);
}

function addAgenda(jid, timestamp) {
  if (!agendas[jid]) agendas[jid] = [];
  agendas[jid].push({ at: timestamp, notified: false });
  saveAgendas();
  console.log('[AGENDA] Agendada para', new Date(timestamp).toLocaleString(), '->', jid);
}

function scheduleMessage(jid, text, timestamp) {
  scheduled.push({
    jid,
    text,
    at: timestamp,
    sent: false,
  });
  saveScheduled();
  console.log('[PROGRAMADO] Mensagem programada para', jid, 'em', new Date(timestamp).toLocaleString());
}

// =================== FILA DE ENVIO ===================

function enqueueMessage(jid, kind, payload = {}) {
  messageQueue.push({ jid, kind, ...payload });
  console.log('[QUEUE] Mensagem enfileirada:', { jid, kind });
}

async function startMessageSender() {
  if (sendingNow) return;
  sendingNow = true;

  while (true) {
    try {
      if (!isConnected || !sock) {
        await new Promise(res => setTimeout(res, 3000));
        continue;
      }

      const item = messageQueue.shift();
      if (!item) {
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }

      const { jid, kind, text } = item;

      if (!isInsideWindow(new Date())) {
        console.log('[SENDER] Fora da janela de envio, recolocando na fila ->', jid);
        messageQueue.push(item);
        await new Promise(res => setTimeout(res, 60 * 1000));
        continue;
      }

      if (kind === 'simple' && text) {
        markBotSent(jid);
        await sock.sendMessage(jid, { text });
        console.log('[SENDER] Enviado (simple) para', jid);
        await new Promise(res => setTimeout(res, 2000));
        continue;
      }

      if (kind === 'funil') {
        const c = clients[jid];
        if (!c) continue;
        if (blocked[jid]) continue;
        if (paused[jid]) continue;

        const now = Date.now();
        const stepIndex = c.stepIndex ?? 0;

        let msgKey;
        if (stepIndex < STEPS_DAYS.length) {
          msgKey = `step${stepIndex + 1}`; // step1, step2, step3, step4 ...
        } else {
          msgKey = 'postSale30'; // pós-venda mensal
        }

        const texto =
          messagesConfig[msgKey] ||
          (c.isClient ? messagesConfig.postSale30 : null) ||
          messagesConfig.extra ||
          'Olá! Tudo bem?';

        // Antes: c.ignoreNextFromMe = true; (isso travava o funil se algo desse errado)
        // Agora confiamos apenas em botSentRecently para ignorar eco do bot
        markBotSent(jid);
        await sock.sendMessage(jid, { text: texto });

        const sentAt = Date.now();
        c.lastContact = sentAt;

        if (stepIndex < STEPS_DAYS.length) {
          c.stepIndex = stepIndex + 1;
          if (stepIndex + 1 < STEPS_DAYS.length) {
            c.nextFollowUpAt = sentAt + STEPS_DAYS[stepIndex + 1] * DAY_MS;
          } else {
            c.isClient = true;
            c.stepIndex = STEPS_DAYS.length;
            c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
          }
        } else {
          c.isClient = true;
          c.stepIndex = STEPS_DAYS.length;
          c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
        }

        clients[jid] = c;
        saveClients();

        console.log('[FUNIL] Mensagem enviada para', jid, '-> stepIndex', c.stepIndex);
        await new Promise(res => setTimeout(res, 3000));
        continue;
      }

      console.log('[SENDER] Tipo de mensagem desconhecido:', kind);
    } catch (err) {
      console.error('[SENDER] Erro ao enviar mensagem:', err);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
}

// =================== AGENDADOR ===================

function startScheduleChecker() {
  setInterval(() => {
    if (!isConnected || !sock) return;
    if (!isInsideWindow(new Date())) return;

    const now = Date.now();

    // Funil
    for (const [jid, c] of Object.entries(clients)) {
      if (!c || !c.nextFollowUpAt) continue;
      if (blocked[jid]) continue;
      if (paused[jid]) continue;

      const diff = now - c.nextFollowUpAt;
      if (diff >= 0 && diff < 60 * 60 * 1000) {
        const already = messageQueue.some(m => m.jid === jid && m.kind === 'funil');
        if (!already) {
          messageQueue.push({ jid, kind: 'funil' });
          console.log('[QUEUE] Funil enfileirado para', jid);
        }
      }
    }

    // agenda
    for (const [jid, arr] of Object.entries(agendas)) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item.sent) continue;
        if (now >= item.at && now - item.at < 60 * 60 * 1000) {
          const msg = messagesConfig.agendaReminder || 'Lembrando da sua agenda com a Iron Glass!';
          enqueueMessage(jid, 'simple', { text: msg });
          item.sent = true;
        }
      }
    }
    saveAgendas();

    // programados
    for (const item of scheduled) {
      if (item.sent) continue;
      if (now >= item.at && now - item.at < 60 * 60 * 1000) {
        enqueueMessage(item.jid, 'simple', { text: item.text });
        item.sent = true;
      }
    }
    saveScheduled();
  }, 60 * 1000);
}

// =================== WHATSAPP (BAILEYS) ===================

async function startBot() {
  const logger = P({ level: 'info' });
  const { state, saveCreds } = await useMultiFileAuthState('auth');

 {
  try {
    await cleanupSocket();

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'error' }),
    });

    console.log('✅ Bot inicializado. Aguardando QR para conexão...');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.clear();
        console.log('📱 Escaneie este QR com o WhatsApp:');
        qrcode.generate(qr, { small: true });
        console.log('\nNo celular: WhatsApp > Dispositivos conectados > Conectar um dispositivo.\n');
      }

      if (connection === 'open') {
        isConnected = true;
        reconnectAttempts = 0;
        console.log('✅ Conectado ao WhatsApp!');
      } else if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log('⚠️ Conexão fechada. Código:', statusCode);

        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('🔁 Tentando reconectar...');
          scheduleReconnect();
        } else {
          console.log('❌ Sessão encerrada. Apague a pasta "auth" para conectar novamente do zero.');
        }
      }
    });

    setupMessageHandler();
  } catch (err) {
    console.error('Erro ao iniciar o bot:', err?.message || err);
    scheduleReconnect();
  }
}

// =================== PANEL WEB ===================

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function htmlEscape(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAgendasList() {
  const items = [];
  for (const [jid, arr] of Object.entries(agendas || {})) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const sorted = [...arr].sort((a,b)=>a.at-b.at);
    const next = sorted[0];
    const dt = new Date(next.at);
    const phone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');
    items.push({
      jid,
      phoneDisplay: phone,
      nextAt: dt,
      count: arr.length,
      keys: sorted.map(x=>x.key).join(', ')
    });
  }
  items.sort((a,b)=>a.nextAt - b.nextAt);

  if (items.length === 0) {
    return `<div class="empty">Nenhuma agenda confirmada ainda.</div>`;
  }

  const rows = items.map(it => {
    const d = it.nextAt;
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,'0');
    const min = String(d.getMinutes()).padStart(2,'0');

    return `
      <tr>
        <td>${htmlEscape(it.phoneDisplay)}</td>
        <td>${dd}/${mm}/${yyyy} ${hh}:${min}</td>
        <td>${it.count}</td>
        <td><code>${htmlEscape(it.keys)}</code></td>
        <td>
          <button class="btn-danger"
                  type="submit"
                  formaction="/admin/agenda/delete"
                  formmethod="POST"
                  name="jid"
                  value="${htmlEscape(it.jid)}"
                  formnovalidate>
            Cancelar agenda
          </button>
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Contato</th>
            <th>Próximo lembrete</th>
            <th># lembretes</th>
            <th>Tipos</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}


function renderProgramList() {
  const items = [];
  for (const [jid, s] of Object.entries(scheduledStarts || {})) {
    if (!s || !s.at) continue;
    const dt = new Date(s.at);
    const phone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');
    items.push({
      jid,
      phoneDisplay: phone,
      at: dt,
      preview: (s.text || '').slice(0, 80),
    });
  }

  items.sort((a,b)=>a.at - b.at);

  if (items.length === 0) {
    return `<div class="empty">Nenhuma mensagem programada.</div>`;
  }

  const rows = items.map(it => {
    const d = it.at;
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,'0');
    const min = String(d.getMinutes()).padStart(2,'0');

    return `
      <tr>
        <td>${htmlEscape(it.phoneDisplay)}</td>
        <td>${dd}/${mm}/${yyyy} ${hh}:${min}</td>
        <td><code>${htmlEscape(it.preview)}</code></td>
        <td>
          <button class="btn-danger"
                  type="submit"
                  formaction="/admin/program/delete"
                  formmethod="POST"
                  name="jid"
                  value="${htmlEscape(it.jid)}"
                  formnovalidate>
            Cancelar
          </button>
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Contato</th>
            <th>Envio</th>
            <th>Prévia</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

app.get('/admin', (req, res) => {
  const m = messagesConfig;
  const agendasList = renderAgendasList();
  const programList = renderProgramList();

  const html = `
<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <title>Painel Iron Glass - Bot</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e5e7eb;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 980px;
      margin: 30px auto;
      background: #020617;
      border-radius: 16px;
      padding: 24px 28px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      border: 1px solid #1f2937;
    }
    h1 { margin-top:0; font-size:1.6rem; display:flex; gap:8px; align-items:center; }
    h1 .logo{
      width:32px;height:32px;border-radius:999px;border:1px solid #facc15;
      display:inline-flex;align-items:center;justify-content:center;
      font-weight:700;font-size:.8rem;color:#facc15;
    }
    .subtitle { color:#9ca3af;font-size:.9rem;margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .card {
      background:#020617; border-radius:12px; padding:14px 16px;
      border:1px solid #1f2937;
    }
    .card h2 { margin:0 0 6px 0;font-size:.95rem; }
    .card small { color:#9ca3af;font-size:.75rem; }
    label { display:block;font-size:.8rem;margin:8px 0 6px;color:#9ca3af; }
    textarea, input {
      width:100%; border-radius:8px; border:1px solid #374151;
      background:#020617; color:#e5e7eb; padding:8px 10px; font-size:.85rem;
      box-sizing:border-box;
    }
    textarea { min-height:110px; resize:vertical; }
    textarea:focus, input:focus {
      outline:none; border-color:#facc15; box-shadow:0 0 0 1px rgba(250,204,21,0.2);
    }
    .picker{display:flex;align-items:center;gap:6px;}
    .picker input{flex:1;}
    .icon-btn{
      border:1px solid #374151;background:#0b1220;color:#e5e7eb;border-radius:8px;
      padding:6px 8px;cursor:pointer;font-size:1rem;line-height:1;
    }
    .icon-btn:hover{filter:brightness(1.1);}

    .footer { display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:12px;flex-wrap:wrap; }
    button {
      background:#facc15;border-radius:999px;border:none;padding:10px 20px;font-weight:600;
      font-size:.9rem;cursor:pointer;color:#111827;
    }
    button:hover{filter:brightness(1.05);}
    .status{font-size:.8rem;color:#9ca3af;}
    .badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;border:1px solid #4b5563;font-size:.7rem;color:#9ca3af;}
    .badge-dot{width:8px;height:8px;border-radius:999px;background:#22c55e;}
    .table-wrap{overflow:auto;border:1px solid #1f2937;border-radius:12px;margin-top:8px;}
    table{width:100%;border-collapse:collapse;font-size:.85rem;}
    th,td{padding:10px 12px;border-bottom:1px solid #111827;vertical-align:top;}
    th{position:sticky;top:0;background:#020617;text-align:left;color:#e5e7eb;font-size:.8rem;}
    code{font-size:.75rem;color:#cbd5e1;}
    .btn-danger{background:#ef4444;color:#fff;border:none;border-radius:999px;padding:6px 12px;font-size:.8rem;cursor:pointer;}
    .btn-danger:hover{filter:brightness(1.05);}
    .empty{color:#9ca3af;font-size:.85rem;padding:10px 0;}

    @media (max-width: 768px) { .grid { grid-template-columns:1fr; } .container{margin:10px;} }
  </style>
</head>
<body>
  <div class="container">
    <h1><span class="logo">IG</span>Painel do Bot</h1>
    <div class="subtitle">
      Funil automático no topo. Confirmação de agenda abaixo.
      <br/><small>Envio somente entre ${START_HOUR}:00 e ${END_HOUR}:00.</small>
    </div>

    <form method="POST" action="/admin/mensajes">
      <!-- =============== FUNIL (TOP) =============== -->
      <h2 style="margin:0 0 8px 0;">✅ Funil automático (3, 5, 7, 15 dias e a cada 30 dias)</h2>
      <div class="grid">
        <div class="card">
          <h2>Etapa 1 • 3 dias</h2>
          <small>Primeiro lembrete após sua mensagem.</small>
          <label for="step0">Mensagem:</label>
          <textarea id="step0" name="step0">${htmlEscape(m.step0)}</textarea>
        </div>

        <div class="card">
          <h2>Etapa 2 • 5 dias</h2>
          <small>Segundo lembrete.</small>
          <label for="step1">Mensagem:</label>
          <textarea id="step1" name="step1">${htmlEscape(m.step1)}</textarea>
        </div>

        <div class="card">
          <h2>Etapa 3 • 7 dias</h2>
          <small>Terceiro lembrete.</small>
          <label for="step2">Mensagem:</label>
          <textarea id="step2" name="step2">${htmlEscape(m.step2)}</textarea>
        </div>

        <div class="card">
          <h2>Etapa 4 • 15 dias</h2>
          <small>Último lembrete da primeira sequência.</small>
          <label for="step3">Mensagem:</label>
          <textarea id="step3" name="step3">${htmlEscape(m.step3)}</textarea>
        </div>

        <div class="card" style="grid-column:1/-1;">
          <h2>Seguimento recorrente • a cada 30 dias</h2>
          <small>Depois dos 15 dias.</small>
          <label for="extra">Mensagem:</label>
          <textarea id="extra" name="extra">${htmlEscape(m.extra)}</textarea>
        </div>

        <div class="card" style="grid-column:1/-1;">
          <h2>Pós-venda • a cada 30 dias (clientes já instalados)</h2>
          <small>Mensagem enviada 30 dias após a instalação e depois a cada 30 dias, para pedir indicação e manter relacionamento.</small>
          <label for="postSale30">Mensagem:</label>
          <textarea id="postSale30" name="postSale30">${htmlEscape(m.postSale30 || '')}</textarea>
        </div>

        <div class="card" style="grid-column:1/-1; margin-top:10px;">
          <h2>📆 Mensagem programada (primeiro contato)</h2>
          <small>
            Use quando o cliente disse que só poderá falar em uma data futura.
            O funil pausa até esse dia e, quando essa mensagem for enviada, ele entra no funil normalmente.
          </small>

          <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:10px;">
            <div style="flex:1; min-width:180px;">
              <label for="programPhone">Número do cliente</label>
              <input id="programPhone" name="programPhone" placeholder="Ex: 5511999999999" />
            </div>
            <div style="flex:1; min-width:160px;">
              <label for="programDate">Dia para enviar</label>
              <input id="programDate" name="programDate" type="date" />
            </div>
            <div style="flex:1; min-width:120px;">
              <label for="programTime">Hora para enviar</label>
              <input id="programTime" name="programTime" type="time" />
            </div>
          </div>

          <label for="programText" style="margin-top:10px;">Mensagem a ser enviada nesse dia</label>
          <textarea id="programText" name="programText" placeholder="Ex: Oi! Aqui é da Iron Glass, combinamos de falar agora em fevereiro sobre seu carro..."></textarea>

          <div style="margin-top:12px;">
            <button type="submit" formaction="/admin/program" formmethod="POST">
              Programar mensagem
            </button>
          </div>

          <div style="margin-top:16px;">
            <h3 style="margin:0 0 4px 0; font-size:.9rem;">Mensagens programadas</h3>
            <small style="color:#9ca3af;">Clientes que vão receber o primeiro contato em uma data futura.</small>
            <div style="margin-top:8px;">
              ${programList}
            </div>
          </div>
        </div>
      </div>

      <div class="footer">
        <div class="status">
          <div class="badge"><span class="badge-dot"></span> Bot precisa estar rodando no CMD (npm start)</div>
        </div>
        <button type="submit">Salvar mensagens do funil</button>
      </div>

      <hr style="border:0;border-top:1px solid #1f2937;margin:22px 0;" />

      <!-- =============== AGENDA (BOTTOM) =============== -->
      <h2 style="margin:0 0 8px 0;">📅 Confirmación de agenda</h2>

      <div class="card" style="grid-column:1/-1;">
          <label for="phone">Número do cliente</label>
          <input id="phone" name="phone" placeholder="Ex: 5511999999999" />

          <div style="display:flex; gap:12px; flex-wrap: wrap; margin-top:10px;">
            <div style="flex:1; min-width:160px;">
              <label for="date">Dia da agenda</label>
              <div class="picker">
                <input id="date" name="date" type="date" />
                <button type="button" class="icon-btn" onclick="openDate()" aria-label="Abrir calendário">📅</button>
              </div>
            </div>
            <div style="flex:1; min-width:120px;">
              <label for="time">Hora da agenda</label>
              <div class="picker">
                <input id="time" name="time" type="time" />
                <button type="button" class="icon-btn" onclick="openTime()" aria-label="Abrir relógio">⏰</button>
              </div>
            </div>
          </div>

          <div style="display:flex; gap:12px; flex-wrap: wrap; margin-top:10px;">
            <div style="flex:1; min-width:220px;">
              <label for="vehicle">Veículo</label>
              <input id="vehicle" name="vehicle" placeholder="Ex: BYD SONG" />
            </div>
            <div style="flex:1; min-width:220px;">
              <label for="product">Produto</label>
              <input id="product" name="product" placeholder="Ex: Iron Glass Plus" />
            </div>
            <div style="flex:1; min-width:180px;">
              <label for="valor">Valor total</label>
              <input id="valor" name="valor" placeholder="Ex: R$ 12.900,00" />
            </div>
            <div style="flex:1; min-width:180px;">
              <label for="sinal">Sinal recebido</label>
              <input id="sinal" name="sinal" placeholder="Ex: R$ 1.075,00" />
            </div>
            <div style="flex:1; min-width:180px;">
              <label for="pagamento">Forma de pagamento</label>
              <input id="pagamento" name="pagamento" placeholder="PIX confirmado" />
            </div>
          </div>

          <label style="display:flex;align-items:center;gap:6px;margin-top:8px;">
            <input type="checkbox" name="sendConfirm" />
            Enviar mensagem de confirmação agora
          </label>

          <div style="margin-top:12px;">
            <button type="submit" formaction="/admin/agenda" formmethod="POST">Programar lembretes</button>
          </div>
      </div>

      <div class="grid" style="margin-top:14px;">
        <div class="card">
          <h2>Confirmación • 7 dias antes</h2>
          <label for="agenda0">Mensagem:</label>
          <textarea id="agenda0" name="agenda0">${htmlEscape(m.agenda0 || '')}</textarea>
        </div>

        <div class="card">
          <h2>Confirmación • 3 dias antes</h2>
          <label for="agenda1">Mensagem:</label>
          <textarea id="agenda1" name="agenda1">${htmlEscape(m.agenda1 || '')}</textarea>
        </div>

        <div class="card">
          <h2>Confirmación • 1 dia antes</h2>
          <label for="agenda2">Mensagem:</label>
          <textarea id="agenda2" name="agenda2">${htmlEscape(m.agenda2 || '')}</textarea>
        </div>

        <div class="card" style="grid-column:1/-1;">
          <h2>Template de mensagem de confirmação</h2>
          <small>Variáveis: {{DATA}}, {{HORA}}, {{VEICULO}}, {{PRODUTO}}, {{VALOR}}, {{SINAL}}, {{PAGAMENTO}}</small>
          <label for="confirmTemplate">Mensagem:</label>
          <textarea id="confirmTemplate" name="confirmTemplate">${htmlEscape(m.confirmTemplate || '')}</textarea>
        </div>

        <div class="card" style="grid-column:1/-1; margin-top:10px;">
          <h2 style="margin-top:0;">Agendas confirmadas</h2>
          <small style="color:#9ca3af;">Clientes com lembretes de confirmação ativos.</small>
          <div style="margin-top:10px;">
            ${agendasList}
          </div>
        </div>
      </div>

      <div class="footer">
        <button type="submit">Salvar mensagens de agenda</button>
      </div>
    </form>
  </div>

  <script>
    function openDate(){
      const el = document.getElementById('date');
      if(!el) return;
      if (el.showPicker) el.showPicker();
      else el.focus();
    }
    function openTime(){
      const el = document.getElementById('time');
      if(!el) return;
      if (el.showPicker) el.showPicker();
      else el.focus();
    }
  </script>
</body>
</html>
  `;
  res.send(html);
});

// salva textos funil + agenda + template
app.post('/admin/mensajes', (req, res) => {
  messagesConfig.step0 = req.body.step0 || messagesConfig.step0;
  messagesConfig.step1 = req.body.step1 || messagesConfig.step1;
  messagesConfig.step2 = req.body.step2 || messagesConfig.step2;
  messagesConfig.step3 = req.body.step3 || messagesConfig.step3;
  messagesConfig.extra = req.body.extra || messagesConfig.extra;
  messagesConfig.postSale30 = req.body.postSale30 || messagesConfig.postSale30;


  messagesConfig.agenda0 = req.body.agenda0 || messagesConfig.agenda0;
  messagesConfig.agenda1 = req.body.agenda1 || messagesConfig.agenda1;
  messagesConfig.agenda2 = req.body.agenda2 || messagesConfig.agenda2;

  messagesConfig.confirmTemplate = req.body.confirmTemplate || messagesConfig.confirmTemplate;

  saveMessages();
  console.log('[PAINEL] Mensagens atualizadas.');
  res.redirect('/admin');
});

// agenda via painel (programa 7/3/1 e opcionalmente envia confirmação)
app.post('/admin/agenda', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  const date = req.body.date;
  const time = req.body.time;

  if (!phone || !date || !time) return res.redirect('/admin');

  const jid = phone.startsWith('55') ? `${phone}@s.whatsapp.net` : `55${phone}@s.whatsapp.net`;
  const apptTs = new Date(`${date}T${time}:00`).getTime();

  // Monta dados completos da agenda (iguais ao template de confirmação)
  const d = new Date(apptTs);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2,'0');
  const min = String(d.getMinutes()).padStart(2,'0');

  const data = {
    DATA: `${dd}/${mm}/${yyyy}`,
    HORA: `${hh}:${min}`,
    VEICULO: req.body.vehicle || '',
    PRODUTO: req.body.product || '',
    VALOR: req.body.valor || '',
    SINAL: req.body.sinal || '',
    PAGAMENTO: req.body.pagamento || ''
  };

  // Sempre programa lembretes já com os dados salvos
  scheduleAgenda(jid, apptTs, data);

  // Opcionalmente envia confirmação agora
  if (req.body.sendConfirm) {
    const text = applyTemplate(messagesConfig.confirmTemplate, data);

    if (sock && isConnected && text) {
      try {
        markBotSent(jid);
        await sock.sendMessage(jid, { text });
        console.log('[AGENDA] Confirmação enviada pelo painel ->', jid);
      } catch (e) {
        console.error('[ERRO] Ao enviar confirmação pelo painel', e);
      }
    }
  }

  res.redirect('/admin');
});

// cancelar agenda pelo painel
app.post('/admin/agenda/delete', (req, res) => {
  const jid = req.body.jid;
  cancelAgenda(jid);
  res.redirect('/admin');
});


// programar primeira mensagem do funil via painel
app.post('/admin/program', (req, res) => {
  const phoneRaw = req.body.programPhone || '';
  const date = req.body.programDate;
  const time = req.body.programTime || '09:00';
  const text = (req.body.programText || '').trim();

  const phone = phoneRaw.replace(/\D/g, '');
  if (!phone || !date) return res.redirect('/admin');

  const jid = phone.startsWith('55')
    ? `${phone}@s.whatsapp.net`
    : `55${phone}@s.whatsapp.net`;

  const ts = new Date(`${date}T${time || '09:00'}:00`).getTime();
  if (!ts || Number.isNaN(ts)) return res.redirect('/admin');

  scheduledStarts[jid] = {
    at: ts,
    text,
  };
  saveProgramados();

  // pausa o funil até a data programada, mas não bloqueia definitivo
  pauseFollowUp(jid);

  // permite re-enfileirar quando chegar a data
  scheduledQueue.delete(jid);

  console.log('[PROGRAM] Mensagem inicial programada para', jid, 'em', new Date(ts).toISOString());
  res.redirect('/admin');
});

// cancelar mensagem programada
app.post('/admin/program/delete', (req, res) => {
  const jid = req.body.jid;
  if (jid && scheduledStarts[jid]) {
    delete scheduledStarts[jid];
    saveProgramados();
    scheduledQueue.delete(jid);
    console.log('[PROGRAM] Mensagem programada cancelada ->', jid);
  }
  res.redirect('/admin');
});



// =================== HEALTH MONITOR (ALERTAS PARA CARLOS) ===================

async function sendHealthAlert(text) {
  try {
    if (!sock || !isConnected) {
      console.log('[HEALTH] Não foi possível enviar alerta (bot desconectado).');
      return;
    }
    if (!ALERT_JID) {
      console.log('[HEALTH] ALERT_JID não configurado.');
      return;
    }

    markBotSent(ALERT_JID);
    await sock.sendMessage(ALERT_JID, { text });
    console.log('[HEALTH] Alerta enviado para', ALERT_JID);
  } catch (err) {
    console.error('[HEALTH] Erro ao enviar alerta:', err);
  }
}

function startHealthMonitor() {
  setInterval(async () => {
    const now = Date.now();

    // Alerta se não estiver conectado
    if (!isConnected) {
      if (now - lastHealthAlertAt > HEALTH_CHECK_INTERVAL_MS) {
        lastHealthAlertAt = now;
        await sendHealthAlert(
          '⚠️ ALERTA IRON GLASS BOT\n\n' +
          'O bot não está conectado ao WhatsApp neste momento. ' +
          'Verifique a sessão no celular e os logs do Railway.'
        );
      }
      return;
    }

    // Verifica contatos com follow-up atrasado há muito tempo
    const threshold = HEALTH_OVERDUE_MINUTES * 60 * 1000;
    const overdue = [];

    for (const [jid, c] of Object.entries(clients || {})) {
      if (!c || !c.nextFollowUpAt) continue;
      if (blocked[jid]) continue;
      if (paused[jid]) continue;

      const diff = now - c.nextFollowUpAt;
      if (diff > threshold) {
        // Se lastContact é anterior ao horário planejado, significa que o follow-up não rodou
        if (!c.lastContact || c.lastContact < c.nextFollowUpAt) {
          overdue.push({ jid, diff });
        }
      }
    }

    if (overdue.length > 0 && now - lastHealthAlertAt > threshold) {
      lastHealthAlertAt = now;
      const sample = overdue[0];
      const minutes = Math.round(sample.diff / 60000);
      let phone = sample.jid
        .replace('@s.whatsapp.net', '')
        .replace('@lid', '')
        .replace('@newsletter', '');

      if (phone.startsWith('55')) phone = phone.slice(2);

      const msg =
        '⚠️ ALERTA IRON GLASS BOT\n\n' +
        `Detectei ${overdue.length} contato(s) com follow-up atrasado há mais de ${HEALTH_OVERDUE_MINUTES} minutos.\n` +
        `Exemplo: ${phone} (atraso de ~${minutes} min).\n\n` +
        'Isso pode indicar que o funil travou. Verifique o painel e os logs do Railway.';

      await sendHealthAlert(msg);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

// =================== START ===================

loadAll();
startScheduleChecker();
startMessageSender();
startHealthMonitor();
startBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Painel web disponível na rota /admin (porta ${PORT})`);
});
