const fs = require('fs');
const path = require('path');

// =================== MODOS DE TESTE ===================
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === '1' || String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const DISABLE_AUTOMATION = String(process.env.DISABLE_AUTOMATION || '').toLowerCase() === '1' || String(process.env.DISABLE_AUTOMATION || '').toLowerCase() === 'true';
if (DRY_RUN) console.log('🧪 DRY_RUN ativo: NENHUMA mensagem será enviada (nem manual, nem automático).');
if (DISABLE_AUTOMATION) console.log('🧪 DISABLE_AUTOMATION ativo: Seguimento/agenda/programados NÃO vão rodar (mas o painel e recebimento funcionam).');

const P = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode-terminal');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

// =================== CONFIG ===================

const DAY_MS = 24 * 60 * 60 * 1000;

// Funil de vendas
const STEPS_DAYS = [3, 5, 7, 15];      // 3d, 5d, 7d, 15d
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

// Ignorar mensagens antigas (replay do Baileys)
const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

// Arquivos de persistência (Railway: use Volume + DATA_DIR=/data)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth');

// garante pastas existirem
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (e) {}

const DATA_FILE = path.join(DATA_DIR, 'clientes.json');
const MSG_FILE = path.join(DATA_DIR, 'mensajes.json');
const BLOCK_FILE = path.join(DATA_DIR, 'bloqueados.json');
const PAUSE_FILE = path.join(DATA_DIR, 'pausados.json');
const AGENDA_FILE = path.join(DATA_DIR, 'agendas.json');
const PROGRAM_FILE = path.join(DATA_DIR, 'programados.json');
const CHAT_FILE = path.join(DATA_DIR, 'chats.json');

console.log('📁 DATA_DIR:', DATA_DIR);
console.log('📁 AUTH_DIR:', AUTH_DIR);


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

let messageQueue = []; // itens: { jid, kind: 'funil'|'agenda'|'startFunil', key? }
let botSentRecently = new Set(); // evita auto-trigger do bot
let scheduledQueue = new Set();  // controla enfileiramento de mensagens programadas

// =================== LOAD/SAVE ===================

function loadJSON(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Erro ao ler ${path.basename(file)}:`, e);
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadAll() {
  clients = loadJSON(DATA_FILE, {});
  messagesConfig = loadJSON(MSG_FILE, defaultMessages());
  // garante respostas rápidas mesmo se o mensajes.json antigo não tiver esse campo
  if (!Array.isArray(messagesConfig.quickReplies)) {
    messagesConfig.quickReplies = (defaultMessages().quickReplies || []);
    saveMessages();
  }
  blocked = loadJSON(BLOCK_FILE, {});
  paused = loadJSON(PAUSE_FILE, {});
  agendas = loadJSON(AGENDA_FILE, {});
  scheduledStarts = loadJSON(PROGRAM_FILE, {});
  chatStore = loadJSON(CHAT_FILE, {});
}
function saveClients() { saveJSON(DATA_FILE, clients); }
function saveMessages() { saveJSON(MSG_FILE, messagesConfig); }
function saveChats() { saveJSON(CHAT_FILE, chatStore); }
function saveBlocked() { saveJSON(BLOCK_FILE, blocked); }
function savePaused() { saveJSON(PAUSE_FILE, paused); }
function saveAgendas() { saveJSON(AGENDA_FILE, agendas); }
function saveProgramados() { saveJSON(PROGRAM_FILE, scheduledStarts); }

// =================== DEFAULT MESSAGES ===================

function defaultMessages() {
  return {
    step0:
      'Olá! Tudo bem? Aqui é da Iron Glass 😊\n' +
      'Passando só para dar continuidade ao seu atendimento. Se ainda tiver interesse, me chama aqui que eu te ajudo com tudo.',
    step1:
      'Oi! Aqui é da Iron Glass novamente 😉\n' +
      'Queria saber se ainda tem interesse na proteção dos vidros do seu carro. Qualquer dúvida, pode falar comigo por aqui.',
    step2:
      'Tudo bem? Aqui é da Iron Glass 🛡️\n' +
      'Não quero te incomodar, só lembrar que aquela condição especial ainda está disponível. Se fizer sentido para você, me chama.',
    step3:
      'Olá! Aqui é da Iron Glass 🚙\n' +
      'Esse é o último lembrete dessa primeira sequência. Se ainda quiser proteger seu carro, será um prazer te atender.',

    // Seguimento recorrente de interessados (leads) a cada 30 dias
    extra:
      'Olá! Tudo bem? Aqui é da Iron Glass 😊\n' +
      'Só passando a cada 30 dias para saber se já é um bom momento para retomarmos a conversa sobre a proteção dos vidros do seu carro.',

    // Pós-venda: clientes que já instalaram (30 dias após e depois a cada 30 dias)
    postSale30:
      'Olá! Aqui é da Iron Glass 🛡️\n' +
      'Passando para saber se deu tudo certo com a sua proteção e se você conhece alguém que também queira proteger os vidros do carro.\n' +
      'Sua indicação é muito importante para nós! 😊',

    // Agenda (editáveis no painel)
    agenda0:
      '📅 Lembrete Iron Glass: falta 7 dias para seu agendamento.\n' +
      'Qualquer dúvida antes do dia, estou por aqui. 😉',
    agenda1:
      '📅 Lembrete Iron Glass: faltam 3 dias para seu agendamento.\n' +
      'Se precisar ajustar algo, me avise por aqui.',
    agenda2:
      '📅 Lembrete Iron Glass: é amanhã o seu agendamento.\n' +
      'Te esperamos no horário combinado. 🚗🛡️',

    // Template de confirmação (editável)
    confirmTemplate:
      '📅 Confirmação de Agendamento - Iron Glass\n\n' +
      'Prezado cliente,\n' +
      'confirmamos seu agendamento para o dia {{DATA}} às {{HORA}}.\n\n' +
      '🚗 Veículo: {{VEICULO}}\n' +
      '🛡️ Produto: {{PRODUTO}}\n' +
      '💰 Valor total: {{VALOR}}\n' +
      '💵 Sinal recebido: {{SINAL}} ({{PAGAMENTO}})\n\n' +
      'Agradecemos a confiança em Iron Glass, líder em proteção automotiva premium.\n' +
      'Nossa equipe estará aguardando na data marcada para realizar o serviço com toda a qualidade e garantia que nos caracterizam.',

    // Respostas rápidas para o painel de conversas (editáveis)
    quickReplies: [
      { label: '✅ Enviar horários', text: 'Perfeito! Me diz: qual período você prefere (manhã/tarde)? Aí eu já te mando 2 horários disponíveis pra você escolher 😊' },
      { label: '📍 Endereço / localização', text: 'Estamos na [ENDERECO]. Quer que eu te mande a localização no Google Maps?' },
      { label: '🛡️ O que é Iron Glass', text: 'Iron Glass é uma proteção invisível para os vidros do carro (químico + térmico + polímero), com garantia de 10 anos. Ajuda a evitar riscos, manchas e microtrincas.' },
      { label: '💳 Formas de pagamento', text: 'Temos Pix e cartão (em até 12x). Me diz qual você prefere que eu simule pra você?' },
      { label: '🚗 Tempo de serviço', text: 'O serviço normalmente leva cerca de 3 a 4 horas. Você deixa o carro e retira no mesmo dia 🙂' },
      { label: '📆 Agendar agora', text: 'Vamos agendar? Me diz seu modelo/ano e qual dia da semana você prefere que eu já te passo horários.' },
      { label: '🧾 Enviar cotação', text: 'Claro! Me confirma: modelo/ano do carro e se você quer Iron Glass ou Iron Glass Plus, que eu já te mando a cotação certinha.' },
      { label: '👍 Ok, entendido', text: 'Perfeito! Qualquer coisa estou por aqui 😊' }
    ],
  };
}

// =================== HELPERS ===================

function markBotSent(jid) {
  botSentRecently.add(jid);
  setTimeout(() => botSentRecently.delete(jid), 2 * 60 * 1000);
}

function isInsideWindow(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  return h >= START_HOUR && h < END_HOUR;
}

// aplica variáveis em template
function applyTemplate(tpl, data) {
  let out = tpl || '';
  for (const [k, v] of Object.entries(data || {})) {
    out = out.replace(new RegExp(`{{${k}}}`, 'g'), v ?? '');
  }
  out = out.replace(/{{\w+}}/g, '').replace(/\n\n\n+/g, '\n\n').trim();
  return out;
}

// timestamp da msg (Baileys vem em segundos)
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
  ) return null;

  // ✅ regex corrigida para Node 22
  const dateMatch = lower.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (!dateMatch) return null;

  let d = dateMatch[1], m = dateMatch[2], y = dateMatch[3];
  if (y.length === 2) y = '20' + y;

  const timeMatch = lower.match(/(\d{1,2})\s*[:h]\s*(\d{2})/i);
  let hh = '09', mm = '00';
  if (timeMatch) {
    hh = String(timeMatch[1]).padStart(2, '0');
    mm = String(timeMatch[2]).padStart(2, '0');
  }

  const iso = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T${hh}:${mm}:00`;
  const ts = new Date(iso).getTime();
  if (isNaN(ts)) return null;
  return ts;
}

