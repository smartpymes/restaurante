// src/calendar.js
import { google } from 'googleapis';
import { readOAuth, saveOAuth } from './store.js';

const scopes = ['https://www.googleapis.com/auth/calendar.events'];
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Guarda tokens refrescados automáticamente
oauth2.on('tokens', (t) => {
  try {
    const prev = readOAuth() || {};
    const merged = { ...prev, ...t };
    if (t.access_token || t.refresh_token) saveOAuth(merged);
  } catch (e) { console.error('oauth save tokens error', e); }
});

export function getAuthUrl() {
  return oauth2.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
}

export async function handleOAuthCallback(code) {
  const { tokens } = await oauth2.getToken(code);
  await saveOAuth(tokens);
}

export function isGoogleReady() {
  const t = readOAuth();
  return !!t?.refresh_token || !!t?.access_token;
}

function cal() {
  const tokens = readOAuth();
  if (!tokens) throw new Error('No OAuth tokens saved');
  oauth2.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth: oauth2 });
}

export async function createBookingEvent({ summary, description, start, end, attendees = [] }) {
  if (!process.env.GOOGLE_CALENDAR_ID) throw new Error('Missing GOOGLE_CALENDAR_ID');
  const timezone = process.env.TIMEZONE || 'America/Bogota';

  const res = await cal().events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    sendUpdates: 'all',
    resource: {
      summary,
      description,
      start: { dateTime: start, timeZone: timezone },
      end:   { dateTime: end,   timeZone: timezone },
      attendees,
      reminders: { useDefault: true },
      extendedProperties: { private: { source: 'smartpyme-bot' } }
    }
  });
  return res.data; // { id, htmlLink, ... }
}

export async function deleteBookingEvent(eventId) {
  if (!eventId) return;
  try {
    await cal().events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId,
      sendUpdates: 'all'
    });
  } catch (e) {
    // Si ya no existe, no es error fatal
    if (e?.code !== 410 && e?.code !== 404) throw e;
  }
}
