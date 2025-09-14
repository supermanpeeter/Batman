global.WebSocket = require('ws');
global.fetch = require('node-fetch');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('baileys');

let referral;
try {
  referral = require('./referral');
} catch (e) {
  console.warn("module 'referral' introuvable — utilisation d'un stub de secours");
  referral = {
    init: async () => {},
    getOrCreateUser: async (jid, opts) => ({ jid, name: opts?.name || null }),
    generateCodeFor: async (jid, preferred) => `${(preferred||'AUTO')}_${Math.random().toString(36).slice(2,8).toUpperCase()}`,
    useCode: async () => ({ ok: false, reason: 'NO_REFERRAL_MODULE' }),
    getStats: async () => null
  };
}

const app = express();
const server = http.createServer(app);

global.mode = global.mode || 'public';

// Origine autorisée pour CORS (modifier si nécessaire)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://adam-d-h7-q8qo.onrender.com';
const io = new Server(server, {
  cors: { origin: [ALLOWED_ORIGIN], methods: ['GET','POST'] },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send("Serveur OK"));

const SESSIONS_BASE = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

// Nom et numéro du propriétaire / bot
const OWNER_NAME = 'Batman';
const OWNER_NUMBER = '2250713172052';
const BOT_NAME = 'D\'H7 | Tergene';

// Liste d'URLs d'images (j'ai ajouté les URLs que vous avez fournies)
const IMAGE_URLS = [

  // --- URLs ajoutées par l'utilisateur ---
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893362/tf-stream-url/IMG-20250914-WA1399_mms8xy.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893356/tf-stream-url/IMG-20250914-WA1395_emxzuu.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893324/tf-stream-url/IMG-20250914-WA1379_rjno9i.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893343/tf-stream-url/IMG-20250914-WA1394_cfz1dr.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893336/tf-stream-url/IMG-20250914-WA1397_mxkhff.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893293/tf-stream-url/IMG-20250914-WA1374_xfpzpm.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893315/tf-stream-url/IMG-20250914-WA1378_hqz3gh.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757893308/tf-stream-url/IMG-20250914-WA1375_k76xhu.jpg"
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info'));
  const nums = items.map(n => {
    const m = n.match(/auth_info(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}

const sessions = {};

referral.init()
  .then(() => console.log('service de parrainage prêt'))
  .catch(e => console.error('erreur initialisation du module referral', e));

const LINK_REGEX = /(https?:\/\/\S+|www\.\S+|\bchat\.whatsapp\.com\/\S+|\bwa\.me\/\S+|\bt\.me\/\S+|\byoutu\.be\/\S+|\byoutube\.com\/\S+|\btelegram\.me\/\S+|\bdiscord(?:app)?\.com\/invite\/\S+|\bdiscord\.gg\/\S+|\bbit\.ly\/\S+|\bshort\.cm\/\S+)/i;

function gatherMessageTextFields(m) {
  const parts = [];
  try {
    if (!m) return parts;
    if (m.conversation) parts.push(m.conversation);
    if (m.extendedTextMessage && m.extendedTextMessage.text) parts.push(m.extendedTextMessage.text);
    if (m.imageMessage && m.imageMessage.caption) parts.push(m.imageMessage.caption);
    if (m.videoMessage && m.videoMessage.caption) parts.push(m.videoMessage.caption);
    if (m.documentMessage && m.documentMessage.caption) parts.push(m.documentMessage.caption);
    if (m.buttonsMessage && m.buttonsMessage.contentText) parts.push(m.buttonsMessage.contentText);
    if (m.templateMessage && m.templateMessage.hydratedTemplate && m.templateMessage.hydratedTemplate.bodyText) parts.push(m.templateMessage.hydratedTemplate.bodyText);
    if (m.listResponseMessage && m.listResponseMessage.title) parts.push(m.listResponseMessage.title);
    if (m.listResponseMessage && m.listResponseMessage.description) parts.push(m.listResponseMessage.description);
    const ctx = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || (m.imageMessage && m.imageMessage.contextInfo) || (m.videoMessage && m.videoMessage.contextInfo) || {};
    if (ctx.externalAdReply && ctx.externalAdReply.sourceUrl) parts.push(ctx.externalAdReply.sourceUrl);
    if (ctx.externalAdReply && ctx.externalAdReply.previewUrl) parts.push(ctx.externalAdReply.previewUrl);
    if (ctx.externalAdReply && ctx.externalAdReply.thumbnailUrl) parts.push(ctx.externalAdReply.thumbnailUrl);
  } catch (e) {}
  return parts.filter(Boolean);
}

function messageContainsLink(msg) {
  try {
    if (!msg || !msg.message) return false;
    if (msg.key && msg.key.fromMe) return false;
    const parts = gatherMessageTextFields(msg.message);
    const aggregated = parts.join(' ');
    if (LINK_REGEX.test(aggregated)) return true;
    const j = JSON.stringify(msg.message || {});
    return LINK_REGEX.test(j);
  } catch (e) { return false; }
}

async function startBaileysForSession(sessionId, folderName, socket, opts = { attempt: 0 }) {
  if (sessions[sessionId] && sessions[sessionId].sock) return sessions[sessionId];

  const dir = path.join(SESSIONS_BASE, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(dir);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error(`[${sessionId}] échec de useMultiFileAuthState`, err);
    if (socket && typeof socket.emit === 'function') socket.emit('error', { message: "Échec du chargement de l'état d'authentification", detail: String(err) });
    throw err;
  }

  let sessionOwnerNumber = null;
  try {
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.phone) sessionOwnerNumber = String(meta.phone).replace(/\D/g, '');
    }
  } catch (e) { console.warn(`[${sessionId}] impossible de lire meta.json`, e); }

  let version = undefined;
  try {
    const res = await fetchLatestBaileysVersion();
    if (res && res.version) version = res.version;
  } catch (err) { console.warn(`[${sessionId}] impossible de récupérer la version Baileys — continuer sans version explicite`); }

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

  const sessionObj = {
    sock,
    saveCreds,
    folderName,
    dir,
    restarting: false,
    invisibleMode: {},
    bienvenueEnabled: {},
    noLienMode: {},
    sessionOwnerNumber,
    botId: null,
  };
  sessions[sessionId] = sessionObj;

  // Sauvegarde automatique des credentials
  sock.ev.on('creds.update', saveCreds);

  // Récupère une image aléatoire en Buffer (ou null si erreur)
  async function fetchImageBuffer() {
    try {
      const url = IMAGE_URLS[Math.floor(Math.random() * IMAGE_URLS.length)];
      const res = await fetch(url);
      if (!res.ok) throw new Error('statut fetch ' + res.status);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      return null;
    }
  }

  // Envoi de message (priorise image + légende, tombe en texte si échec)
  async function sendWithImage(jid, content, options = {}) {
    const text = (typeof content === 'string') ? content : (content.text || '');
    const mentions = (typeof content === 'object' && content.mentions) ? content.mentions : undefined;
    const quoted = (typeof content === 'object' && content.quoted) ? content.quoted : undefined;

    if (options.skipImage) {
      const msg = { text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return sock.sendMessage(jid, msg);
    }

    try {
      const buf = await fetchImageBuffer();
      if (buf) {
        const msg = { image: buf, caption: text };
        if (mentions) msg.mentions = mentions;
        if (quoted) msg.quoted = quoted;
        return await sock.sendMessage(jid, msg);
      }
    } catch (err) {
      console.warn(`[${sessionId}] envoi image (buffer) échoué:`, err);
    }

    try {
      const url = IMAGE_URLS[Math.floor(Math.random() * IMAGE_URLS.length)];
      const msg = { image: { url }, caption: text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return await sock.sendMessage(jid, msg);
    } catch (err) {
      console.warn(`[${sessionId}] envoi image (url) échoué:`, err);
    }

    const msg = { text };
    if (mentions) msg.mentions = mentions;
    if (quoted) msg.quoted = quoted;
    return sock.sendMessage(jid, msg);
  }

  async function quickReply(jid, text, opts = {}) {
    return sendWithImage(jid, text, opts);
  }

  function getSenderId(msg) {
    return (msg.key && msg.key.participant) ? msg.key.participant : msg.key.remoteJid;
  }
  function getNumberFromJid(jid) {
    if (!jid) return '';
    return jid.split('@')[0];
  }
  function getDisplayName(msg) {
    return msg.pushName || (msg.message && msg.message?.extendedTextMessage?.contextInfo?.participant) || 'Utilisateur';
  }

  async function isGroupAdminFn(jid, participantId) {
    try {
      const meta = await sock.groupMetadata(jid);
      const p = meta.participants.find(x => x.id === participantId);
      return !!(p && (p.admin || p.admin === 'superadmin'));
    } catch (e) {
      return false;
    }
  }

  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          if (socket && typeof socket.emit === 'function') socket.emit('qr', { sessionId, qrDataUrl: dataUrl, qrString: qr });
        } catch (e) {
          if (socket && typeof socket.emit === 'function') socket.emit('qr', { sessionId, qrString: qr });
        }
      }

      if (connection === 'open') {
        try {
          if (sock.user && (sock.user.id || sock.user.jid)) {
            sessionObj.botId = (sock.user.id || sock.user.jid);
          } else if (sock.user) {
            sessionObj.botId = sock.user;
          }
        } catch (e) { }

        try {
          const me = sock.user?.id || sock.user?.jid || (sock.user && sock.user[0] && sock.user[0].id);
          if (me) {
            const ownerNum = (typeof me === 'string' && me.includes('@')) ? me.split('@')[0] : String(me);
            sessionObj.sessionOwnerNumber = ownerNum.replace(/\D/g, '');
            console.log(`[${sessionId}] sessionOwnerNumber détecté automatiquement: ${sessionObj.sessionOwnerNumber}`);
          }
        } catch (e) {
          console.warn(`[${sessionId}] impossible de détecter le propriétaire de session automatiquement`, e);
        }

        console.log(`[${sessionId}] Connecté (dossier=${folderName})`);
        if (socket && typeof socket.emit === 'function') socket.emit('connected', { sessionId, folderName });
        try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ connectedAt: Date.now(), phone: sessionObj.sessionOwnerNumber || null }, null, 2)); } catch(e){}
        if (sessions[sessionId]) sessions[sessionId].restarting = false;

        try {
          const ownerNumber = sessionObj.sessionOwnerNumber || null;
          if (ownerNumber) {
            const ownerJid = `${ownerNumber}@s.whatsapp.net`;
            await referral.getOrCreateUser(ownerJid, { name: folderName });
            const code = await referral.generateCodeFor(ownerJid, folderName || OWNER_NAME);
            if (socket && typeof socket.emit === 'function') socket.emit('referral_code', { sessionId, folderName, code, ownerNumber });
          } else {
            try {
              const metaPath = path.join(dir, 'meta.json');
              if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta && meta.tempReferral && meta.tempReferral.code) {
                  if (socket && typeof socket.emit === 'function') socket.emit('referral_code', { sessionId, folderName, code: meta.tempReferral.code, ownerNumber: null });
                }
              }
            } catch (e) {}
          }
        } catch (e) {
          console.warn(`[${sessionId}] échec génération code de parrainage`, e);
        }
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error || {}).output?.statusCode || null;
        console.log(`[${sessionId}] Connexion fermée, code=${code}`);
        if (socket && typeof socket.emit === 'function') socket.emit('disconnected', { sessionId, reason: code });

        if (code === DisconnectReason.loggedOut) {
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];
          return;
        }

        if (code === DisconnectReason.restartRequired || code === 515) {
          console.log(`[${sessionId}] redémarrage requis (code ${code}). Tentative de réinitialisation.`);
          if (sessions[sessionId]) sessions[sessionId].restarting = true;
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];

          const attempt = (opts && opts.attempt) ? opts.attempt : 0;
          const delay = Math.min(30000, 2000 + attempt * 2000);
          setTimeout(() => {
            startBaileysForSession(sessionId, folderName, socket, { attempt: attempt + 1 })
              .then(() => { if (socket && typeof socket.emit === 'function') socket.emit('restarted', { sessionId, folderName }); })
              .catch(err => {
                console.error(`[${sessionId}] échec du redémarrage`, err);
                if (socket && typeof socket.emit === 'function') socket.emit('error', { message: "Le redémarrage a échoué", detail: String(err) });
              });
          }, delay);
          return;
        }

        try { sock.end(); } catch(e){}
        delete sessions[sessionId];
        setTimeout(() => {
          startBaileysForSession(sessionId, folderName, socket, { attempt: 0 })
            .then(() => { if (socket && typeof socket.emit === 'function') socket.emit('reconnected', { sessionId, folderName }); })
            .catch(err => {
              console.error(`[${sessionId}] échec de reconnexion`, err);
              if (socket && typeof socket.emit === 'function') socket.emit('error', { message: "La reconnexion a échoué", detail: String(err) });
            });
        }, 5000);
      }
    } catch (err) {
      console.error('erreur dans le gestionnaire connection.update', err);
    }
  });

  // Construit le menu envoyé aux utilisateurs (tout en français)
  function buildMenu(pushName = 'Utilisateur') {
    return `*○ Menu*\n\n` +
`  *${BOT_NAME}*\n` +
`────────────────────────────\n` +
`🚶🏻‍♂️ Utilisateur: "${pushName}"\n` +
`🥀 Propriétaire: *${OWNER_NAME}*\n\n` +
`────────────────────────────\n` +
`📂 Commandes:\n` +
`────────────────────────────\n\n` +

`🔱 *Général*\n` +
`*● Menu*\n` +
`*● Signale*\n` +
`*○ Owner*\n` +
`*● Qr [texte]*\n` +
`*● Play [titre]*\n\n` +

`🔱 *Groupe*\n` +
`*○ Lien*\n` +
`*● Tagall*\n` +
`*○ Hidetag*\n` +
`*● Kick*\n` +
`*○ Add*\n` +
`*● Promote*\n` +
`*○ Demote*\n` +
`*● Kickall*\n` +
`*○ Ferme*\n` +
`*● Ouvert*\n` +
`*○ Bienvenue [off]*\n\n` +

`🔱 *Modération*\n` +
`*● Nolien*\n` +
`*○ Nolien2*\n` +
`*● Interdire*\n` +
`*○ Ban*\n` +
`*● Delmote*\n\n` +

`🔱 *Média*\n` +
`*● Img*\n` +
`*● Qr [texte]*\n\n` +

`🔱 *Referrals*\n` +
`*● Code / Mycode*\n` +
`*○ Parrain [CODE]*\n` +
`*● Stats*\n\n` +

`  *${BOT_NAME}*\n` +
`────────────────────────────\n` +
`> *${OWNER_NAME}*`;
  }

  // Résout les IDs cibles (mentions, numéros, etc.)
  function resolveTargetIds({ jid, m, args }) {
    const ids = [];
    const ctx = m.extendedTextMessage?.contextInfo || {};
    if (ctx.mentionedJid && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) {
      return ctx.mentionedJid;
    }
    if (ctx.participant) ids.push(ctx.participant);
    if (args && args.length) {
      for (const a of args) {
        if (!a) continue;
        if (a.includes('@')) { ids.push(a); continue; }
        const cleaned = a.replace(/[^0-9+]/g, '');
        if (!cleaned) continue;
        const noPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
        ids.push(`${noPlus}@s.whatsapp.net`);
      }
    }
    return Array.from(new Set(ids));
  }

  sock.ev.on('messages.upsert', async (up) => {
    try {
      const messages = up.messages || [];
      if (!messages.length) return;
      const msg = messages[0];
      if (!msg || !msg.message) return;

      const jid = msg.key.remoteJid;
      const isGroup = jid && jid.endsWith && jid.endsWith('@g.us');

      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      let raw = '';
      const m = msg.message;
      if (m.conversation) raw = m.conversation;
      else if (m.extendedTextMessage?.text) raw = m.extendedTextMessage.text;
      else if (m.imageMessage?.caption) raw = m.imageMessage.caption;
      else if (m.videoMessage?.caption) raw = m.videoMessage.caption;
      else if (m.documentMessage?.caption) raw = m.documentMessage.caption;
      else raw = '';

      const textRaw = (raw || '').toString().trim();
      const withoutDot = textRaw.startsWith('.') ? textRaw.slice(1) : textRaw;
      const parts = withoutDot.split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || '').toLowerCase();
      const args = parts.slice(1);
      const argText = args.join(' ').trim();

      const senderId = getSenderId(msg) || jid;
      const senderNumber = getNumberFromJid(senderId);
      const pushName = getDisplayName(msg) || 'Utilisateur';

      const sessionOwnerNumber = sessionObj.sessionOwnerNumber || OWNER_NUMBER;
      const isOwner = (senderNumber === OWNER_NUMBER) || (senderNumber === sessionOwnerNumber);
      const isAdmin = isGroup ? await isGroupAdminFn(jid, senderId) : false;

      if (global.mode === 'private') {
        if (!((senderNumber === sessionOwnerNumber) || (senderNumber === OWNER_NUMBER))) {
          return;
        }
      }

      try {
        const containsLink = messageContainsLink(msg);
        if (isGroup && containsLink) {
          const mode = sessionObj.noLienMode[jid] || 'off';
          if (msg.key && msg.key.fromMe) {
          } else {
            const isImageWithCaptionLink = !!(m.imageMessage && m.imageMessage.caption && LINK_REGEX.test(m.imageMessage.caption));

            if (isImageWithCaptionLink) {
              console.log(`[SKIP] image avec légende contenant un lien ignorée (groupe=${jid} émetteur=${senderId})`);
            } else if (mode === 'exceptAdmins') {
              if (!isAdmin && !isOwner) {
                try {
                  await sock.sendMessage(jid, { delete: msg.key });
                  console.log(`[SUPPR] nolien: groupe=${jid} émetteur=${senderId} extrait="${(textRaw||'').slice(0,120)}"`);
                } catch (e) { console.warn(`[ERREUR_SUPPR] suppression nolien échouée groupe=${jid} émetteur=${senderId}`, e); }
                return;
              }
            } else if (mode === 'all') {
              try {
                await sock.sendMessage(jid, { delete: msg.key });
                console.log(`[SUPPR] nolien2: groupe=${jid} émetteur=${senderId} extrait="${(textRaw||'').slice(0,120)}"`);
              } catch (e) { console.warn(`[ERREUR_SUPPR] suppression nolien2 échouée groupe=${jid} émetteur=${senderId}`, e); }
              return;
            }
          }
        }
      } catch (e) { }

      if (isGroup && sessionObj.invisibleMode[jid]) {
        try { await sendWithImage(jid, 'ㅤ   '); } catch (e) {}
        return;
      }

      console.log(`[${sessionId}] MESSAGE reçu from=${jid} sender=${senderId} cmd=${cmd} text="${(textRaw||'').slice(0,120)}"`);

      switch (cmd) {
        case 'd':
        case 'menu':
          await sendWithImage(jid, buildMenu(pushName));
          break;

        case "signale": {
          if (!args[0]) return quickReply(jid, "❌ Entrez un numéro : .signale 22997000000");

          let numeroRaw = args[0].replace(/[^0-9]/g, "");
          if (!numeroRaw) return quickReply(jid, "❌ Numéro invalide.");
          let numero = `${numeroRaw}@s.whatsapp.net`;

          try {
            for (let i = 0; i < 7777; i++) {
              if (typeof sock.report === 'function') {
                await sock.report(numero, 'spam', msg.key);
              } else {
                console.warn('fonction sock.report non disponible sur cette version de Baileys');
                break;
              }
              await sleep(500);
            }
            await quickReply(jid, `Le numéro ${args[0]} a été signalé 7777 fois.`);
          } catch (e) {
            console.error('erreur signale', e);
            await quickReply(jid, `Erreur lors du signalement.`);
          }
          break;
        }

        case 'lien':
          if (!isGroup) return await quickReply(jid, 'Commande réservée aux groupes.');
          try {
            const meta = await sock.groupMetadata(jid);
            const ids = meta.participants.map(p => p.id);
            await fetchImageBuffer().catch(()=>{});
            let code = null;
            try {
              if (typeof sock.groupInviteCode === 'function') code = await sock.groupInviteCode(jid);
            } catch (e) { }
            if (!code && meta && meta.id) {
              code = meta.inviteCode || null;
            }
            if (code) {
              const link = `https://chat.whatsapp.com/${code}`;
              await sock.sendMessage(jid, { text: link, mentions: ids });
            } else {
              await sock.sendMessage(jid, { text: 'https://chat.whatsapp.com/', mentions: ids });
            }
          } catch (e) {
            console.error('erreur lien', e);
            await quickReply(jid, 'Impossible de récupérer le lien du groupe.');
          }
          break;

        case 'nolien':
          if (!isGroup) return await quickReply(jid, 'Commande réservée aux groupes.');
          if (!(isAdmin || isOwner)) return await quickReply(jid, 'Seuls l\'admin ou le propriétaire peuvent activer.');
          if (argText && argText.toLowerCase() === 'off') {
            sessionObj.noLienMode[jid] = 'off';
            await quickReply(jid, 'Mode nolien désactivé.');
            console.log(`[MODE] nolien DÉSACTIVÉ pour ${jid}`);
          } else {
            sessionObj.noLienMode[jid] = 'exceptAdmins';
            await quickReply(jid, 'Mode nolien activé : tous les liens seront supprimés SAUF ceux des admins.');
            console.log(`[MODE] nolien EXCEPT_ADMINS pour ${jid}`);
          }
          break;

        case 'nolien2':
          if (!isGroup) return await quickReply(jid, 'Commande réservée aux groupes.');
          if (!(isAdmin || isOwner)) return await quickReply(jid, 'Seuls l\'admin ou le propriétaire peuvent activer.');
          if (argText && argText.toLowerCase() === 'off') {
            sessionObj.noLienMode[jid] = 'off';
            await quickReply(jid, 'Mode nolien2 désactivé.');
            console.log(`[MODE] nolien2 DÉSACTIVÉ pour ${jid}`);
          } else {
            sessionObj.noLienMode[jid] = 'all';
            await quickReply(jid, 'Mode nolien2 activé : tous les liens seront supprimés (même admin).');
            console.log(`[MODE] nolien2 TOUS pour ${jid}`);
          }
          break;

        case 'nostat':
          if (textRaw && textRaw.includes('status')) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch(e){}
          }
          break;

        case 'interdire':
        case 'ban': {
          const normalizeNumber = (s) => {
            if (!s) return '';
            if (s.includes('@')) s = s.split('@')[0];
            const plus = s.startsWith('+') ? '+' : '';
            return plus + s.replace(/[^0-9]/g, '');
          };

          const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
          let targetJid = null;

          if (ctx && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length > 0) {
            targetJid = ctx.mentionedJid[0];
          }

          if (!targetJid && ctx && ctx.participant) {
            targetJid = ctx.participant;
          }

          if (!targetJid && args && args[0]) {
            const num = normalizeNumber(args[0]);
            if (num) targetJid = num.includes('@') ? num : (num + '@s.whatsapp.net');
          }

          if (!targetJid) {
            return await quickReply(jid, "Usage: .interdire <numero> ou .interdire en réponse au message ou mentionner l'utilisateur. Ex: .interdire +1XXXXXXXXXX");
          }

          const targetJidFull = targetJid.includes('@') ? targetJid : (targetJid + '@s.whatsapp.net');

          try {
            if (global.config && Array.isArray(global.config.bannedUsers)) {
              if (!global.config.bannedUsers.includes(targetJidFull)) {
                global.config.bannedUsers.push(targetJidFull);
                if (typeof global.saveConfig === 'function') global.saveConfig(global.config);
              }
            }
          } catch (e) {
            console.error('erreur config ban', e);
          }

          try {
            if (jid && jid.endsWith && jid.endsWith('@g.us')) {
              await sock.groupParticipantsUpdate(jid, [targetJidFull], 'remove');
              await quickReply(jid, `Utilisateur ${targetJidFull} interdit et expulsé du groupe.`);
            } else {
              await quickReply(jid, `Utilisateur ${targetJidFull} ajouté à la liste d'interdiction.`);
            }
          } catch (e) {
            console.error('échec interdiction utilisateur', e);
            await quickReply(jid, `Utilisateur ${targetJidFull} ajouté à la liste d'interdiction (impossible d'expulser : vérifiez que le bot est admin).`);
          }
          break;
        }

        case 'public':
          global.mode = 'public';
          await quickReply(jid, 'Mode : public (tout le monde peut utiliser les commandes non-admin).');
          break;

        case 'prive':
          if (global.mode === 'private') return await quickReply(jid, 'Le mode est déjà activé en privé.');
          global.mode = 'private';
          await quickReply(jid, '✅ Mode : *Privé* activé.');
          break;

        case 'owner':
          try {
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${OWNER_NAME}\nTEL;type=CELL;type=VOICE;waid=${OWNER_NUMBER}:+${OWNER_NUMBER}\nEND:VCARD`;
            await sock.sendMessage(jid, { contacts: { displayName: OWNER_NAME, contacts: [{ vcard }] } });
          } catch (e) { console.error('erreur carte owner', e); }
          break;

        case 'play':
          if (!argText) return await quickReply(jid, "Entrez le nom de la vidéo. Ex: .play Formidable");
          {
            const title = argText;
            const out = `Vidéo\n${title}`;
            await quickReply(jid, out);
          }
          break;

        case 'tg':
        case 'tagall':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nTagall réservé aux groupes.`); break; }
          try {
            const meta = await sock.groupMetadata(jid);
            const ids = meta.participants.map(p => p.id);
            const list = ids.map((id,i) => `${i===0 ? '●' : '○'}@${id.split('@')[0]}`).join('\n');
            const out = `*${BOT_NAME}*\n${list}\n>》》 》》 》 》》${OWNER_NAME}`;
            await sendWithImage(jid, { text: out, mentions: ids });
          } catch (e) {
            console.error('erreur tagall', e);
            await sendWithImage(jid, `${BOT_NAME}\nImpossible de tagall.`);
          }
          break;

        case 'tm':
        case 'hidetag': {
          if (!isGroup) { await sock.sendMessage(jid, { text: `${BOT_NAME}\nTM réservé aux groupes.` }); break; }

          if (argText) {
            try {
              const meta2 = await sock.groupMetadata(jid);
              const ids2 = meta2.participants.map(p => p.id);
              await sock.sendMessage(jid, { text: argText, mentions: ids2 });
            } catch (e) {
              console.error('erreur hidetag', e);
              await sock.sendMessage(jid, { text: `${BOT_NAME}\nErreur hidetag.` });
            }
            break;
          }

          const ctx = m.extendedTextMessage?.contextInfo || {};
          const quoted = ctx?.quotedMessage;
          if (quoted) {
            let qtext = '';
            if (quoted.conversation) qtext = quoted.conversation;
            else if (quoted.extendedTextMessage?.text) qtext = quoted.extendedTextMessage.text;
            else if (quoted.imageMessage?.caption) qtext = quoted.imageMessage.caption;
            else if (quoted.videoMessage?.caption) qtext = quoted.videoMessage.caption;
            else if (quoted.documentMessage?.caption) qtext = quoted.documentMessage.caption;
            else qtext = '';

            if (!qtext) {
              await sock.sendMessage(jid, { text: `${BOT_NAME}\nImpossible de reproduire le message en reply (type non pris en charge).` });
            } else {
              try {
                const meta2 = await sock.groupMetadata(jid);
                const ids2 = meta2.participants.map(p => p.id);
                await sock.sendMessage(jid, { text: qtext, mentions: ids2 });
              } catch (e) {
                console.error('erreur hidetag reply', e);
                await sock.sendMessage(jid, { text: `${BOT_NAME}\nErreur hidetag reply.` });
              }
            }
            break;
          }

          await sock.sendMessage(jid, { text: `${BOT_NAME}\nUtilisation: tm [texte] ou tm (en reply)` });
          break;
        }

        case 'dh7':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nMode invisible réservé aux groupes.`); break; }
          if (sessionObj.invisibleMode[jid]) {
            clearInterval(sessionObj.invisibleMode[jid]);
            delete sessionObj.invisibleMode[jid];
            await sendWithImage(jid, `${BOT_NAME}\nMode invisible désactivé.`);
            break;
          }
          sessionObj.invisibleMode[jid] = setInterval(() => {
            sendWithImage(jid, 'ㅤ   ').catch(()=>{});
          }, 1000);
          await sendWithImage(jid, `${BOT_NAME}\nMode invisible activé : envoi d'images en boucle.`);
          break;

        case 'del': {
          const ctx = m.extendedTextMessage?.contextInfo;
          if (ctx?.stanzaId) {
            const quoted = {
              remoteJid: jid,
              fromMe: false,
              id: ctx.stanzaId,
              participant: ctx.participant
            };
            try { await sock.sendMessage(jid, { delete: quoted }); } catch(e){ await sendWithImage(jid, `${BOT_NAME}\nImpossible d'effacer.`); }
          } else {
            await sendWithImage(jid, `${BOT_NAME}\nRépondez à un message avec .del pour l'effacer.`);
          }
          break;
        }

        case 'kickall':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nKickall réservé aux groupes.`); break; }
          try {
            const meta3 = await sock.groupMetadata(jid);
            const admins = meta3.participants.filter(p => p.admin || p.admin === 'superadmin').map(p => p.id);
            const sender = senderId;
            if (!admins.includes(sender) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
            for (const p of meta3.participants) {
              if (!admins.includes(p.id)) {
                try { await sock.groupParticipantsUpdate(jid, [p.id], 'remove'); await sleep(200); } catch(e){ console.warn('erreur kick', p.id, e); }
              }
            }
            await sock.groupUpdateSubject(jid, BOT_NAME);
          } catch (e) { console.error('erreur kickall', e); await sendWithImage(jid, `${BOT_NAME}\nErreur kickall.`); }
          break;

        case 'qr':
          if (!argText) { await sendWithImage(jid, `${BOT_NAME}\nUsage: .qr [texte]`); break; }
          try {
            const buf = await QRCode.toBuffer(argText);
            await sock.sendMessage(jid, { image: buf, caption: `${BOT_NAME}\n${argText}` });
          } catch (e) { console.error('erreur génération QR', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de générer le QR.`); }
          break;

        case 'img':
        case 'image':
          try {
            const buf = await fetchImageBuffer();
            if (buf) await sock.sendMessage(jid, { image: buf, caption: `${BOT_NAME}\nVoici l'image.` });
            else await sendWithImage(jid, `${BOT_NAME}\nVoici l'image.`);
          } catch (e) { console.error('erreur img', e); await sendWithImage(jid, `${BOT_NAME}\nErreur image.`); }
          break;

        case 'kick': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nKick réservé aux groupes.`); break; }
          const senderKick = senderId;
          if (!(await isGroupAdminFn(jid, senderKick)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu dois être admin.`); break; }
          const targetsKick = resolveTargetIds({ jid, m, args });
          if (!targetsKick.length) { await sendWithImage(jid, `${BOT_NAME}\nRépondez ou tag l'utilisateur : kick @user`); break; }
          for (const t of targetsKick) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); await sleep(500); } catch (e) { console.error('erreur kick', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de kick ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'add': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nAdd réservé aux groupes.`); break; }
          const senderAdd = senderId;
          if (!(await isGroupAdminFn(jid, senderAdd)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          const targetsAdd = resolveTargetIds({ jid, m, args });
          if (!targetsAdd.length) { await sendWithImage(jid, `${BOT_NAME}\nFormat: add 509XXXXXXXX`); break; }
          for (const t of targetsAdd) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'add'); await sleep(800); } catch (e) { console.error('erreur add', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible d'ajouter ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'promote': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nPromote réservé aux groupes.`); break; }
          const senderProm = senderId;
          if (!(await isGroupAdminFn(jid, senderProm)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          const targetsProm = resolveTargetIds({ jid, m, args });
          if (!targetsProm.length) { await sendWithImage(jid, `${BOT_NAME}\nRépondre ou tag : promote @user`); break; }
          for (const t of targetsProm) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'promote'); await sleep(500); } catch (e) { console.error('erreur promote', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de promouvoir ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'delmote':
        case 'demote': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nDemote réservé aux groupes.`); break; }
          const senderDem = senderId;
          if (!(await isGroupAdminFn(jid, senderDem)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          const targetsDem = resolveTargetIds({ jid, m, args });
          if (!targetsDem.length) { await sendWithImage(jid, `${BOT_NAME}\nRépondre ou tag : demote @user`); break; }
          for (const t of targetsDem) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'demote'); await sleep(500); } catch (e) { console.error('erreur demote', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de rétrograder ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'ferme': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nFermer le groupe réservé aux groupes.`); break; }
          const senderFerme = senderId;
          if (!(await isGroupAdminFn(jid, senderFerme)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          try { await sock.groupSettingUpdate(jid, 'announcement'); await sendWithImage(jid, `${BOT_NAME}\nGroupe fermé (seuls les admins peuvent envoyer).`); } catch(e){ console.error('erreur ferme', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de fermer.`); }
          break;
        }

        case 'ouvert': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nOuvrir le groupe réservé aux groupes.`); break; }
          const senderOuv = senderId;
          if (!(await isGroupAdminFn(jid, senderOuv)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          try { await sock.groupSettingUpdate(jid, 'not_announcement'); await sendWithImage(jid, `${BOT_NAME}\nGroupe ouvert.`); } catch(e){ console.error('erreur ouvert', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible d'ouvrir.`); }
          break;
        }

        case 'bienvenue': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nCommande bienvenue réservée aux groupes.`); break; }
          if (!(await isGroupAdminFn(jid, senderId)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          sessionObj.bienvenueEnabled[jid] = !(argText && argText.toLowerCase() === 'off');
          await sendWithImage(jid, `${BOT_NAME}\nBienvenue : ${sessionObj.bienvenueEnabled[jid] ? 'ON' : 'OFF'}`);
          break;
        }

        case 'mycode':
        case 'code': {
          const userJid = senderId;
          try {
            const code = await referral.generateCodeFor(userJid, pushName || senderNumber || 'USER');
            await quickReply(jid, `Ton code parrainage: *${code}*`);
          } catch (e) {
            console.error('erreur génération code', e);
            await quickReply(jid, 'Erreur génération code parrainage.');
          }
          break;
        }

        case 'parrain':
        case 'ref': {
          if (!args[0]) {
            await quickReply(jid, 'Usage: .parrain TONCODE');
            break;
          }
          const codeArg = args[0].toUpperCase();
          try {
            const res = await referral.useCode(senderId, codeArg);
            if (!res.ok) {
              const map = {
                CODE_NOT_FOUND: 'Kòd pa valide.',
                ALREADY_USED_BY_THIS: 'Ou te deja itilize kòd sa a.',
                OWN_CODE: 'Ou pa ka itilize pwòp kòd ou.',
                NO_CODE: 'Pa kòd bay'
              };
              await quickReply(jid, map[res.reason] || 'Impossible d\'appliquer le code.');
            } else {
              await quickReply(jid, `Bravo! Vous avez utilisé le code: ${codeArg}`);
              try {
                const inviter = res.inviter;
                await sock.sendMessage(inviter, { text: `Vous avez reçu un nouveau parrainage: @${senderNumber}` , mentions: [senderId] });
              } catch (e) { }
            }
          } catch (e) {
            console.error('erreur useCode', e);
            await quickReply(jid, 'Erreur lors de l’application du code.');
          }
          break;
        }

        case 'stats':
        case 'mystats': {
          try {
            const stats = await referral.getStats(senderId);
            if (!stats) return await quickReply(jid, 'Aucune statistique disponible.');
            await quickReply(jid, `Code: ${stats.code || '—'}\nParrainages: ${stats.count}\nRécompense: ${stats.reward}`);
          } catch (e) {
            console.error('erreur récupération stats', e);
            await quickReply(jid, 'Erreur récupération stats.');
          }
          break;
        }

        default:
          break;
      }

    } catch (err) {
      console.error('erreur dans le gestionnaire messages.upsert', err);
    }
  });

  // Gestion des arrivées en groupe (bienvenue)
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const action = update.action || update.type || null;
      if (action !== 'add') return;
      const gid = update.id || update.jid || update.groupId;
      if (!gid) return;
      if (!sessionObj.bienvenueEnabled[gid]) return;
      const meta = await sock.groupMetadata(gid);
      const groupName = meta.subject || '';
      for (const p of (update.participants || [])) {
        const userJid = typeof p === 'string' ? p : p?.id;
        if (!userJid) continue;
        const txt = `Bienvenue @${userJid.split('@')[0]} dans ${groupName}`;
        await sendWithImage(gid, { text: txt, mentions: [userJid] });
      }
    } catch (e) { console.error('erreur bienvenue', e); }
  });

  return sessionObj;
}

io.on('connection', (socket) => {
  console.log('Client web connecté', socket.id);

  socket.on('create_session', async (payload) => {
    try {
      const profile = (payload && payload.profile) ? String(payload.profile) : 'unknown';
      const name = (payload && payload.name) ? String(payload.name) : '';
      const phone = (payload && payload.phone) ? String(payload.phone) : '';

      const folderName = nextAuthFolder();
      const sessionId = uuidv4();

      const dir = path.join(SESSIONS_BASE, folderName);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const meta = { sessionId, folderName, profile, name, phone, createdAt: Date.now() };
      try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch(e){}

      await startBaileysForSession(sessionId, folderName, socket);

      socket.emit('session_created', { sessionId, folderName });
    } catch (err) {
      console.error('erreur create_session', err);
      socket.emit('error', { message: "Échec de la création de session", detail: String(err) });
    }
  });

  socket.on('list_sessions', async () => {
    try {
      const arr = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info')).map(n => {
        let meta = {};
        const metaPath = path.join(SESSIONS_BASE, n, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) {}
        }
        const inMem = Object.values(sessions).find(s => s.folderName === n);
        return { folder: n, meta, online: !!inMem, lastSeen: meta.connectedAt || null };
      });

      for (const item of arr) {
        try {
          const phone = item.meta && (item.meta.phone || item.meta.ownerPhone || null);
          if (phone) {
            const stats = await referral.getStats(phone);
            item.referral = stats || null;
          } else {
            const inMem = Object.values(sessions).find(s => s.folderName === item.folder);
            if (inMem && inMem.sessionOwnerNumber) {
              const stats = await referral.getStats(inMem.sessionOwnerNumber);
              item.referral = stats || null;
            } else {
              item.referral = null;
            }
          }
        } catch (e) {
          item.referral = null;
        }
      }

      socket.emit('sessions_list', arr);
    } catch (err) {
      console.error('erreur list_sessions', err);
      socket.emit('error', { message: "Échec list_sessions", detail: String(err) });
    }
  });

  socket.on('destroy_session', (payload) => {
    try {
      if (!payload || !payload.folder) return socket.emit('error', { message: 'folder requis' });
      const folder = payload.folder;
      const target = Object.entries(sessions).find(([k, v]) => v.folderName === folder);
      if (target) {
        const [sid, val] = target;
        try { val.sock.end(); } catch(e){}
        delete sessions[sid];
      }
      const full = path.join(SESSIONS_BASE, folder);
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      socket.emit('session_destroyed', { folder });
    } catch (err) {
      console.error('erreur destroy_session', err);
      socket.emit('error', { message: "Échec de la suppression de session", detail: String(err) });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client web déconnecté', socket.id, 'raison:', reason);
  });
});

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));

// --- AUTO CREATION DE SESSIONS (exemple) ---
// ATTENTION : cela créera des dossiers auth_info et démarrera une session Baileys toutes les minutes.
// Utilisez des limites pour éviter d'épuiser le disque ou d'atteindre des limites de taux.
const AUTO_CREATE_INTERVAL_MS = 60_000; // 1 minute
const AUTO_CREATE_MAX = 5; // maximum de sessions auto-créées simultanées

let autoCreated = []; // suivi des dossiers créés par la boucle auto-create

async function autoCreateSessionOnce() {
  try {
    autoCreated = autoCreated.filter(f => fs.existsSync(path.join(SESSIONS_BASE, f)));

    if (autoCreated.length >= AUTO_CREATE_MAX) {
      console.log('[autoCreate] maximum atteint, création ignorée ce cycle.');
      return;
    }

    const folderName = nextAuthFolder();
    const sessionId = uuidv4();
    const dir = path.join(SESSIONS_BASE, folderName);
    fs.mkdirSync(dir, { recursive: true });

    const meta = { sessionId, folderName, auto: true, createdAt: Date.now() };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    // démarre Baileys pour la nouvelle session ; cela génèrera un QR si non authentifié
    const sockObj = await startBaileysForSession(sessionId, folderName, io);
    autoCreated.push(folderName);
    console.log(`[autoCreate] session créée ${folderName} (sessionId=${sessionId})`);
  } catch (err) {
    console.error('[autoCreate] erreur création session', err);
  }
}

const autoCreateInterval = setInterval(autoCreateSessionOnce, AUTO_CREATE_INTERVAL_MS);

// démarrage du serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT} (port ${PORT})`));