// =================== FUNIL ===================

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

  console.log('[PÓS-VENDA] Seguimento mensal ativado para', jid, '-> próxima em', EXTRA_INTERVAL_DAYS, 'dias');
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

  // remove qualquer follow-up já enfileirado para esse contato
  messageQueue = messageQueue.filter(item => !(item.jid === jid && item.kind === 'funil'));

  stopFollowUp(jid);
  console.log('[FUNIL] Pausado para', jid);
}

function blockFollowUp(jid, reason = 'STOP') {
  // Marca como bloqueado DEFINITIVO: não entra mais em nenhum fluxo (funil, agenda, mensal, programados)
  blocked[jid] = { blockedAt: Date.now(), reason };
  saveBlocked();

  // Pausa e remove funil
  pauseFollowUp(jid);
  stopFollowUp(jid);

  // Cancela todos os lembretes de agenda
  cancelAgenda(jid);

  // Cancela qualquer mensagem inicial programada
  if (scheduledStarts[jid]) {
    delete scheduledStarts[jid];
    saveProgramados();
    scheduledQueue.delete(jid);
  }

  // Limpa qualquer item já enfileirado na fila
  messageQueue = messageQueue.filter(m => m.jid !== jid);

  console.log('[FUNIL] Bloqueado definitivo para', jid);
}

// =================== AGENDA ===================

function scheduleAgenda(jid, appointmentTs, meta) {
  const now = Date.now();
  const list = [];
  const payload = meta || {};

  // Sempre que agenda é criada, paramos o funil normal e limpamos fila/programados
  stopFollowUp(jid);

  // remove qualquer follow-up já enfileirado para esse contato
  messageQueue = messageQueue.filter(item => !(item.jid === jid && item.kind === 'funil'));

  // se havia mensagem inicial programada, é descartada ao entrar em agenda
  if (scheduledStarts[jid]) {
    delete scheduledStarts[jid];
    saveProgramados();
    scheduledQueue.delete(jid);
  }

  AGENDA_OFFSETS_DAYS.forEach((days, idx) => {
    const at = appointmentTs - days * DAY_MS;
    if (at > now) {
      list.push({
        at,
        key: `agenda${idx}`,
        data: payload, // dados da confirmação (DATA, HORA, VEICULO, etc.)
      });
    }
  });

  if (list.length === 0) {
    console.log('[AGENDA] Nenhum lembrete futuro para programar ->', jid);
    return;
  }

  agendas[jid] = list.sort((a, b) => a.at - b.at);
  saveAgendas();
  console.log('[AGENDA] Lembretes programados para', jid, '->', list.map(x => x.key).join(', '));
}

function cancelAgenda(jid) {
  if (!jid) return;

  if (agendas[jid]) {
    delete agendas[jid];
    saveAgendas();
  }

  // ✅ remove lembretes já enfileirados desse cliente
  messageQueue = messageQueue.filter(m => !(m.jid === jid && m.kind === 'agenda'));

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
      if (!c.nextFollowUpAt) continue;
      if (now >= c.nextFollowUpAt) {
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
        if (now >= item.at) {
          const already = messageQueue.some(m => m.jid === jid && m.kind === 'agenda' && m.key === item.key);
          if (!already) {
            messageQueue.push({ jid, kind: 'agenda', key: item.key });
            console.log('[QUEUE] Agenda enfileirada para', jid, item.key);
          }
        }
      }
    }

    // mensagens iniciais programadas (primeiro contato)
    for (const [jid, s] of Object.entries(scheduledStarts || {})) {
      if (!s || !s.at) continue;

      if (now >= s.at) {
        const already = messageQueue.some(m => m.jid === jid && m.kind === 'startFunil');
        if (!already && !scheduledQueue.has(jid)) {
          messageQueue.push({ jid, kind: 'startFunil' });
          scheduledQueue.add(jid);
          console.log('[QUEUE] Mensagem inicial programada enfileirada para', jid);
        }
      }
    }

  }, 60 * 1000);
}

// =================== SENDER ===================

let sendingNow = false;

