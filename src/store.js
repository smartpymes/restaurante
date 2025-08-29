import Database from 'better-sqlite3'; import fs from 'fs';
const dbPath = './data.sqlite'; let db;
export async function initDb(){ const exists = fs.existsSync(dbPath); db = new Database(dbPath); if(!exists){ db.exec(`
  CREATE TABLE sessions (wa TEXT PRIMARY KEY, step INTEGER, payload TEXT);
  CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, wa TEXT, name TEXT, service TEXT, start TEXT, end TEXT, eventId TEXT, reminded INTEGER DEFAULT 0);
  CREATE TABLE oauth (id INTEGER PRIMARY KEY CHECK (id=1), tokens TEXT);
`);}}
export function upsertSession(wa, session){ db.prepare('INSERT INTO sessions (wa, step, payload) VALUES (?, ?, ?) ON CONFLICT(wa) DO UPDATE SET step=excluded.step, payload=excluded.payload').run(wa, session.step, JSON.stringify(session.payload||{})); }
export function getSession(wa){ const row = db.prepare('SELECT step, payload FROM sessions WHERE wa=?').get(wa); if(!row) return null; return { step: row.step, payload: JSON.parse(row.payload||'{}') }; }
export function resetSession(wa){ db.prepare('DELETE FROM sessions WHERE wa=?').run(wa); }
export function addBooking(b){ db.prepare('INSERT INTO bookings (wa, name, service, start, end, eventId) VALUES (?, ?, ?, ?, ?, ?)').run(b.wa, b.name, b.service, b.start, b.end, b.eventId); }
export function listBookingsDueReminders(){ const now = new Date(); const in2h = new Date(now.getTime()+2*60*60*1000).toISOString(); const nowIso = now.toISOString(); return db.prepare('SELECT * FROM bookings WHERE reminded=0 AND start BETWEEN ? AND ?').all(nowIso, in2h); }
export function markBookingReminded(id){ db.prepare('UPDATE bookings SET reminded=1 WHERE id=?').run(id); }
export async function saveOAuth(tokens){ db.prepare('INSERT INTO oauth (id, tokens) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens').run(JSON.stringify(tokens)); }
export function readOAuth(){ const row = db.prepare('SELECT tokens FROM oauth WHERE id=1').get(); if(!row) return null; try{ return JSON.parse(row.tokens);}catch{return null;} }