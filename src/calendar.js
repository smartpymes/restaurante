import { google } from 'googleapis';
import { readOAuth, saveOAuth } from './store.js';

const scopes = ['https://www.googleapis.com/auth/calendar.events'];
const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);

export function getAuthUrl() { return oauth2.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' }); }
export async function handleOAuthCallback(code) { const { tokens } = await oauth2.getToken(code); await saveOAuth(tokens); }
export function isGoogleReady() { const t = readOAuth(); return !!t?.access_token || !!t?.refresh_token; }

function getClient() { const tokens = readOAuth(); oauth2.setCredentials(tokens); return google.calendar({ version: 'v3', auth: oauth2 }); }

export async function createBookingEvent({ summary, description, start, end }) {
  const cal = getClient(); const timezone = process.env.TIMEZONE || 'America/Bogota';
  const res = await cal.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: { summary, description, start: { dateTime: start, timeZone: timezone }, end: { dateTime: end, timeZone: timezone }, reminders: { useDefault: true } },
    sendUpdates: 'all'
  });
  return res.data;
}