function startMessageSender() {
  setInterval(async () => {
    if (!sock || sendingNow) return;
    const item = messageQueue.shift();
    if (!item) return;

    // ✅ se não está conectado, devolve pra fila e espera
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

    // jitter aleatório 5–55s
    const jitterMs = 5000 + Math.floor(Math.random() * 50000);
    await new Promise(r => setTimeout(r, jitterMs));

    try {
      const { jid, kind, key } = item;

      if (kind === 'funil') {
        const c = clients[jid];
        if (!c) { sendingNow = false; return; }

        let msgKey = 'extra';

        // Cliente pós-venda: usa sempre a mensagem específica de indicação
        if (c.isClient) {
          msgKey = 'postSale30';
        } else if (c.stepIndex >= 0 && c.stepIndex <= STEPS_DAYS.length - 1) {
          msgKey = `step${c.stepIndex}`;
        }

        const texto =
          messagesConfig[msgKey] ||
          (c.isClient ? messagesConfig.postSale30 : null) ||
          messagesConfig.extra ||
          'Olá! Tudo bem?';

        c.ignoreNextFromMe = true;
        saveClients();

        await sendText(jid, texto);

        const sentAt = Date.now();
        c.lastContact = sentAt;

        if (c.isClient) {
          // fluxo mensal pós-venda: sempre a cada 30 dias
          c.stepIndex = STEPS_DAYS.length;
          c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
          console.log('[PÓS-VENDA] Follow-up mensal enviado para', jid, '-> próxima em', EXTRA_INTERVAL_DAYS, 'dias');
        } else if (c.stepIndex < STEPS_DAYS.length - 1) {
          c.stepIndex += 1;
          const dias = STEPS_DAYS[c.stepIndex];
          c.nextFollowUpAt = sentAt + dias * DAY_MS;
          console.log('[FUNIL] Follow-up enviado para', jid, '-> próxima etapa em', dias, 'dias');
        } else {
          c.stepIndex += 1;
          c.nextFollowUpAt = sentAt + EXTRA_INTERVAL_DAYS * DAY_MS;
          console.log('[FUNIL] Follow-up enviado para', jid, '-> agora será a cada', EXTRA_INTERVAL_DAYS, 'dias');
        }

        saveClients();
      }

      if (kind === 'agenda') {
        const arr = agendas[jid];

        if (!Array.isArray(arr)) {
          console.log('[AGENDA] Ignorado lembrete porque agenda não existe mais ->', jid, key);
          return;
        }

        const item = arr.find(x => x.key === key);
        if (!item) {
          console.log('[AGENDA] Ignorado lembrete porque chave não encontrada ->', jid, key);
          return;
        }

        const baseText = messagesConfig[key] || '📅 Lembrete do seu agendamento Iron Glass.';

        // Monta dados para o template
        const data = Object.assign({}, item.data || {});

        // Se não tiver DATA/HORA salvos, tenta reconstruir a partir do horário do lembrete
        if ((!data.DATA || !data.HORA) && item.at) {
          let offsetDays = null;
          if (key === 'agenda0') offsetDays = 7;
          else if (key === 'agenda1') offsetDays = 3;
          else if (key === 'agenda2') offsetDays = 1;

          if (offsetDays != null) {
            const apptTs = item.at + offsetDays * DAY_MS;
            const d = new Date(apptTs);
            const dd = String(d.getDate()).padStart(2, '0');
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const yyyy = d.getFullYear();
            const hh = String(d.getHours()).padStart(2, '0');
            const min = String(d.getMinutes()).padStart(2, '0');

            data.DATA = `${dd}/${mm}/${yyyy}`;
            data.HORA = `${hh}:${min}`;
          }
        }

        const texto = applyTemplate(baseText, data);

        await sendText(jid, texto);

        agendas[jid] = arr.filter(x => x.key !== key);
        if (agendas[jid].length === 0) delete agendas[jid];
        saveAgendas();

        console.log('[AGENDA] Lembrete enviado ->', jid, key);
      }

      if (kind === 'startFunil') {
        const data = scheduledStarts[jid];

        if (!data || !data.at) {
          console.log('[PROGRAM] Nenhum dado encontrado para mensagem programada ->', jid);
          scheduledQueue.delete(jid);
          return;
        }

        if (blocked[jid]) {
          console.log('[PROGRAM] Cliente bloqueado; ignorando mensagem programada ->', jid);
          delete scheduledStarts[jid];
          saveProgramados();
          scheduledQueue.delete(jid);
          return;
        }

        const texto =
          (data.text && data.text.trim()) ||
          messagesConfig.step0 ||
          'Olá! Tudo bem?';

        await sendText(jid, texto);
        console.log('[PROGRAM] Mensagem inicial programada enviada ->', jid);

        // depois da mensagem programada, entra no funil normal
        startFollowUp(jid);

        delete scheduledStarts[jid];
        saveProgramados();
        scheduledQueue.delete(jid);
      }


    } catch (err) {
      console.error('[ERRO] Ao enviar mensagem para', item.jid, err?.message || err);
      // devolve pra fila pra tentar depois
      messageQueue.unshift(item);
    } finally {
      sendingNow = false;
    }
  }, 60 * 1000);
}

// =================== WHATSAPP HANDLER ===================

