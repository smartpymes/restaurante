// src/server.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cron from 'node-cron';
import { handleVerify, sendText } from './whatsapp.js';
import { getAuthUrl, handleOAuthCallback, isGoogleReady, createBookingEvent, deleteBookingEvent } from './calendar.js';
import {
  upsertSession, getSession, resetSession, initDb, addBooking,
  listBookingsDueReminders, markBookingReminded, listUpcomingByWa, getLatestUpcoming, deleteBookingById
} from './store.js';

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(bodyParser.urlencoded({ extended: true }));

const RESTO = process.env.RESTAURANT_NAME || 'el restaurante';
const DURATION_MIN = parseInt(process.env.DEFAULT_DURATION_MIN || '90', 10);
const MAX_ADVANCE_DAYS = parseInt(process.env.MAX_ADVANCE_DAYS || '120', 10);
const MAX_PARTY_SIZE = parseInt(process.env.MAX_PARTY_SIZE || '10', 10);

app.get('/', (_, res) => res.send('SmartPyme Bot Restaurante ✅'));
app.get('/webhook', handleVerify);

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msg = changes?.value?.messages?.[0];
    const from = msg?.from;
    const text = msg?.text?.body?.trim();
    if (!from) return;
    if (!text) { await safeSend(from, '✍️ Por favor envía texto. Escribe *reservar* para empezar.'); return; }

    // Límite demo
    if (process.env.DEMO_END_DATE) {
      const end = new Date(process.env.DEMO_END_DATE + 'T23:59:59');
      if (new Date() > end) { await safeSend(from, '⛔️ Demo finalizado. Contáctanos para activar tu plan.'); return; }
    }

    let session = getSession(from) || { step: 0, payload: {} };
    const lower = text.toLowerCase();

    // Comandos globales
    if (['menu','reiniciar'].includes(lower)) {
      resetSession(from);
      await safeSend(from, `🧭 Menú reiniciado. Escribe *reservar* para agendar en ${RESTO}. Comandos: *mis reservas*, *cancelar*, *horario*, *auth google*.`);
      return;
    }
    if (lower === 'ayuda') {
      await safeSend(from, `ℹ️ Comandos: *reservar*, *mis reservas*, *cancelar*, *horario*, *reiniciar*.`);
      return;
    }
    if (lower === 'horario') {
      const oh = process.env.OPENING_HOURS_JSON ? JSON.parse(process.env.OPENING_HOURS_JSON) : {};
      const map = {mon:'Lun',tue:'Mar',wed:'Mié',thu:'Jue',fri:'Vie',sat:'Sáb',sun:'Dom'};
      const lines = Object.entries(oh).map(([k,[a,b]]) => `• ${map[k]||k}: ${a}:00–${b}:00`);
      await safeSend(from, `🕑 Horarios:\n${lines.join('\n') || 'No configurados'}`);
      return;
    }
    if (lower === 'auth google') { await safeSend(from, `🔐 Autoriza Google Calendar aquí: ${getAuthUrl()}`); return; }

    // Mis reservas (próximas)
    if (lower.startsWith('mis reserva')) {
      const items = listUpcomingByWa(from, 3);
      if (!items.length) { await safeSend(from, '📭 No tienes reservas próximas. Escribe *reservar* para crear una.'); return; }
      const body = items.map(i => `• ${fmtDateTime(i.start)} (${i.service}) — ID ${i.id}`).join('\n');
      await safeSend(from, `📅 Tus próximas reservas:\n${body}\n\nPara cancelar: escribe *cancelar* y el ID (ej. cancelar ${items[0].id}).`);
      return;
    }

    // Cancelar reserva
    if (lower.startsWith('cancelar')) {
      const id = parseInt(lower.replace(/[^\d]/g,'') || '0', 10);
      const target = id ? listUpcomingByWa(from, 10).find(b => b.id === id) : getLatestUpcoming(from);
      if (!target) { await safeSend(from, '❌ No encontré una reserva próxima para cancelar. Usa *mis reservas* para ver IDs.'); return; }
      try {
        await deleteBookingEvent(target.eventId);
        deleteBookingById(target.id);
        await safeSend(from, `🗑️ Reserva del ${fmtDateTime(target.start)} cancelada con éxito.`);
      } catch (e) {
        console.error('cancel error', e);
        await safeSend(from, '⚠️ Ocurrió un problema al cancelar. Intenta más tarde.');
      }
      return;
    }

    // Flujo de reserva paso a paso
    if (lower === 'reservar' && session.step === 0) {
      session = { step: 1, payload: {} }; upsertSession(from, session);
      await safeSend(from, `👋 ¡Bienvenido! ¿Cuál es tu *nombre*?`);
      return;
    }
    if (session.step === 1) {
      session.payload.name = text.slice(0,60);
      session.step = 2; upsertSession(from, session);
      await safeSend(from, `¿Para cuántas *personas*? (1–${MAX_PARTY_SIZE})`);
      return;
    }
    if (session.step === 2) {
      const n = parseInt(text,10);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PARTY_SIZE) {
        await safeSend(from, `Número inválido. Indica un valor entre 1 y ${MAX_PARTY_SIZE}.`);
        return;
      }
      session.payload.party = n;
      session.step = 3; upsertSession(from, session);
      await safeSend(from, 'Indica la *fecha* (DD/MM/AAAA) o escribe *hoy* / *mañana*.');
      return;
    }
    if (session.step === 3) {
      const d = parseDate(text);
      if (!d) { await safeSend(from, '📅 Formato de fecha no válido. Usa DD/MM/AAAA o *hoy*/*mañana*.'); return; }
      const today = new Date(); today.setHours(0,0,0,0);
      const max = new Date(); max.setDate(max.getDate()+MAX_ADVANCE_DAYS);
      if (d < today) { await safeSend(from, 'La fecha ya pasó. Elige otra.'); return; }
      if (d > max) { await safeSend(from, `Por ahora aceptamos reservas hasta ${MAX_ADVANCE_DAYS} días adelante.`); return; }
      session.payload.date = d.toISOString().slice(0,10);
      session.step = 4; upsertSession(from, session);
      await safeSend(from, '¿Hora? (formato 24h *HH:MM* o *7pm*, *7:30pm*)');
      return;
    }
    if (session.step === 4) {
      const hm = parseTime(text);
      if (!hm) { await safeSend(from, '🕒 Hora inválida. Usa *HH:MM* 24h o *7pm*, *7:30pm*.'); return; }
      const { hh, mm } = hm;
      const startISO = toISO(session.payload.date, hh, mm);

      if (!isGoogleReady()) { await safeSend(from, `🔐 Falta autorizar Google Calendar. Abre: ${getAuthUrl()}`); return; }

      // disponibilidad
      const { isOpenAt } = await import('./availability.js');
      try {
        const check = await isOpenAt(startISO, DURATION_MIN);
        if (!check.ok) { await safeSend(from, `⛔️ No disponible: ${check.reason}. Prueba otro horario.`); return; }

        const summary = `Mesa ${session.payload.party}p - ${session.payload.name}`;
        const description = `Cliente: ${session.payload.name}\nPersonas: ${session.payload.party}\nWhatsApp: ${from}`;
        const event = await createBookingEvent({ summary, description, start: startISO, end: check.endISO });

        addBooking({
          wa: from,
          name: session.payload.name,
          service: `Mesa ${session.payload.party}p`,
          start: startISO, end: check.endISO, eventId: event.id
        });
        resetSession(from);
        await safeSend(from, `✅ Reserva confirmada para *${fmtDateTime(startISO)}* (${session.payload.party} personas).\n📍 ${RESTO}`);
      } catch (e) {
        console.error('booking error', e);
        await safeSend(from, '⚠️ No pude crear la reserva. Vuelve a intentar en unos minutos.');
      }
      return;
    }

    // Sugerencia si escribe algo parecido
    if (lower.includes('reserv')) { await safeSend(from, 'Para iniciar escribe *reservar*.'); return; }

  } catch (e) { console.error('webhook error', e); }
});

