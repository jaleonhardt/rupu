// Servidor de Rupu: cuentas, vínculo usuario/acompañante, lugares, viajes en vivo,
// alertas de ayuda, suscripción, plan de autonomía, hitos (OSM) y planificador (GTFS).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite'; import { fileURLToPath } from 'node:url';
import { Planner, dist } from './planner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(here, '..', 'data');
const PRICE = Number(process.env.PRICE_CLP || 4990);
const now = () => Date.now(), uid = () => crypto.randomUUID();

export function createApp({ dbPath = path.join(DATA, 'rupu.db'), adminToken = process.env.ADMIN_TOKEN || 'cambia-este-token', gtfs = null, overpassUrl = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter' } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT, role TEXT, token TEXT UNIQUE, sharing INTEGER DEFAULT 1, comuna TEXT, phone TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS links(user_id TEXT, caregiver_id TEXT, relation TEXT, created INTEGER, PRIMARY KEY(user_id, caregiver_id));
    CREATE TABLE IF NOT EXISTS codes(code TEXT PRIMARY KEY, user_id TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY, user_id TEXT, name TEXT, lat REAL, lon REAL, photo_id TEXT, icon TEXT, mode TEXT, minutes INTEGER, level INTEGER DEFAULT 1, trips_ok INTEGER DEFAULT 0, route TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, owner TEXT, data BLOB, created INTEGER);
    CREATE TABLE IF NOT EXISTS trips(id TEXT PRIMARY KEY, user_id TEXT, place_id TEXT, place_name TEXT, started INTEGER, ended INTEGER, status TEXT, step_index INTEGER DEFAULT 0, step_total INTEGER DEFAULT 0, step_text TEXT, mode TEXT, lat REAL, lon REAL, battery REAL, helped INTEGER DEFAULT 0, feeling TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, user_id TEXT, trip_id TEXT, kind TEXT, lat REAL, lon REAL, step_text TEXT, created INTEGER, resolved INTEGER, reroute TEXT, reroute_seen INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, text TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS subs(caregiver_id TEXT PRIMARY KEY, state TEXT, since INTEGER, trial_ends INTEGER);`);
  const q = (sql) => db.prepare(sql);
  const planner = gtfs ? new Planner(gtfs) : null;
  const lmCache = new Map();

  class Err extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const need = (c, status, msg) => { if (!c) throw new Err(status, msg); };
  const auth = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const u = t && q('SELECT * FROM users WHERE token=?').get(t); need(u, 401, 'No autorizado'); return u; };
  const linked = (userId, cgId) => !!q('SELECT 1 FROM links WHERE user_id=? AND caregiver_id=?').get(userId, cgId);
  const sub = (cgId) => q('SELECT * FROM subs WHERE caregiver_id=?').get(cgId);
  const subActive = (cgId) => { const s = sub(cgId); return !!s && (s.state === 'active' || (s.state === 'trial' && s.trial_ends > now())); };
  // ¿Puede "me" leer o escribir datos de "userId"?
  const canAccess = (me, userId, { live = false } = {}) => {
    if (me.role === 'admin' && !live) return true;
    if (me.id === userId) return true;
    if (me.role !== 'caregiver' || !linked(userId, me.id)) return false;
    return subActive(me.id);
  };
  const event = (userId, kind, text) => q('INSERT INTO events(user_id,kind,text,created) VALUES(?,?,?,?)').run(userId, kind, text, now());
  const placeOut = (p) => p && ({ id: p.id, userId: p.user_id, name: p.name, lat: p.lat, lon: p.lon, photoId: p.photo_id, icon: p.icon, mode: p.mode, minutes: p.minutes, level: p.level, tripsOk: p.trips_ok, route: p.route ? JSON.parse(p.route) : null, updated: p.updated });
  const tripOut = (t) => t && ({ id: t.id, userId: t.user_id, placeId: t.place_id, placeName: t.place_name, started: t.started, ended: t.ended, status: t.status, stepIndex: t.step_index, stepTotal: t.step_total, stepText: t.step_text, mode: t.mode, lat: t.lat, lon: t.lon, battery: t.battery, helped: !!t.helped, feeling: t.feeling, updated: t.updated });
  const alertOut = (a) => a && ({ id: a.id, userId: a.user_id, userName: q('SELECT name FROM users WHERE id=?').get(a.user_id)?.name, tripId: a.trip_id, kind: a.kind, lat: a.lat, lon: a.lon, stepText: a.step_text, created: a.created, resolved: a.resolved, reroute: a.reroute ? JSON.parse(a.reroute) : null });
  const userOut = (u) => ({ id: u.id, name: u.name, role: u.role, sharing: !!u.sharing, comuna: u.comuna, phone: u.phone });
  const GOAL = { 1: 5, 2: 10 };
  // La suscripción se pausa sola cuando todas las rutas de las personas vinculadas están en nivel 3.
  const syncAutonomy = (cgId) => {
    const s = sub(cgId); if (!s || s.state === 'paused_manual') return;
    const rows = q('SELECT p.level FROM places p JOIN links l ON l.user_id=p.user_id WHERE l.caregiver_id=?').all(cgId);
    const all3 = rows.length > 0 && rows.every((r) => r.level === 3);
    if (all3 && (s.state === 'active' || s.state === 'trial')) q("UPDATE subs SET state='paused_autonomy', since=? WHERE caregiver_id=?").run(now(), cgId);
    if (!all3 && s.state === 'paused_autonomy') q("UPDATE subs SET state='active', since=? WHERE caregiver_id=?").run(now(), cgId);
  };
  const subOut = (cgId) => { const s = sub(cgId); return { state: !s ? 'none' : (s.state === 'trial' && s.trial_ends <= now() ? 'expired' : s.state), trialEnds: s?.trial_ends || null, priceClp: PRICE, active: subActive(cgId) }; };

  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

  on('GET', '/health', () => ({ ok: true, gtfs: planner ? { stops: planner.stops.length, patterns: planner.patterns.length } : null }));

  // ── Cuentas y vínculo ─────────────────────────────────────────────
  on('POST', '/api/register', ({ body }) => {
    need(body.name && ['user', 'caregiver'].includes(body.role), 400, 'Falta nombre o rol');
    const u = { id: uid(), token: crypto.randomBytes(24).toString('hex') };
    q('INSERT INTO users(id,name,role,token,comuna,phone,created) VALUES(?,?,?,?,?,?,?)').run(u.id, String(body.name).slice(0, 60), body.role, u.token, body.comuna || null, body.phone || null, now());
    return { id: u.id, token: u.token, role: body.role, name: body.name };
  });
  on('POST', '/api/admin/login', ({ body }) => { need(body.token === adminToken, 401, 'Token incorrecto'); let a = q("SELECT * FROM users WHERE role='admin'").get(); if (!a) { a = { id: uid(), token: crypto.randomBytes(24).toString('hex') }; q("INSERT INTO users(id,name,role,token,created) VALUES(?,?,'admin',?,?)").run(a.id, 'Superadmin', a.token, now()); } return { id: a.id, token: a.token, role: 'admin', name: 'Superadmin' }; });
  on('GET', '/api/me', ({ me }) => {
    const out = { ...userOut(me) };
    if (me.role === 'user') out.caregivers = q('SELECT u.id,u.name,u.phone,l.relation FROM links l JOIN users u ON u.id=l.caregiver_id WHERE l.user_id=?').all(me.id);
    if (me.role === 'caregiver') { out.people = q('SELECT u.id,u.name,u.phone,u.sharing FROM links l JOIN users u ON u.id=l.user_id WHERE l.caregiver_id=?').all(me.id).map((p) => ({ ...p, sharing: !!p.sharing })); out.subscription = subOut(me.id); }
    return out;
  });
  on('PATCH', '/api/me', ({ me, body }) => { if (body.sharing != null) q('UPDATE users SET sharing=? WHERE id=?').run(body.sharing ? 1 : 0, me.id); if (body.name) q('UPDATE users SET name=? WHERE id=?').run(String(body.name).slice(0, 60), me.id); if (body.phone != null) q('UPDATE users SET phone=? WHERE id=?').run(String(body.phone).slice(0, 20), me.id); return userOut(q('SELECT * FROM users WHERE id=?').get(me.id)); });
  on('POST', '/api/link/code', ({ me }) => { need(me.role === 'user', 403, 'Solo la persona usuaria crea el código'); q('DELETE FROM codes WHERE user_id=? OR expires<?').run(me.id, now()); let code; do { code = String(crypto.randomInt(1000, 10000)); } while (q('SELECT 1 FROM codes WHERE code=?').get(code)); q('INSERT INTO codes VALUES(?,?,?)').run(code, me.id, now() + 864e5); return { code }; });
  on('POST', '/api/link/join', ({ me, body }) => {
    need(me.role === 'caregiver', 403, 'Solo acompañantes'); const c = q('SELECT * FROM codes WHERE code=? AND expires>?').get(String(body.code || ''), now()); need(c, 404, 'Código no válido');
    q('INSERT OR IGNORE INTO links VALUES(?,?,?,?)').run(c.user_id, me.id, body.relation || null, now()); q('DELETE FROM codes WHERE code=?').run(c.code);
    const u = q('SELECT * FROM users WHERE id=?').get(c.user_id); event(u.id, 'link', me.name + ' ahora te acompaña'); return { user: userOut(u) };
  });
  on('DELETE', '/api/link/:otherId', ({ me, params }) => { q('DELETE FROM links WHERE (user_id=? AND caregiver_id=?) OR (user_id=? AND caregiver_id=?)').run(me.id, params.otherId, params.otherId, me.id); return { ok: true }; });

  // ── Suscripción (simulada: el cobro real va por StoreKit) ─────────
  on('GET', '/api/subscription', ({ me }) => subOut(me.id));
  on('POST', '/api/subscription', ({ me, body }) => {
    need(me.role === 'caregiver', 403, 'Solo acompañantes'); const a = body.action, s = sub(me.id);
    if (a === 'start_trial') { need(!s, 409, 'Ya tienes un plan'); q("INSERT INTO subs VALUES(?,'trial',?,?)").run(me.id, now(), now() + 30 * 864e5); }
    else if (a === 'activate') { s ? q("UPDATE subs SET state='active', since=? WHERE caregiver_id=?").run(now(), me.id) : q("INSERT INTO subs VALUES(?,'active',?,NULL)").run(me.id, now()); }
    else if (a === 'pause') { need(s, 404, 'Sin plan'); q("UPDATE subs SET state='paused_manual', since=? WHERE caregiver_id=?").run(now(), me.id); }
    else throw new Err(400, 'Acción desconocida');
    syncAutonomy(me.id); return subOut(me.id);
  });

  // ── Fotos ─────────────────────────────────────────────────────────
  on('POST', '/api/photos', ({ me, raw }) => { need(raw.length > 0 && raw.length < 6e6, 400, 'Foto vacía o muy grande'); const id = uid(); q('INSERT INTO photos VALUES(?,?,?,?)').run(id, me.id, raw, now()); return { id }; });
  on('GET', '/api/photos/:id', ({ params }) => { const p = q('SELECT data FROM photos WHERE id=?').get(params.id); need(p, 404, 'No existe'); return { __raw: Buffer.from(p.data), type: 'image/jpeg' }; });

  // ── Lugares y rutas guardadas ─────────────────────────────────────
  on('GET', '/api/places', ({ me, query }) => { const userId = query.user || me.id; need(canAccess(me, userId), 403, 'Sin acceso'); return q('SELECT * FROM places WHERE user_id=? ORDER BY updated DESC').all(userId).map(placeOut); });
  on('POST', '/api/places', ({ me, body }) => {
    const userId = body.userId || me.id; need(canAccess(me, userId), 403, 'Sin acceso'); need(body.name && body.lat != null && body.lon != null, 400, 'Falta nombre o ubicación');
    const id = uid(); q('INSERT INTO places(id,user_id,name,lat,lon,photo_id,icon,mode,minutes,level,route,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, userId, body.name, body.lat, body.lon, body.photoId || null, body.icon || 'pin', body.mode || 'walk', body.minutes || 0, body.level || 1, body.route ? JSON.stringify(body.route) : null, now());
    if (me.id !== userId) event(userId, 'place', me.name + ' guardó ' + body.name); q('SELECT caregiver_id FROM links WHERE user_id=?').all(userId).forEach((l) => syncAutonomy(l.caregiver_id));
    return placeOut(q('SELECT * FROM places WHERE id=?').get(id));
  });
  on('PUT', '/api/places/:id', ({ me, params, body }) => {
    const p = q('SELECT * FROM places WHERE id=?').get(params.id); need(p, 404, 'No existe'); need(canAccess(me, p.user_id), 403, 'Sin acceso');
    q('UPDATE places SET name=?, lat=?, lon=?, photo_id=?, icon=?, mode=?, minutes=?, route=?, updated=? WHERE id=?').run(body.name ?? p.name, body.lat ?? p.lat, body.lon ?? p.lon, body.photoId ?? p.photo_id, body.icon ?? p.icon, body.mode ?? p.mode, body.minutes ?? p.minutes, body.route ? JSON.stringify(body.route) : p.route, now(), p.id);
    return placeOut(q('SELECT * FROM places WHERE id=?').get(p.id));
  });
  on('DELETE', '/api/places/:id', ({ me, params }) => { const p = q('SELECT * FROM places WHERE id=?').get(params.id); need(p, 404, 'No existe'); need(canAccess(me, p.user_id), 403, 'Sin acceso'); q('DELETE FROM places WHERE id=?').run(p.id); return { ok: true }; });
  // Subir de nivel: la persona usuaria confirma, o su acompañante lo propone cuando se cumple la meta.
  on('POST', '/api/places/:id/level', ({ me, params, body }) => {
    const p = q('SELECT * FROM places WHERE id=?').get(params.id); need(p, 404, 'No existe'); need(canAccess(me, p.user_id), 403, 'Sin acceso');
    const level = Number(body.level); need([1, 2, 3].includes(level), 400, 'Nivel inválido');
    if (level > p.level && me.role === 'caregiver') need(p.trips_ok >= GOAL[p.level], 409, 'Aún faltan viajes sin ayuda');
    q('UPDATE places SET level=?, updated=? WHERE id=?').run(level, now(), p.id); q('SELECT caregiver_id FROM links WHERE user_id=?').all(p.user_id).forEach((l) => syncAutonomy(l.caregiver_id));
    return placeOut(q('SELECT * FROM places WHERE id=?').get(p.id));
  });

  // ── Viajes y seguimiento en vivo ──────────────────────────────────
  on('POST', '/api/trips', ({ me, body }) => {
    q("UPDATE trips SET status='abandoned', ended=? WHERE user_id=? AND ended IS NULL").run(now(), me.id);
    const id = uid(); q("INSERT INTO trips(id,user_id,place_id,place_name,started,status,step_total,step_text,mode,lat,lon,updated) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?)").run(id, me.id, body.placeId || null, body.placeName || 'Destino', now(), body.stepTotal || 0, body.stepText || '', body.mode || 'walk', body.lat ?? null, body.lon ?? null, now());
    event(me.id, 'start', 'Salió hacia ' + (body.placeName || 'su destino')); return tripOut(q('SELECT * FROM trips WHERE id=?').get(id));
  });
  on('PATCH', '/api/trips/:id', ({ me, params, body }) => {
    const t = q('SELECT * FROM trips WHERE id=? AND user_id=?').get(params.id, me.id); need(t, 404, 'No existe');
    q('UPDATE trips SET step_index=?, step_total=?, step_text=?, lat=?, lon=?, battery=?, updated=? WHERE id=?').run(body.stepIndex ?? t.step_index, body.stepTotal ?? t.step_total, body.stepText ?? t.step_text, body.lat ?? t.lat, body.lon ?? t.lon, body.battery ?? t.battery, now(), t.id);
    return { ok: true };
  });
  on('POST', '/api/trips/:id/end', ({ me, params, body }) => {
    const t = q('SELECT * FROM trips WHERE id=? AND user_id=?').get(params.id, me.id); need(t, 404, 'No existe'); const status = body.status === 'arrived' ? 'arrived' : 'abandoned';
    if (t.ended) { if (body.feeling) q('UPDATE trips SET feeling=? WHERE id=?').run(body.feeling, t.id); return tripOut(q('SELECT * FROM trips WHERE id=?').get(t.id)); }
    q('UPDATE trips SET ended=?, status=?, feeling=?, updated=? WHERE id=?').run(now(), status, body.feeling || null, now(), t.id);
    if (status === 'arrived') { event(me.id, 'arrive', 'Llegó a ' + t.place_name); if (t.place_id && !t.helped) q('UPDATE places SET trips_ok=trips_ok+1 WHERE id=?').run(t.place_id); }
    return tripOut(q('SELECT * FROM trips WHERE id=?').get(t.id));
  });
  on('GET', '/api/trips', ({ me, query }) => { const userId = query.user || me.id; need(canAccess(me, userId), 403, 'Sin acceso'); return q('SELECT * FROM trips WHERE user_id=? ORDER BY started DESC LIMIT 50').all(userId).map(tripOut); });
  on('GET', '/api/live', ({ me, query }) => {
    const u = q('SELECT * FROM users WHERE id=?').get(query.user || ''); need(u, 404, 'No existe'); need(canAccess(me, u.id, { live: true }), 403, 'Sin acceso');
    if (!u.sharing && me.id !== u.id) return { sharing: false, trip: null };
    const t = q("SELECT * FROM trips WHERE user_id=? AND ended IS NULL AND updated>? ORDER BY started DESC").get(u.id, now() - 30 * 6e4);
    const place = t?.place_id ? q('SELECT level FROM places WHERE id=?').get(t.place_id) : null;
    // Nivel 3 ("sola/solo"): el acompañante no ve el viaje, solo recibe pedidos de ayuda.
    if (t && place?.level === 3 && me.id !== u.id) return { sharing: true, trip: null, autonomous: true };
    return { sharing: true, trip: tripOut(t) };
  });
  on('GET', '/api/feed', ({ me, query }) => { const userId = query.user || me.id; need(canAccess(me, userId), 403, 'Sin acceso'); const u = q('SELECT sharing FROM users WHERE id=?').get(userId); if (me.id !== userId && !u.sharing) return []; return q('SELECT * FROM events WHERE user_id=? ORDER BY id DESC LIMIT 30').all(userId); });

  // ── Ayuda: siempre disponible, con o sin suscripción ──────────────
  on('POST', '/api/alerts', ({ me, body }) => {
    const id = uid(); q('INSERT INTO alerts(id,user_id,trip_id,kind,lat,lon,step_text,created) VALUES(?,?,?,?,?,?,?,?)').run(id, me.id, body.tripId || null, body.kind || 'lost', body.lat ?? null, body.lon ?? null, body.stepText || null, now());
    if (body.tripId) q('UPDATE trips SET helped=1 WHERE id=? AND user_id=?').run(body.tripId, me.id); event(me.id, 'help', 'Pidió ayuda');
    return { ...alertOut(q('SELECT * FROM alerts WHERE id=?').get(id)), notified: q('SELECT u.name FROM links l JOIN users u ON u.id=l.caregiver_id WHERE l.user_id=?').all(me.id).map((r) => r.name) };
  });
  on('GET', '/api/alerts', ({ me }) => (me.role === 'caregiver' ? q('SELECT a.* FROM alerts a JOIN links l ON l.user_id=a.user_id WHERE l.caregiver_id=? AND a.resolved IS NULL ORDER BY a.created DESC').all(me.id) : q('SELECT * FROM alerts WHERE user_id=? AND resolved IS NULL ORDER BY created DESC').all(me.id)).map(alertOut));
  const myAlert = (me, id) => { const a = q('SELECT * FROM alerts WHERE id=?').get(id); need(a, 404, 'No existe'); need(a.user_id === me.id || (me.role === 'caregiver' && linked(a.user_id, me.id)), 403, 'Sin acceso'); return a; };
  on('POST', '/api/alerts/:id/resolve', ({ me, params }) => { const a = myAlert(me, params.id); q('UPDATE alerts SET resolved=? WHERE id=?').run(now(), a.id); return { ok: true }; });
  on('POST', '/api/alerts/:id/reroute', ({ me, params, body }) => { const a = myAlert(me, params.id); need(me.role === 'caregiver', 403, 'Solo acompañantes'); need(body.route, 400, 'Falta la ruta'); q('UPDATE alerts SET reroute=?, reroute_seen=0 WHERE id=?').run(JSON.stringify(body.route), a.id); return { ok: true }; });
  // La app de la persona usuaria consulta si le enviaron un camino nuevo.
  on('GET', '/api/inbox', ({ me }) => { const a = q('SELECT * FROM alerts WHERE user_id=? AND reroute IS NOT NULL AND reroute_seen=0 ORDER BY created DESC').get(me.id); if (!a) return { reroute: null }; q('UPDATE alerts SET reroute_seen=1 WHERE id=?').run(a.id); return { reroute: JSON.parse(a.reroute), alertId: a.id }; });

  // ── Planificador de micro y metro ─────────────────────────────────
  on('GET', '/api/plan', ({ query }) => {
    const from = { lat: +query.flat, lon: +query.flon }, to = { lat: +query.tlat, lon: +query.tlon }; need([from.lat, from.lon, to.lat, to.lon].every(Number.isFinite), 400, 'Coordenadas inválidas');
    if (!planner) { const m = dist(from, to) * 1.3; return { transitAvailable: false, walk: { id: 'walk', title: 'Caminando', minutes: Math.round(m / 60), meters: Math.round(m), ease: m <= 900 ? 3 : m <= 1800 ? 2 : 1 }, options: [] }; }
    return { transitAvailable: true, ...planner.plan(from, to) };
  });

  // ── Hitos automáticos desde OpenStreetMap ─────────────────────────
  const BRAND = { pharmacy: 'la farmacia', supermarket: 'el supermercado', bank: 'el banco', fuel: 'la bencinera', convenience: 'el minimarket', bakery: 'la panadería' };
  on('POST', '/api/landmarks', async ({ body }) => {
    const pts = (body.points || []).slice(0, 25); const key = (p) => p.lat.toFixed(4) + ',' + p.lon.toFixed(4);
    const miss = pts.filter((p) => !lmCache.has(key(p)));
    if (miss.length) {
      const around = (p) => `(around:45,${p.lat},${p.lon})`;
      const ql = `[out:json][timeout:20];(${miss.map((p) => `node[highway~"traffic_signals|crossing"]${around(p)};nwr[amenity~"pharmacy|bank|fuel"]${around(p)};nwr[shop~"supermarket|convenience|bakery"]${around(p)};node[railway=subway_entrance]${around(p)};`).join('')});out center tags;`;
      let els = [];
      try { const r = await fetch(overpassUrl, { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'rupu-prototipo' }, signal: AbortSignal.timeout(25000) }); if (r.ok) els = (await r.json()).elements || []; } catch { els = null; }
      for (const p of miss) {
        if (els === null) continue; let best = null;
        for (const e of els) {
          const pos = { lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }; if (pos.lat == null) continue; const d = dist(p, pos); if (d > 50) continue; const t = e.tags || {};
          let c = null; const kind = t.amenity || t.shop;
          if (BRAND[kind]) c = { type: 'marca', kind, label: BRAND[kind], name: t.brand || t.name || null, rank: 3 };
          else if (t.railway === 'subway_entrance') c = { type: 'estructural', kind: 'metro', label: 'la entrada del metro', name: t.name || null, rank: 3 };
          else if (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals') c = { type: 'estructural', kind: 'semaforo', label: 'el semáforo', rank: 2 };
          else if (t.highway === 'crossing') c = { type: 'estructural', kind: 'cruce', label: 'el paso de cebra', rank: 1 };
          if (c && (!best || c.rank > best.rank || (c.rank === best.rank && d < best.d))) best = { ...c, d, lat: pos.lat, lon: pos.lon };
        }
        lmCache.set(key(p), best);
      }
    }
    return { landmarks: pts.map((p) => { const b = lmCache.get(key(p)); return b ? { type: b.type, kind: b.kind, label: b.label, name: b.name || null, lat: b.lat, lon: b.lon } : null; }) };
  });

  // ── Superadmin ────────────────────────────────────────────────────
  on('GET', '/api/admin/summary', ({ me }) => {
    need(me.role === 'admin', 403, 'Solo superadmin'); const n = (sql, ...a) => q(sql).get(...a).n; const week = now() - 7 * 864e5;
    const subs = q('SELECT state, COUNT(*) n FROM subs GROUP BY state').all(); const paying = subs.find((s) => s.state === 'active')?.n || 0;
    const tripsWeek = n("SELECT COUNT(*) n FROM trips WHERE started>? AND status='arrived'", week), helpedWeek = n("SELECT COUNT(*) n FROM trips WHERE started>? AND status='arrived' AND helped=1", week);
    return {
      users: n("SELECT COUNT(*) n FROM users WHERE role='user'"), caregivers: n("SELECT COUNT(*) n FROM users WHERE role='caregiver'"), soloUsers: n("SELECT COUNT(*) n FROM users u WHERE role='user' AND NOT EXISTS(SELECT 1 FROM links l WHERE l.user_id=u.id)"),
      subscriptions: Object.fromEntries(subs.map((s) => [s.state, s.n])), priceClp: PRICE, mrrClp: paying * PRICE, tripsWeek, tripsWeekNoHelpPct: tripsWeek ? Math.round(100 * (tripsWeek - helpedWeek) / tripsWeek) : null,
      levels: Object.fromEntries(q('SELECT level, COUNT(*) n FROM places GROUP BY level').all().map((r) => [r.level, r.n])), alertsWeek: n('SELECT COUNT(*) n FROM alerts WHERE created>?', week), alertsOpen: n('SELECT COUNT(*) n FROM alerts WHERE resolved IS NULL'),
      helpSteps: q('SELECT step_text text, COUNT(*) n FROM alerts WHERE step_text IS NOT NULL GROUP BY step_text ORDER BY n DESC LIMIT 5').all(),
      // Sin ubicaciones: el panel no muestra dónde está cada persona.
      people: q("SELECT u.id,u.name,u.role,u.comuna,u.created,(SELECT COUNT(*) FROM places p WHERE p.user_id=u.id) places,(SELECT COUNT(*) FROM places p WHERE p.user_id=u.id AND p.level=3) autonomous,(SELECT MAX(started) FROM trips t WHERE t.user_id=u.id) lastTrip FROM users u WHERE role!='admin' ORDER BY created DESC LIMIT 200").all(),
    };
  });
  on('GET', '/admin', () => ({ __raw: fs.readFileSync(path.join(here, 'admin.html')), type: 'text/html; charset=utf-8' }));

  const PUBLIC = new Set(['/health', '/api/register', '/api/admin/login', '/admin', '/api/plan', '/api/landmarks']);
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x'); const send = (status, obj) => { if (obj && obj.__raw) { res.writeHead(status, { 'content-type': obj.type, 'cache-control': 'private, max-age=86400' }); return res.end(obj.__raw); } res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname)); need(r, 404, 'No existe');
      const chunks = []; let size = 0; for await (const c of req) { size += c.length; need(size < 8e6, 413, 'Muy grande'); chunks.push(c); }
      const raw = Buffer.concat(chunks); let body = {};
      if (raw.length && (req.headers['content-type'] || '').includes('json')) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw new Err(400, 'JSON inválido'); } }
      const isPublic = PUBLIC.has(url.pathname) || url.pathname.startsWith('/api/photos/') && req.method === 'GET';
      const me = isPublic ? null : auth(req);
      send(200, await r.fn({ req, me, body, raw, query: Object.fromEntries(url.searchParams), params: url.pathname.match(r.re).groups || {} }));
    } catch (e) { if (!e.status) console.error(e); send(e.status || 500, { error: e.status ? e.message : 'Error interno' }); }
  };
  return { handler, db, close: () => db.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let gtfs = null; const file = path.join(DATA, 'gtfs.json');
  if (!fs.existsSync(file) && process.env.GTFS_URL) { try { const { buildFrom } = await import('../scripts/build-gtfs.js'); fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(await buildFrom(process.env.GTFS_URL))); } catch (e) { console.error('No pude preparar el GTFS:', e.message); } }
  if (fs.existsSync(file)) gtfs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const app = createApp({ gtfs }); const port = process.env.PORT || 8080;
  http.createServer(app.handler).listen(port, () => console.log(`Rupu en puerto ${port}. GTFS: ${gtfs ? gtfs.patterns.length + ' patrones' : 'no cargado'}`));
}
