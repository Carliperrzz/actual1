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

// Arquivos de persistência
const DATA_FILE = path.join(__dirname, 'clientes.json');
const MSG_FILE = path.join(__dirname, 'mensajes.json');
const BLOCK_FILE = path.join(__dirname, 'bloqueados.json');
const PAUSE_FILE = path.join(__dirname, 'pausados.json');
const AGENDA_FILE = path.join(__dirname, 'agendas.json');
const PROGRAM_FILE = path.join(__dirname, 'programados.json');


let clients = {};
let messagesConfig = {};
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
  blocked = loadJSON(BLOCK_FILE, {});
  paused = loadJSON(PAUSE_FILE, {});
  agendas = loadJSON(AGENDA_FILE, {});
  scheduledStarts = loadJSON(PROGRAM_FILE, {});
}
function saveClients() { saveJSON(DATA_FILE, clients); }
function saveMessages() { saveJSON(MSG_FILE, messagesConfig); }
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

        markBotSent(jid);
        await sock.sendMessage(jid, { text: texto });

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

        markBotSent(jid);
        await sock.sendMessage(jid, { text: texto });

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

        markBotSent(jid);
        await sock.sendMessage(jid, { text: texto });
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
      // ✅ deixa seus comandos funcionarem mesmo se o bot enviou mensagem recentemente
      const isCmd = lower.includes(CMD_STOP) || lower.includes(CMD_PAUSE) || lower.includes(CMD_CLIENT);
      if (botSentRecently.has(jid) && !isCmd) {
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

    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'error' }),
      markOnlineOnConnect: false,
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

        try {
          // ✅ Mantém o bot sempre indisponível/offline
          await sock.sendPresenceUpdate('unavailable');
        } catch (e) {
          console.log('[PRESENCE] Não pude forçar unavailable:', e?.message || e);
        }
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

// Railway/health
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/health', (req, res) => res.status(200).send('ok'));

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

// =================== START ===================

loadAll();
startScheduleChecker();
startMessageSender();
startBot();

// =================== PRESENCE (OFFLINE) ===================
// Mantém o bot como "indisponível" (offline) para não aparecer online.
const PRESENCE_KEEP_OFFLINE = 2 * 60 * 1000;
setInterval(async () => {
  if (!sock || !isConnected) return;
  try {
    await sock.sendPresenceUpdate('unavailable');
  } catch (_) {}
}, PRESENCE_KEEP_OFFLINE);


const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Painel web disponível em http://localhost:${PORT}/admin`);
});