// OAuth Google
app.get('/google/auth', (req, res) => res.redirect(getAuthUrl()));
app.get('/google/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Falta code');
  try { await handleOAuthCallback(code); res.send('✅ Google autorizado. Ya puedes crear reservas.'); }
  catch(e){ console.error(e); res.status(500).send('Error al autorizar Google'); }
});

// Recordatorios ~2h antes
cron.schedule('*/5 * * * *', async () => {
  try {
    const due = listBookingsDueReminders();
    for (const b of due) {
      await safeSend(b.wa, `⏰ Recordatorio: hoy a las ${fmtHour(b.start)} en ${RESTO}.`);
      markBookingReminded(b.id);
    }
  } catch (e) { console.error('reminder cron error', e); }
});

const port = process.env.PORT || 3000;
app.listen(port, async () => { await initDb(); console.log('Listo en puerto', port); });

// ---- utilidades de fecha/hora ----
function parseDate(input) {
  const tz = process.env.TIMEZONE || 'America/Bogota';
  if (!input) return null;
  const v = input.toLowerCase();
  if (v === 'hoy')  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  if (v === 'mañana' || v === 'manana') {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz })); d.setDate(d.getDate()+1); return d;
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.trim()); if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  return new Date(Date.UTC(+yyyy, +mm - 1, +dd));
}

function parseTime(input) {
  // Acepta 24h HH:MM, HHmm, y 12h con am/pm
  const s = input.toLowerCase().replace(/\s+/g,'');
  let m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (m) return { hh: +m[1], mm: +m[2] };
  m = /^([1-9]|1[0-2]):?([0-5]\d)?(am|pm)$/.exec(s);
  if (m) {
    let hh = +m[1]; const mm = m[2] ? +m[2] : 0; const ap = m[3];
    if (ap === 'pm' && hh !== 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    return { hh, mm };
  }
  return null;
}

function toISO(dateStr, hh, mm) {
  const tz = process.env.TIMEZONE || 'America/Bogota';
  const [y, m, d] = dateStr.split('-').map(n => +n);
  const local = new Date();
  local.setFullYear(y); local.setMonth(m-1); local.setDate(d); local.setHours(+hh, +mm, 0, 0);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(local).map(p=>[p.type,p.value]));
  const isoLocal = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`;
  return new Date(isoLocal + 'Z').toISOString();
}
function fmtDateTime(iso) { const d = new Date(iso); return d.toLocaleString('es-CO', { timeZone: process.env.TIMEZONE || 'America/Bogota', dateStyle: 'long', timeStyle: 'short' }); }
function fmtHour(iso)     { const d = new Date(iso); return d.toLocaleTimeString('es-CO', { timeZone: process.env.TIMEZONE || 'America/Bogota', hour: '2-digit', minute: '2-digit' }); }

async function safeSend(to, body) {
  try { await sendText(to, body); } catch (e) { console.error('sendText error', e?.response?.data||e); }
}