function setupMessageHandler() {
  if (!sock) return;

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message) return;

    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;

    // ✅ normaliza JID quando WhatsApp manda @lid (Linked ID)
    let jid = remoteJid;
    if (remoteJid && remoteJid.endsWith('@lid')) {
      const real = msg.key.senderPn || msg.key.participant;
      if (real && real.endsWith('@s.whatsapp.net')) jid = real;
    }

    if (
      !remoteJid ||
      remoteJid === 'status@broadcast' ||
      remoteJid.endsWith('@g.us') ||
      remoteJid.endsWith('@newsletter')
    ) return;

    // ✅ IGNORAR HISTÓRICO / REPLAY
    const msgMs = getMsgMs(msg);
    if (Date.now() - msgMs > RECENT_WINDOW_MS) {
      console.log('[HIST] Ignorando msg antiga ->', jid);
      return;
    }

    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
      '';

    const lower = (body || '').toLowerCase();
    const c = clients[jid];

    // --------- MINHA MSG (SOMENTE VOCÊ CONTROLA STOP/PAUSE/AGENDA) ---------
    if (fromMe) {
      if (botSentRecently.has(jid)) {
        console.log('[BOT MSG] Ignorada (botSentRecently) ->', jid);
        return;
      }

      // comandos manuais SEMPRE antes do ignoreNextFromMe
      if (lower.includes(CMD_STOP)) {
        if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
        blockFollowUp(jid, 'MANUAL_STOP');
        return;
      }
      if (lower.includes(CMD_PAUSE)) {
        if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
        pauseFollowUp(jid);
        return;
      }

      if (lower.includes(CMD_CLIENT)) {
        if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }

        // Pós-venda: marca como cliente, cancela agenda e funil normal e ativa fluxo mensal
        cancelAgenda(jid);

        // remove qualquer follow-up de funil já enfileirado
        messageQueue = messageQueue.filter(item => !(item.jid === jid && item.kind === 'funil'));

        // descarta mensagem inicial programada, se existir
        if (scheduledStarts[jid]) {
          delete scheduledStarts[jid];
          saveProgramados();
          scheduledQueue.delete(jid);
        }

        startPostSaleMonthly(jid);
        console.log('[PÓS-VENDA] Marcado como cliente via comando #cliente ->', jid);
        return;
      }

      // detecta confirmação manual de agenda
      const apptTs = parseAgendaConfirmation(body);
      if (apptTs) {
        if (c && c.ignoreNextFromMe) { c.ignoreNextFromMe = false; saveClients(); }
        scheduleAgenda(jid, apptTs);
        stopFollowUp(jid);
        console.log('[AGENDA] Confirmação detectada na sua msg -> lembretes criados', jid);
        return;
      }

      // ignora eco do bot (funil enviado)
      if (c && c.ignoreNextFromMe) {
        c.ignoreNextFromMe = false;
        saveClients();
        console.log('[BOT MSG] Ignorada para não reiniciar funil ->', jid);
        return;
      }

      // log da sua mensagem (manual) no painel de conversas
      if (body && body.trim() && !body.trim().startsWith('#')) {
        upsertChatMessage(jid, true, body, Date.now());
      }

      if (!blocked[jid]) {
        // Se o cliente tem agenda ativa, NÃO reinicia funil normal.
        if (agendas[jid] && Array.isArray(agendas[jid]) && agendas[jid].length > 0) {
          console.log('[MINHA MSG] Cliente com agenda ativa; não reinicia funil ->', jid);
        } else {
          console.log('[MINHA MSG] Reiniciando funil para', jid);
          startFollowUp(jid);
        }
      }
      return;
    }

    // --------- MSG DO CLIENTE ---------
    console.log('[CLIENTE]', jid, '->', body);
    upsertChatMessage(jid, false, body, Date.now());

    // ❌ REMOVIDO auto-stop por palavras do cliente (para não sair por acidente)

    if (blocked[jid]) return;

    // PAUSA de 72h: enquanto durar a janela, não reinicia funil nem entra em novos fluxos
    if (paused[jid]) {
      const pausedAt = paused[jid].pausedAt || paused[jid];
      const PAUSE_MS = 72 * 60 * 60 * 1000; // 72 horas
      const until = pausedAt + PAUSE_MS;

      if (Date.now() < until) {
        console.log('[PAUSE] Cliente em pausa até', new Date(until).toISOString(), '-> não reinicia funil', jid);
        return;
      } else {
        delete paused[jid];
        savePaused();
        console.log('[PAUSE] Pausa expirada, cliente volta ao funil ->', jid);
      }
    }

    const c2 = clients[jid];

    // Se for cliente pós-venda, não reinicia funil de pré-venda ao receber mensagem;
    // apenas atualiza último contato e mantém o fluxo mensal.
    if (c2 && c2.isClient) {
      c2.lastContact = Date.now();
      saveClients();
      console.log('[PÓS-VENDA] Mensagem recebida de cliente; mantém apenas fluxo mensal ->', jid);
      return;
    }

    startFollowUp(jid);
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
  reconnectAttempts += 1;
  const delay = Math.min(30000, 3000 * reconnectAttempts); // 3s, 6s, 9s ... até 30s
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
const server = http.createServer(app);
let io = new Server(server, { cors: { origin: '*'} });
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// socket.io - conversas em tempo real
io.on('connection', (socket) => {
  try {
    socket.emit('init', { chats: listChats(), quickReplies: messagesConfig.quickReplies || [] });
  } catch (e) {}

  socket.on('get_chats', () => {
    socket.emit('chats', listChats());
  });

  socket.on('open_chat', (jid) => {
    if (!jid) return;
    const c = ensureChat(jid);
    c.unread = 0;
    saveChats();
    socket.emit('chat_history', { jid, messages: c.messages || [] });
    io.emit('chat_update', {
      jid: c.jid,
      phone: c.phone,
      updatedAt: c.updatedAt || Date.now(),
      unread: 0,
      pinnedAt: c.pinnedAt || 0,
      pinned: !!(c.pinnedAt),
      lastText: (c.messages && c.messages.length) ? c.messages[c.messages.length-1].text : '',
      lastFromMe: (c.messages && c.messages.length) ? !!c.messages[c.messages.length-1].fromMe : false,
      lastTs: (c.messages && c.messages.length) ? c.messages[c.messages.length-1].ts : (c.updatedAt || 0),
    });
  socket.on('toggle_pin', (jid) => {
    try {
      if (!jid) return;
      const c = ensureChat(jid);
      c.pinnedAt = c.pinnedAt ? 0 : Date.now();
      saveChats();
      // Atualiza todos os painéis conectados
      io.emit('chat_update', {
        jid: c.jid,
        phone: c.phone,
        updatedAt: c.updatedAt || Date.now(),
        unread: c.unread || 0,
        pinnedAt: c.pinnedAt || 0,
        pinned: !!(c.pinnedAt),
        lastText: (c.messages && c.messages.length) ? c.messages[c.messages.length-1].text : '',
        lastFromMe: (c.messages && c.messages.length) ? !!c.messages[c.messages.length-1].fromMe : false,
        lastTs: (c.messages && c.messages.length) ? c.messages[c.messages.length-1].ts : (c.updatedAt || 0),
      });
      io.emit('chats', listChats());
    } catch (e) {}
  });

  });

  socket.on('send_message', async (payload) => {
    try {
      const jid = payload?.jid;
      const text = (payload?.text || '').toString().trim();
      if (!jid || !text) return;
      await sendText(jid, text);
      socket.emit('send_ok', { jid });
    } catch (e) {
      socket.emit('send_err', { message: e?.message || 'Erro ao enviar' });
    }
  });

  socket.on('get_quick_replies', () => {
    socket.emit('quick_replies', messagesConfig.quickReplies || []);
  });
});


