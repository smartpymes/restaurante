import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import { handleVerify, sendText } from './whatsapp.js';
import { getAuthUrl, handleOAuthCallback, isGoogleReady, createBookingEvent } from './calendar.js';
import { upsertSession, getSession, resetSession, initDb, addBooking, listBookingsDueReminders, markBookingReminded } from './store.js';
import cron from 'node-cron';

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (_, res) => res.send('Bot reservas starter ✅'));
app.get('/webhook', handleVerify);
app.post('/webhook', async (req, res) => {
  try {
    res.sendStatus(200);
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const msg = changes?.value?.messages?.[0];
    const from = msg?.from;
    const text = msg?.text?.body?.trim();
    if (!from || !text) return;

    if (process.env.DEMO_END_DATE) {
      const end = new Date(process.env.DEMO_END_DATE + 'T23:59:59');
      if (new Date() > end) { await sendText(from, '⛔️ Demo finalizado.'); return; }
    }

    let session = getSession(from) || { step: 0, payload: {} };
    const lower = text.toLowerCase();

    if (lower === 'menu' || lower === 'reiniciar') {
      resetSession(from); await sendText(from, 'Menú reiniciado. Escribe "reservar".'); return;
    }
    if (lower === 'auth google') { await sendText(from, `Autoriza Google: ${getAuthUrl()}`); return; }
    if (lower === 'reservar' && session.step === 0) {
      session.step = 1; upsertSession(from, session);
      await sendText(from, '¿Tu *nombre*?'); return;
    }
    if (session.step === 1) {
      session.payload.name = text; session.step = 2; upsertSession(from, session);
      await sendText(from, '¿Qué *servicio* deseas?'); return;
    }
    if (session.step === 2) {
      session.payload.service = text; session.step = 3; upsertSession(from, session);
      await sendText(from, 'Indica la *fecha* DD/MM/AAAA o "hoy"/"mañana".'); return;
    }
    if (session.step === 3) {
      const dt = parseDate(text);
      if (!dt) { await sendText(from, 'Fecha no válida.'); return; }
      session.payload.date = dt.toISOString().slice(0,10);
      session.step = 4; upsertSession(from, session);
      await sendText(from, '¿Hora? (HH:MM 24h)'); return;
    }
    if (session.step === 4) {
      const hm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
      if (!hm) { await sendText(from, 'Hora inválida.'); return; }
      const [_, hh, mm] = hm;
      const start = toISO(session.payload.date, hh, mm);
      const end   = new Date(new Date(start).getTime() + 30*60*1000).toISOString();

      if (!isGoogleReady()) { await sendText(from, 'Falta autorizar Google. Escribe "auth google".'); return; }
      const summary = `Reserva: ${session.payload.service} - ${session.payload.name}`;
      const description = `Cliente: ${session.payload.name}\nServicio: ${session.payload.service}\nWhatsApp: ${from}`;
      try {
        const event = await createBookingEvent({ summary, description, start, end });
        addBooking({ wa: from, name: session.payload.name, service: session.payload.service, start, end, eventId: event.id });
        resetSession(from);
        await sendText(from, `✅ Reserva creada para *${fmtDateTime(start)}*. ID: ${event.id}`);
      } catch (e) {
        console.error('Calendar error', e);
        await sendText(from, '❌ Error al crear la reserva.');
      }
      return;
    }
    if (lower.includes('reserv')) { await sendText(from, 'Escribe "reservar" para iniciar.'); return; }
  } catch (e) { console.error('webhook error', e); res.sendStatus(200); }
});

app.get('/google/auth', (req, res) => res.redirect(getAuthUrl()));
app.get('/google/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Falta code');
  try { await handleOAuthCallback(code); res.send('✅ Google autorizado.'); }
  catch(e){ console.error(e); res.status(500).send('Error al autorizar Google'); }
});

cron.schedule('*/5 * * * *', async () => {
  const due = listBookingsDueReminders();
  for (const b of due) { try { await sendText(b.wa, `⏰ Recordatorio: ${fmtHour(b.start)} hoy.`); markBookingReminded(b.id); } catch(e){} }
});

const port = process.env.PORT || 3000;
app.listen(port, async () => { await initDb(); console.log('Listo en puerto', port); });

function parseDate(input) {
  const tz = process.env.TIMEZONE || 'America/Bogota';
  const now = new Date();
  if (input.toLowerCase() === 'hoy') return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  if (input.toLowerCase() === 'mañana' || input.toLowerCase() === 'manana') { const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz })); d.setDate(d.getDate()+1); return d; }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input); if (!m) return null;
  const [_, dd, mm, yyyy] = m; const d = new Date(Date.UTC(+yyyy, +mm-1, +dd)); return d;
}
function toISO(dateStr, hh, mm) {
  const tz = process.env.TIMEZONE || 'America/Bogota';
  const [y, m, d] = dateStr.split('-').map(n => +n);
  const local = new Date(); local.setFullYear(y); local.setMonth(m-1); local.setDate(d); local.setHours(+hh, +mm, 0, 0);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(local).map(p=>[p.type,p.value]));
  const isoLocal = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`; return new Date(isoLocal + 'Z').toISOString();
}
function fmtDateTime(iso) { const d = new Date(iso); return d.toLocaleString('es-CO', { timeZone: process.env.TIMEZONE || 'America/Bogota', dateStyle: 'long', timeStyle: 'short' }); }
function fmtHour(iso) { const d = new Date(iso); return d.toLocaleTimeString('es-CO', { timeZone: process.env.TIMEZONE || 'America/Bogota', hour: '2-digit', minute: '2-digit' }); }