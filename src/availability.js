// src/availability.js
import { google } from 'googleapis';
import { readOAuth } from './store.js';

function client() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials(readOAuth());
  return google.calendar({ version: 'v3', auth: oauth2 });
}

export async function isOpenAt(isoStart, minutes = 90) {
  const tz = process.env.TIMEZONE || 'America/Bogota';
  const start = new Date(isoStart);
  const end   = new Date(start.getTime() + minutes * 60 * 1000);

  // Fechas bloqueadas
  const ymd = start.toISOString().slice(0, 10);
  const black = (process.env.BLACKOUT_DATES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (black.includes(ymd)) return { ok: false, reason: 'Fecha no disponible' };

  // Horario de apertura
  const opening = JSON.parse(process.env.OPENING_HOURS_JSON || '{}'); // {mon:[12,22], ...}
  const dow = ['sun','mon','tue','wed','thu','fri','sat'][start.getDay()];
  const win = opening[dow];
  if (!win) return { ok: false, reason: 'Día no laborable' };

  const local = new Date(start.toLocaleString('en-US', { timeZone: tz }));
  const hour  = local.getHours() + local.getMinutes() / 60;
  if (hour < win[0] || hour >= win[1]) {
    return { ok: false, reason: `Horario ${win[0]}:00–${win[1]}:00` };
  }

  // Calendario ocupado
  const fb = await client().freebusy.query({
    requestBody: {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      items: [{ id: process.env.GOOGLE_CALENDAR_ID }]
    }
  });
  const busy = fb.data.calendars[process.env.GOOGLE_CALENDAR_ID]?.busy || [];
  if (busy.length) return { ok: false, reason: 'Ya hay una reserva en ese horario' };

  return { ok: true, endISO: end.toISOString() };
}