function htmlEscape(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =================== CHAT (CONVERSAS) ===================

function phoneFromJid(jid) {
  if (!jid) return '';
  return String(jid).replace('@s.whatsapp.net','').replace('@lid','');
}

function ensureChat(jid) {
  if (!chatStore[jid]) {
    chatStore[jid] = {
      jid,
      phone: phoneFromJid(jid),
      updatedAt: Date.now(),
      unread: 0,
      pinnedAt: 0,
      messages: [],
    };
  }
  if (!Array.isArray(chatStore[jid].messages)) chatStore[jid].messages = [];
  return chatStore[jid];
}

function trimMessages(arr, max = 200) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

function upsertChatMessage(jid, fromMe, text, ts) {
  if (!jid || !text) return;
  const c = ensureChat(jid);
  const msg = {
    id: String(ts || Date.now()) + '_' + Math.random().toString(16).slice(2),
    fromMe: !!fromMe,
    text: String(text),
    ts: ts || Date.now(),
  };
  c.messages.push(msg);
  c.messages = trimMessages(c.messages);
  c.updatedAt = msg.ts;
  if (!fromMe) c.unread = (c.unread || 0) + 1;
  saveChats();
  if (io) {
    io.emit('chat_update', {
      jid: c.jid,
      phone: c.phone,
      updatedAt: c.updatedAt,
      unread: c.unread || 0,
      pinnedAt: c.pinnedAt || 0,
      pinned: !!(c.pinnedAt),
      lastText: msg.text,
      lastFromMe: msg.fromMe,
      lastTs: msg.ts,
    });
    io.emit('chat_message', { jid: c.jid, message: msg });
  }
}

function listChats() {
  const items = Object.values(chatStore || {}).map(c => ({
    jid: c.jid,
    phone: c.phone || phoneFromJid(c.jid),
    updatedAt: c.updatedAt || 0,
    unread: c.unread || 0,
    pinnedAt: c.pinnedAt || 0,
    pinned: !!(c.pinnedAt),
    lastText: (c.messages && c.messages.length) ? c.messages[c.messages.length-1].text : '',
    lastFromMe: (c.messages && c.messages.length) ? !!c.messages[c.messages.length-1].fromMe : false,
    lastTs: (c.messages && c.messages.length) ? c.messages[c.messages.length-1].ts : (c.updatedAt || 0),
  }));
  // Pinned primeiro (mais recente em cima), depois por última atividade
  items.sort((a,b) => {
    const ap = a.pinnedAt || 0;
    const bp = b.pinnedAt || 0;
    if (ap && !bp) return -1;
    if (!ap && bp) return 1;
    if (bp !== ap) return bp - ap;
    return (b.updatedAt||0) - (a.updatedAt||0);
  });
  return items;
}

async function sendText(jid, text) {
  if (!sock || !isConnected) throw new Error('WhatsApp desconectado');
  if (!jid || !text) return;
  // DRY_RUN: não envia nada para ninguém (modo seguro de testes)
  if (DRY_RUN) {
    console.log(`[DRY_RUN] (não enviado) -> ${jid}: ${String(text).slice(0,120)}`);
    // Opcional: registra no painel como 'simulado'
    upsertChatMessage(jid, true, `[TESTE - NÃO ENVIADO]
${text}`, Date.now());
    return;
  }
  markBotSent(jid);
  await sock.sendMessage(jid, { text });
  upsertChatMessage(jid, true, text, Date.now());
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


app.get('/admin/chat', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Painel Iron Glass - Conversas</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e5e7eb;margin:0}
    .top{padding:14px 16px;border-bottom:1px solid #1f2937;background:#020617;display:flex;gap:10px;align-items:center}
    .logo{width:32px;height:32px;border-radius:10px;background:#facc15;color:#111827;font-weight:900;display:flex;align-items:center;justify-content:center}
    .top a{color:#93c5fd;text-decoration:none;font-size:.9rem}
    .wrap{display:grid;grid-template-columns:320px 1fr 320px;height:calc(100vh - 61px)}
    .col{border-right:1px solid #1f2937;overflow:hidden}
    .col:last-child{border-right:none}
    .list{height:100%;display:flex;flex-direction:column}
    .search{padding:10px;border-bottom:1px solid #1f2937}
    input{width:100%;border-radius:10px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;padding:10px 12px;box-sizing:border-box}
    .items{overflow:auto}
    .item{padding:10px 12px;border-bottom:1px solid #111827;cursor:pointer}
    .item:hover{background:#0b1220}
    .item.active{background:#0b1220;outline:1px solid rgba(250,204,21,.35)}
    .row{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .phone{font-weight:700}
    .badge{background:#ef4444;color:#fff;border-radius:999px;padding:2px 8px;font-size:.75rem}
    .snippet{color:#9ca3af;font-size:.82rem;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .time{color:#9ca3af;font-size:.75rem}
    .pinbtn{border:1px solid #374151;background:#0b1220;color:#e5e7eb;border-radius:999px;padding:3px 8px;font-size:.75rem;font-weight:800;cursor:pointer}
    .pinbtn.on{border-color:rgba(250,204,21,.7);color:#facc15}
    .pinbtn:hover{filter:brightness(1.1)}
    .chat{height:100%;display:flex;flex-direction:column}
    .chatHeader{padding:12px 14px;border-bottom:1px solid #1f2937;background:#020617}
    .chatHeader .title{font-weight:800}
    .msgs{flex:1;overflow:auto;padding:14px;background:#0b1220}
    .bubble{max-width:78%;padding:10px 12px;border-radius:16px;margin:6px 0;white-space:pre-wrap;word-break:break-word;border:1px solid #1f2937}
    .me{margin-left:auto;background:#052e16}
    .them{margin-right:auto;background:#111827}
    .meta{font-size:.72rem;color:#9ca3af;margin-top:4px}
    .composer{padding:12px;border-top:1px solid #1f2937;background:#020617;display:flex;gap:10px}
    .composer textarea{flex:1;min-height:46px;max-height:140px;resize:vertical;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;padding:10px 12px;font-size:.9rem}
    button{border:none;border-radius:12px;padding:10px 14px;background:#facc15;color:#111827;font-weight:800;cursor:pointer}
    button:disabled{opacity:.4;cursor:not-allowed}
    .quick{height:100%;display:flex;flex-direction:column}
    .quickHeader{padding:12px 14px;border-bottom:1px solid #1f2937;background:#020617}
    .quickBtns{padding:12px;overflow:auto}
    .qbtn{width:100%;text-align:left;margin:0 0 10px 0;padding:10px 12px;border-radius:14px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;cursor:pointer}
    .qbtn:hover{outline:1px solid rgba(250,204,21,.35)}
    .toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:#111827;border:1px solid #374151;border-radius:999px;padding:10px 14px;color:#e5e7eb;font-size:.86rem;display:none}
    @media (max-width: 980px){ .wrap{grid-template-columns:1fr} .col{border-right:none} #quickCol{display:none} }
  </style>
</head>
<body>
  <div class="top">
    <div class="logo">IG</div>
    <div style="flex:1">
      <div style="font-weight:900">Conversas ao vivo</div>
      <div style="color:#9ca3af;font-size:.82rem">Veja as mensagens em tempo real e responda com botões rápidos.</div>
    </div>
    <a href="/admin/quick">Respostas rápidas ✏️</a>
    <a href="/admin">← Voltar ao painel</a>
  </div>

  <div class="wrap">
    <div class="col">
      <div class="list">
        <div class="search">
          <input id="search" placeholder="Buscar por número..." />
        </div>
        <div id="chatList" class="items"></div>
      </div>
    </div>

    <div class="col">
      <div class="chat">
        <div class="chatHeader">
          <div class="title" id="chatTitle">Selecione uma conversa</div>
          <div class="time" id="chatSub"></div>
        </div>
        <div id="msgs" class="msgs"></div>
        <div class="composer">
          <textarea id="text" placeholder="Escreva uma mensagem..."></textarea>
          <button id="sendBtn" disabled>Enviar</button>
        </div>
      </div>
    </div>

    <div class="col" id="quickCol">
      <div class="quick">
        <div class="quickHeader">
          <div style="font-weight:900">Respostas rápidas</div>
          <div style="color:#9ca3af;font-size:.82rem">Clique para enviar na conversa aberta.</div>
        </div>
        <div id="quickBtns" class="quickBtns"></div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io();
    let chats = [];
    let currentJid = null;

    const elList = document.getElementById('chatList');
    const elMsgs = document.getElementById('msgs');
    const elTitle = document.getElementById('chatTitle');
    const elSub = document.getElementById('chatSub');
    const elSearch = document.getElementById('search');
    const elText = document.getElementById('text');
    const elSend = document.getElementById('sendBtn');
    const elQuick = document.getElementById('quickBtns');
    const elToast = document.getElementById('toast');

    function fmtTime(ts){
      try{
        const d = new Date(ts);
        const dd = String(d.getDate()).padStart(2,'0');
        const mm = String(d.getMonth()+1).padStart(2,'0');
        const hh = String(d.getHours()).padStart(2,'0');
        const mi = String(d.getMinutes()).padStart(2,'0');
        return dd+'/'+mm+' '+hh+':'+mi;
      }catch(e){ return ''; }
    }

    function sortChats(){
      chats.sort((a,b) => {
        const ap = a.pinnedAt || 0;
        const bp = b.pinnedAt || 0;
        if (ap && !bp) return -1;
        if (!ap && bp) return 1;
        if (bp !== ap) return bp - ap;
        return (b.updatedAt||0) - (a.updatedAt||0);
      });
    }

    function toast(msg){
      elToast.textContent = msg;
      elToast.style.display = 'block';
      clearTimeout(window.__t);
      window.__t = setTimeout(()=> elToast.style.display='none', 2800);
    }

    function renderList(filter=''){
      const f = (filter||'').trim();
      elList.innerHTML = '';
      chats
        .filter(c => !f || (c.phone||'').includes(f))
        .forEach(c => {
          const div = document.createElement('div');
          div.className = 'item' + (c.jid === currentJid ? ' active' : '');
          div.onclick = () => openChat(c.jid);

          const row = document.createElement('div');
          row.className = 'row';

          const left = document.createElement('div');
          left.className = 'phone';
          left.textContent = (c.pinnedAt ? '📌 ' : '') + (c.phone || c.jid);

          const right = document.createElement('div');
          right.style.display = 'flex';
          right.style.gap = '8px';
          right.style.alignItems = 'center';

          const time = document.createElement('div');
          time.className = 'time';
          time.textContent = fmtTime(c.updatedAt || c.lastTs);

          const pin = document.createElement('button');
          pin.className = 'pinbtn' + (c.pinnedAt ? ' on' : '');
          pin.textContent = '📌';
          pin.title = c.pinnedAt ? 'Desafixar' : 'Fixar';
          pin.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            socket.emit('toggle_pin', c.jid);
          };

          right.appendChild(time);
          right.appendChild(pin);

          row.appendChild(left);
          row.appendChild(right);

          if (c.unread && c.unread > 0){
            const b = document.createElement('span');
            b.className = 'badge';
            b.textContent = c.unread;
            row.appendChild(b);
          }

          const snip = document.createElement('div');
          snip.className = 'snippet';
          snip.textContent = c.lastText || '';

          div.appendChild(row);
          div.appendChild(snip);
          elList.appendChild(div);
        });
    }

    function renderQuick(items){
      elQuick.innerHTML = '';
      (items||[]).forEach(q => {
        const b = document.createElement('button');
        b.className = 'qbtn';
        b.textContent = q.label || 'Resposta';
        b.onclick = () => {
          if (!currentJid) return toast('Selecione uma conversa primeiro');
          socket.emit('send_message', { jid: currentJid, text: q.text || '' });
        };
        elQuick.appendChild(b);
      });

      if (!items || items.length === 0){
        const p = document.createElement('div');
        p.style.color = '#9ca3af';
        p.style.fontSize = '.85rem';
        p.textContent = 'Nenhuma resposta rápida configurada.';
        elQuick.appendChild(p);
      }
    }

    function appendMsg(m){
      const wrap = document.createElement('div');
      const bubble = document.createElement('div');
      bubble.className = 'bubble ' + (m.fromMe ? 'me' : 'them');
      bubble.textContent = m.text || '';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = fmtTime(m.ts);

      wrap.appendChild(bubble);
      wrap.appendChild(meta);
      elMsgs.appendChild(wrap);
      elMsgs.scrollTop = elMsgs.scrollHeight;
    }

    function openChat(jid){
      currentJid = jid;
      elMsgs.innerHTML = '';
      elTitle.textContent = 'Carregando...';
      elSub.textContent = '';
      elSend.disabled = true;
      socket.emit('open_chat', jid);
      renderList(elSearch.value);
    }

    elSearch.addEventListener('input', () => renderList(elSearch.value));

    elText.addEventListener('input', () => {
      elSend.disabled = !currentJid || !(elText.value||'').trim();
    });

    elSend.addEventListener('click', () => {
      const t = (elText.value||'').trim();
      if (!currentJid || !t) return;
      socket.emit('send_message', { jid: currentJid, text: t });
      elText.value = '';
      elSend.disabled = true;
    });

    socket.on('init', (data) => {
      chats = data.chats || [];
      sortChats();
      renderList();
      renderQuick(data.quickReplies || []);
    });

    socket.on('chats', (items) => {
      chats = items || [];
      sortChats();
      renderList(elSearch.value);
    });

    socket.on('chat_update', (chat) => {
      if (!chat || !chat.jid) return;
      const i = chats.findIndex(c => c.jid === chat.jid);
      if (i >= 0) chats[i] = Object.assign(chats[i], chat);
      else chats.unshift(chat);
      sortChats();
      renderList(elSearch.value);
    });

    socket.on('chat_history', (data) => {
      if (!data || !data.jid) return;
      currentJid = data.jid;
      elTitle.textContent = (data.jid || '').replace('@s.whatsapp.net','');
      elSub.textContent = 'JID: ' + data.jid;
      (data.messages || []).forEach(appendMsg);
      elSend.disabled = !(elText.value||'').trim();
    });

    socket.on('chat_message', (payload) => {
      if (!payload || payload.jid !== currentJid) return;
      appendMsg(payload.message || {});
    });

    socket.on('send_ok', () => toast('Mensagem enviada ✅'));
    socket.on('send_err', (e) => toast((e && e.message) ? e.message : 'Erro ao enviar'));
  </script>
</body>
</html>
`;
  res.send(html);
});


app.get('/admin/quick', (req, res) => {
  const items = Array.isArray(messagesConfig.quickReplies) ? messagesConfig.quickReplies : [];
  const lines = items.map(it => {
    const label = (it.label || '').replace(/\|/g,'-');
    const text = (it.text || '').replace(/\r?\n/g,'\\n').replace(/\|/g,'-');
    return label + '|' + text;
  }).join('\n');

  const html = `
<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Respostas rápidas</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e5e7eb;margin:0}
    .c{max-width:980px;margin:26px auto;background:#020617;border:1px solid #1f2937;border-radius:16px;padding:18px}
    a{color:#93c5fd;text-decoration:none}
    textarea{width:100%;min-height:360px;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;padding:12px;box-sizing:border-box;font-size:.9rem}
    button{border:none;border-radius:12px;padding:10px 14px;background:#facc15;color:#111827;font-weight:800;cursor:pointer;margin-top:12px}
    .hint{color:#9ca3af;font-size:.85rem;line-height:1.4}
    code{background:#0b1220;border:1px solid #1f2937;border-radius:10px;padding:2px 6px}
  </style>
</head>
<body>
  <div class="c">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <div style="font-weight:900;font-size:1.05rem">Respostas rápidas do painel de conversas</div>
      <a href="/admin/chat">← Voltar</a>
    </div>
    <p class="hint">
      Formato: <code>TÍTULO|TEXTO</code> (1 por linha). Para quebrar linha no texto, use <code>\n</code>.
    </p>
    <form method="POST" action="/admin/quick">
      <textarea name="lines" placeholder="Ex:\nEnviar horários|Perfeito! Me diz manhã ou tarde?\nEndereço|Estamos na ...">${htmlEscape(lines)}</textarea>
      <button type="submit">Salvar respostas rápidas</button>
    </form>
  </div>
</body>
</html>
`;
  res.send(html);
});

app.post('/admin/quick', (req, res) => {
  try {
    const raw = (req.body.lines || '').toString();
    const rows = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const items = [];
    for (const row of rows) {
      const parts = row.split('|');
      const label = (parts[0] || '').trim();
      const text = (parts.slice(1).join('|') || '').trim().replace(/\\n/g, '\n');
      if (!label || !text) continue;
      items.push({ label, text });
    }
    messagesConfig.quickReplies = items;
    saveMessages();
  } catch (e) {
    console.error('[ERRO] salvar quick replies', e);
  }
  res.redirect('/admin/chat');
});


// =====================
// Painel (versão organizada por abas)
// =====================
app.get('/admin', (req, res) => {
  const tab = String(req.query.tab || 'funil').toLowerCase();
  const m = messagesConfig;
  const agendasList = renderAgendasList();
  const programList = renderProgramList();

  const nav = `
    <div class="nav">
      <a class="navbtn ${tab==='funil' ? 'active' : ''}" href="/admin?tab=funil">✅ Funil</a>
      <a class="navbtn ${tab==='program' ? 'active' : ''}" href="/admin?tab=program">⏳ Programados</a>
      <a class="navbtn ${tab==='agenda' ? 'active' : ''}" href="/admin?tab=agenda">📅 Agenda</a>
      <a class="navbtn ${tab==='confirm' ? 'active' : ''}" href="/admin?tab=confirm">✅ Confirmação</a>
      <a class="navbtn" href="/admin/chat">💬 Chat ao vivo</a>
      <a class="navbtn" href="/admin/quick">⚡ Respostas rápidas</a>
      <a class="navbtn" href="/admin/full">🧩 Painel completo</a>
    </div>
  `;

  const baseStyles = `
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e5e7eb;
        margin: 0;
      }
      .container {
        max-width: 1060px;
        margin: 18px auto;
        padding: 20px;
        background: #111827;
        border-radius: 16px;
        border: 1px solid #1f2937;
      }
      h1 { margin: 0 0 6px 0; font-size: 1.35rem; }
      .logo {
        display:inline-flex;align-items:center;justify-content:center;
        width:32px;height:32px;border-radius:999px;border:1px solid #facc15;
        font-weight:700;font-size:.8rem;color:#facc15;margin-right:8px;
      }
      .subtitle { color:#9ca3af;font-size:.9rem;margin-bottom:12px; }
      .nav{display:flex;gap:10px;margin:14px 0 18px 0;flex-wrap:wrap;}
      .navbtn{
        background:#111827;border:1px solid #374151;color:#e5e7eb;
        padding:8px 12px;border-radius:999px;cursor:pointer;
        text-decoration:none;font-weight:700;font-size:.9rem;
      }
      .navbtn:hover{filter:brightness(1.06);}
      .navbtn.active{background:#facc15;color:#111827;border-color:#facc15;}
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
      button {
        background:#facc15;color:#111827;border:none;border-radius:999px;
        padding:9px 14px;font-weight:800;cursor:pointer;
      }
      button:hover{filter:brightness(1.05);}
      .muted{color:#9ca3af;font-size:.85rem;}
      .footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap;}
      .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid #4b5563;font-size:.78rem;color:#9ca3af;}
      .badge-dot{width:8px;height:8px;border-radius:999px;background:#22c55e;}
      hr{border:0;border-top:1px solid #1f2937;margin:18px 0;}
      @media (max-width: 768px) { .grid { grid-template-columns:1fr; } .container{margin:10px;} }
    </style>
  `;

  let content = '';

  if (tab === 'program') {
    content = `
      <div class="card" style="margin-bottom:14px;">
        <h2>⏳ Programar primeira mensagem (início futuro)</h2>
        <small>Útil quando o cliente diz “falo em fevereiro” etc. O funil fica pausado até essa data.</small>
      </div>

      <form method="POST" action="/admin/program">
        <input type="hidden" name="returnTab" value="program" />
        <div class="grid">
          <div class="card">
            <h2>Telefone</h2>
            <label for="programPhone">Número (com DDD)</label>
            <input id="programPhone" name="programPhone" placeholder="5511999999999" />
          </div>

          <div class="card">
            <h2>Data / Hora</h2>
            <label for="programDate">Data</label>
            <input id="programDate" name="programDate" type="date" />
            <label for="programTime">Hora</label>
            <input id="programTime" name="programTime" type="time" value="09:00" />
          </div>

          <div class="card" style="grid-column:1/-1;">
            <h2>Mensagem</h2>
            <label for="programText">Texto</label>
            <textarea id="programText" name="programText" placeholder="Olá! Combinado de falar na data..."></textarea>
            <div style="margin-top:12px;">
              <button type="submit">Programar mensagem</button>
            </div>
          </div>

          <div class="card" style="grid-column:1/-1;">
            <h2 style="margin:0 0 4px 0;">Mensagens programadas</h2>
            <small class="muted">Clientes que vão receber o primeiro contato em uma data futura.</small>
            <div style="margin-top:10px;">${programList}</div>
          </div>
        </div>
      </form>
    `;
  } else if (tab === 'agenda') {
    content = `
      <div class="card" style="margin-bottom:14px;">
        <h2>📅 Programação de agenda</h2>
        <small>Programa lembretes de confirmação (7/3/1 dia antes). Pode (opcional) enviar a confirmação na hora.</small>
      </div>

      <form method="POST" action="/admin/agenda">
        <input type="hidden" name="returnTab" value="agenda" />
        <div class="grid">
          <div class="card">
            <h2>Cliente</h2>
            <label for="phone">Telefone (com DDD)</label>
            <input id="phone" name="phone" placeholder="5511999999999" />
          </div>

          <div class="card">
            <h2>Data / Hora</h2>
            <label for="date">Data</label>
            <input id="date" name="date" type="date" />
            <label for="time">Hora</label>
            <input id="time" name="time" type="time" />
          </div>

          <div class="card" style="grid-column:1/-1;">
            <h2>Dados do serviço</h2>
            <small>Usados no template de confirmação: {{DATA}}, {{HORA}}, {{VEICULO}}, {{PRODUTO}}, {{VALOR}}, {{SINAL}}, {{PAGAMENTO}}</small>
            <div class="grid" style="margin-top:8px;">
              <div>
                <label for="vehicle">Veículo</label>
                <input id="vehicle" name="vehicle" placeholder="BYD Dolphin 2024" />
              </div>
              <div>
                <label for="product">Produto</label>
                <input id="product" name="product" placeholder="Iron Glass Plus" />
              </div>
              <div>
                <label for="valor">Valor</label>
                <input id="valor" name="valor" placeholder="R$ 12.900" />
              </div>
              <div>
                <label for="sinal">Sinal</label>
                <input id="sinal" name="sinal" placeholder="R$ 1.000" />
              </div>
              <div style="grid-column:1/-1;">
                <label for="pagamento">Forma de pagamento</label>
                <input id="pagamento" name="pagamento" placeholder="PIX confirmado" />
              </div>
            </div>

            <label style="display:flex;align-items:center;gap:6px;margin-top:10px;">
              <input type="checkbox" name="sendConfirm" />
              Enviar mensagem de confirmação agora
            </label>

            <div style="margin-top:12px;">
              <button type="submit">Programar lembretes</button>
            </div>
          </div>
        </div>
      </form>

      <div class="footer">
        <div class="badge"><span class="badge-dot"></span> Envio automático só entre ${START_HOUR}:00 e ${END_HOUR}:00</div>
      </div>
    `;
  } else if (tab === 'confirm') {
    content = `
      <div class="card" style="margin-bottom:14px;">
        <h2>✅ Confirmação de agenda</h2>
        <small>Textos dos lembretes (7/3/1 dia antes) + template de confirmação.</small>
      </div>

      <form method="POST" action="/admin/mensajes">
        <input type="hidden" name="returnTab" value="confirm" />
        <div class="grid">
          <div class="card">
            <h2>7 dias antes</h2>
            <label for="agenda0">Mensagem:</label>
            <textarea id="agenda0" name="agenda0">${htmlEscape(m.agenda0 || '')}</textarea>
          </div>

          <div class="card">
            <h2>3 dias antes</h2>
            <label for="agenda1">Mensagem:</label>
            <textarea id="agenda1" name="agenda1">${htmlEscape(m.agenda1 || '')}</textarea>
          </div>

          <div class="card">
            <h2>1 dia antes</h2>
            <label for="agenda2">Mensagem:</label>
            <textarea id="agenda2" name="agenda2">${htmlEscape(m.agenda2 || '')}</textarea>
          </div>

          <div class="card" style="grid-column:1/-1;">
            <h2>Template de confirmação</h2>
            <small>Variáveis: {{DATA}}, {{HORA}}, {{VEICULO}}, {{PRODUTO}}, {{VALOR}}, {{SINAL}}, {{PAGAMENTO}}</small>
            <label for="confirmTemplate">Mensagem:</label>
            <textarea id="confirmTemplate" name="confirmTemplate">${htmlEscape(m.confirmTemplate || '')}</textarea>
          </div>
        </div>

        <div class="footer">
          <div class="badge"><span class="badge-dot"></span> Envio automático só entre ${START_HOUR}:00 e ${END_HOUR}:00</div>
          <button type="submit">Salvar confirmação</button>
        </div>
      </form>

      <hr />

      <div class="card">
        <h2>Agendas confirmadas</h2>
        <small>Clientes com lembretes de confirmação ativos.</small>
        <div style="margin-top:10px;">${agendasList}</div>
      </div>
    `;
  } else { // funil (default)
    content = `
      <div class="card" style="margin-bottom:14px;">
        <h2>✅ Funil automático</h2>
        <small>Mensagens para 3, 5, 7, 15 dias + pós-venda.</small>
      </div>

      <form method="POST" action="/admin/mensajes">
        <input type="hidden" name="returnTab" value="funil" />
        <div class="grid">
          <div class="card">
            <h2>Etapa 1 • 3 dias</h2>
            <label for="step0">Mensagem:</label>
            <textarea id="step0" name="step0">${htmlEscape(m.step0)}</textarea>
          </div>

          <div class="card">
            <h2>Etapa 2 • 5 dias</h2>
            <label for="step1">Mensagem:</label>
            <textarea id="step1" name="step1">${htmlEscape(m.step1)}</textarea>
          </div>

          <div class="card">
            <h2>Etapa 3 • 7 dias</h2>
            <label for="step2">Mensagem:</label>
            <textarea id="step2" name="step2">${htmlEscape(m.step2)}</textarea>
          </div>

          <div class="card">
            <h2>Etapa 4 • 15 dias</h2>
            <label for="step3">Mensagem:</label>
            <textarea id="step3" name="step3">${htmlEscape(m.step3)}</textarea>
          </div>

          <div class="card" style="grid-column:1/-1;">
            <h2>Mensagens extras</h2>
            <small>Opcional: mensagens extras / variações.</small>
            <label for="extra">Extra:</label>
            <textarea id="extra" name="extra">${htmlEscape(m.extra || '')}</textarea>
          </div>

          <div class="card" style="grid-column:1/-1;">
            <h2>Pós-venda • a cada 30 dias</h2>
            <label for="postSale30">Mensagem:</label>
            <textarea id="postSale30" name="postSale30">${htmlEscape(m.postSale30 || '')}</textarea>
          </div>
        </div>

        <div class="footer">
          <div class="badge"><span class="badge-dot"></span> Envio automático só entre ${START_HOUR}:00 e ${END_HOUR}:00</div>
          <button type="submit">Salvar funil</button>
        </div>
      </form>
    `;
  }

  const html = `
    <!DOCTYPE html>
    <html lang="pt-br">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Painel do Bot</title>
      ${baseStyles}
    </head>
    <body>
      <div class="container">
        <h1><span class="logo">IG</span>Painel do Bot</h1>
        <div class="subtitle">Tudo separado em abas (sem perder nada).</div>
        ${nav}
        ${content}
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

app.get('/admin/full', (req, res) => {
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
  
    .nav{display:flex;gap:10px;margin:14px 0 18px 0;flex-wrap:wrap;}
    .navbtn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-radius:999px;background:#fbbf24;color:#111827;text-decoration:none;font-weight:700;font-size:.9rem;}
    .navbtn:hover{filter:brightness(1.05);}
</style>
</head>
<body>
  <div class="container">
    <h1><span class="logo">IG</span>Painel do Bot</h1>
    <div class="subtitle">
      Funil automático no topo. Confirmação de agenda abaixo.
      <br/><small>Envio somente entre ${START_HOUR}:00 e ${END_HOUR}:00.</small>
    </div>

        <div class=\"nav\">
      <a class=\"navbtn\" href=\"/admin/chat\">💬 Conversas em tempo real</a>
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
  const returnTab = (req.body.returnTab || 'funil');
  res.redirect('/admin?tab=' + encodeURIComponent(returnTab));
});

// agenda via painel (programa 7/3/1 e opcionalmente envia confirmação)
app.post('/admin/agenda', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  const date = req.body.date;
  const time = req.body.time;

  if (!phone || !date || !time) return res.redirect('/admin?tab=agenda');

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
        await sendText(jid, text);
        console.log('[AGENDA] Confirmação enviada pelo painel ->', jid);
      } catch (e) {
        console.error('[ERRO] Ao enviar confirmação pelo painel', e);
      }
    }
  }

  res.redirect('/admin?tab=agenda');
});

// cancelar agenda pelo painel
app.post('/admin/agenda/delete', (req, res) => {
  const jid = req.body.jid;
  cancelAgenda(jid);
  res.redirect('/admin?tab=confirm');
});


// programar primeira mensagem do funil via painel
app.post('/admin/program', (req, res) => {
  const phoneRaw = req.body.programPhone || '';
  const date = req.body.programDate;
  const time = req.body.programTime || '09:00';
  const text = (req.body.programText || '').trim();

  const phone = phoneRaw.replace(/\D/g, '');
  if (!phone || !date) return res.redirect('/admin?tab=program');

  const jid = phone.startsWith('55')
    ? `${phone}@s.whatsapp.net`
    : `55${phone}@s.whatsapp.net`;

  const ts = new Date(`${date}T${time || '09:00'}:00`).getTime();
  if (!ts || Number.isNaN(ts)) return res.redirect('/admin?tab=program');

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
  res.redirect('/admin?tab=program');
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
  res.redirect('/admin?tab=program');
});

// =================== START ===================

loadAll();
startScheduleChecker();
startMessageSender();
startBot();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Painel web disponível em http://localhost:${PORT}/admin`);
  console.log(`💬 Conversas ao vivo em http://localhost:${PORT}/admin/chat`);
});
