import test from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http'; import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'; import { execSync } from 'node:child_process';
import { createApp } from '../src/server.js'; import { Planner } from '../src/planner.js'; import { build, unzip } from '../scripts/build-gtfs.js';

// GTFS sintético: micro 506 (este-oeste), metro L1 y L5 que se cruzan en "Baquedano".
const csv = {
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n' + [['A', 'Paradero Casa', -33.4500, -70.6000], ['B', 'Paradero Medio', -33.4500, -70.6100], ['C', '"Plaza Ñuñoa, norte"', -33.4500, -70.6200], ['M1', 'Los Leones', -33.4400, -70.6000], ['M2', 'Baquedano L1', -33.4400, -70.6300], ['N1', 'Baquedano L5', -33.4405, -70.6302], ['N2', 'Plaza de Armas', -33.4380, -70.6500]].map((r) => r.join(',')).join('\n') + '\n',
  'routes.txt': 'route_id,route_short_name,route_long_name,route_type,route_color\nR506,506,,3,C81E35\nL1,L1,Linea 1,1,E10E0E\nL5,L5,Linea 5,1,00A859\n',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nR506,S,T1,Maipu,0\nL1,S,T2,San Pablo,0\nL5,S,T3,Plaza de Maipu,0\n',
  'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,1\nT1,08:05:00,08:05:00,B,2\nT1,08:10:00,08:10:00,C,3\nT2,08:00:00,08:00:00,M1,1\nT2,08:06:00,08:06:00,M2,2\nT3,08:00:00,08:00:00,N1,1\nT3,08:04:00,08:04:00,N2,2\n',
  'frequencies.txt': 'trip_id,start_time,end_time,headway_secs\nT1,06:00:00,22:00:00,480\nT2,06:00:00,23:00:00,180\nT3,06:00:00,23:00:00,240\n',
};
const gtfs = build(Object.fromEntries(Object.entries(csv).map(([k, v]) => [k, () => Buffer.from(v)])));

let base, app, server, overpassCalls = 0;
const overpass = http.createServer((req, res) => { overpassCalls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ elements: [{ type: 'node', lat: -33.45001, lon: -70.60001, tags: { highway: 'traffic_signals' } }, { type: 'way', center: { lat: -33.4502, lon: -70.6101 }, tags: { amenity: 'pharmacy', brand: 'Cruz Verde' } }, { type: 'node', lat: -33.45002, lon: -70.61001, tags: { highway: 'crossing' } }] })); });
const call = async (method, url, { token, body, raw } = {}) => { const r = await fetch(base + url, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) }); const ct = r.headers.get('content-type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };

test.before(async () => {
  await new Promise((r) => overpass.listen(0, r));
  app = createApp({ dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rupu-')), 't.db'), adminToken: 'secreto', gtfs, overpassUrl: 'http://127.0.0.1:' + overpass.address().port });
  server = http.createServer(app.handler); await new Promise((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); overpass.close(); app.close(); });

test('GTFS: lector zip y patrones', () => {
  assert.equal(gtfs.stops.length, 7); assert.equal(gtfs.patterns.length, 3); assert.equal(gtfs.stops[2].name, 'Plaza Ñuñoa, norte');
  const p = gtfs.patterns.find((x) => x.name === '506'); assert.deepEqual(p.times, [0, 300, 600]); assert.equal(p.headway, 8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-')); for (const [k, v] of Object.entries(csv)) fs.writeFileSync(path.join(dir, k), v);
  try { execSync('zip -q feed.zip *.txt', { cwd: dir }); } catch { return; }
  const again = build(unzip(fs.readFileSync(path.join(dir, 'feed.zip')))); assert.equal(again.patterns.length, 3);
});

test('Planificador: micro directa, metro con combinación y caminata', () => {
  const pl = new Planner(gtfs);
  const direct = pl.plan({ lat: -33.4502, lon: -70.6002 }, { lat: -33.4502, lon: -70.6198 });
  const bus = direct.options.find((o) => o.id === 'bus'); assert.ok(bus); assert.equal(bus.transfers, 0); assert.equal(bus.legs[0].route, '506'); assert.equal(bus.legs[0].nStops, 2); assert.equal(bus.legs[0].alight.name, 'Plaza Ñuñoa, norte'); assert.equal(bus.ease, 3);
  assert.equal(direct.walk.id, 'walk'); assert.ok(direct.walk.minutes > bus.minutes);
  const metro = pl.plan({ lat: -33.4401, lon: -70.6001 }, { lat: -33.4381, lon: -70.6499 }).options.find((o) => o.id === 'metro');
  assert.ok(metro); assert.equal(metro.transfers, 1); assert.deepEqual(metro.legs.map((l) => l.route), ['L1', 'L5']); assert.equal(metro.ease, 1); assert.deepEqual(metro.vehicles, ['Metro L1', 'Metro L5']);
  assert.equal(pl.plan({ lat: -33.5, lon: -70.7 }, { lat: -33.51, lon: -70.71 }).options.length, 0);
});

test('Flujo completo entre persona usuaria, acompañante y superadmin', async () => {
  const maria = (await call('POST', '/api/register', { body: { name: 'María', role: 'user', comuna: 'Ñuñoa' } })).data;
  const caro = (await call('POST', '/api/register', { body: { name: 'Carolina', role: 'caregiver' } })).data;
  const otra = (await call('POST', '/api/register', { body: { name: 'Extraña', role: 'caregiver' } })).data;
  assert.ok(maria.token && caro.token); assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/register', { body: { name: 'x', role: 'admin' } })).status, 400);

  // Sola, sin acompañante: guarda un lugar con foto y viaja.
  const photo = (await call('POST', '/api/photos', { token: maria.token, raw: Buffer.from([0xff, 0xd8, 1, 2, 3]) })).data; assert.ok(photo.id);
  assert.equal((await call('GET', '/api/photos/' + photo.id)).data.length, 5);
  const route = { steps: [{ text: 'Camina derecho hasta el semáforo.', kind: 'straight', lat: -33.45, lon: -70.6, landmark: { type: 'estructural', kind: 'semaforo' } }, { text: 'En la reja azul, dobla a la derecha.', kind: 'right', photoId: photo.id, lat: -33.451, lon: -70.6 }] };
  const pan = (await call('POST', '/api/places', { token: maria.token, body: { name: 'La panadería', lat: -33.451, lon: -70.6, mode: 'walk', minutes: 6, photoId: photo.id, route } })).data;
  assert.equal(pan.level, 1); assert.equal(pan.route.steps.length, 2);
  assert.equal((await call('POST', '/api/places', { token: maria.token, body: { name: 'sin coords' } })).status, 400);

  // Vínculo por código. Sin suscripción el acompañante no ve nada.
  assert.equal((await call('POST', '/api/link/code', { token: caro.token })).status, 403);
  const { code } = (await call('POST', '/api/link/code', { token: maria.token })).data; assert.match(code, /^\d{4}$/);
  assert.equal((await call('POST', '/api/link/join', { token: caro.token, body: { code: '0000' } })).status, 404);
  assert.equal((await call('POST', '/api/link/join', { token: caro.token, body: { code, relation: 'hermana' } })).data.user.name, 'María');
  assert.equal((await call('POST', '/api/link/join', { token: otra.token, body: { code } })).status, 404, 'el código se usa una sola vez');
  assert.equal((await call('GET', '/api/places?user=' + maria.id, { token: caro.token })).status, 403, 'sin plan no hay acceso');
  assert.equal((await call('GET', '/api/places?user=' + maria.id, { token: otra.token })).status, 403);
  let sub = (await call('POST', '/api/subscription', { token: caro.token, body: { action: 'start_trial' } })).data; assert.equal(sub.state, 'trial'); assert.ok(sub.active);
  assert.equal((await call('GET', '/api/places?user=' + maria.id, { token: caro.token })).data.length, 1);
  assert.equal((await call('GET', '/api/me', { token: maria.token })).data.caregivers[0].name, 'Carolina');
  assert.equal((await call('GET', '/api/me', { token: caro.token })).data.people[0].name, 'María');

  // El acompañante prepara un lugar para María.
  const taller = (await call('POST', '/api/places', { token: caro.token, body: { userId: maria.id, name: 'Mi taller', lat: -33.45, lon: -70.62, mode: 'bus', minutes: 25, route } })).data; assert.equal(taller.userId, maria.id);
  const edited = (await call('PUT', '/api/places/' + taller.id, { token: caro.token, body: { route: { steps: [{ text: 'Nueva instrucción', kind: 'straight' }] } } })).data; assert.equal(edited.route.steps[0].text, 'Nueva instrucción'); assert.equal(edited.name, 'Mi taller');
  assert.equal((await call('GET', '/api/places', { token: maria.token })).data.length, 2);

  // Viaje en vivo.
  const trip = (await call('POST', '/api/trips', { token: maria.token, body: { placeId: taller.id, placeName: 'Mi taller', stepTotal: 9, mode: 'bus', lat: -33.45, lon: -70.6 } })).data;
  await call('PATCH', '/api/trips/' + trip.id, { token: maria.token, body: { stepIndex: 5, stepText: 'Siéntate o afírmate.', lat: -33.45, lon: -70.61, battery: 0.64 } });
  let live = (await call('GET', '/api/live?user=' + maria.id, { token: caro.token })).data; assert.equal(live.trip.stepIndex, 5); assert.equal(live.trip.stepText, 'Siéntate o afírmate.'); assert.equal(live.trip.battery, 0.64);
  assert.equal((await call('GET', '/api/live?user=' + maria.id, { token: otra.token })).status, 403);
  // María deja de compartir: el acompañante ya no ve el viaje ni el historial.
  await call('PATCH', '/api/me', { token: maria.token, body: { sharing: false } });
  live = (await call('GET', '/api/live?user=' + maria.id, { token: caro.token })).data; assert.equal(live.sharing, false); assert.equal(live.trip, null);
  assert.equal((await call('GET', '/api/feed?user=' + maria.id, { token: caro.token })).data.length, 0);
  await call('PATCH', '/api/me', { token: maria.token, body: { sharing: true } });

  // Pide ayuda: llega aunque no comparta; el acompañante envía un camino nuevo.
  const alert = (await call('POST', '/api/alerts', { token: maria.token, body: { kind: 'lost', tripId: trip.id, lat: -33.452, lon: -70.612, stepText: 'Bájate por la puerta de atrás.' } })).data; assert.deepEqual(alert.notified, ['Carolina']);
  const open = (await call('GET', '/api/alerts', { token: caro.token })).data; assert.equal(open.length, 1); assert.equal(open[0].userName, 'María');
  assert.equal((await call('GET', '/api/alerts', { token: otra.token })).data.length, 0);
  assert.equal((await call('POST', '/api/alerts/' + alert.id + '/reroute', { token: otra.token, body: { route } })).status, 403);
  await call('POST', '/api/alerts/' + alert.id + '/reroute', { token: caro.token, body: { route } });
  const inbox = (await call('GET', '/api/inbox', { token: maria.token })).data; assert.equal(inbox.reroute.steps.length, 2);
  assert.equal((await call('GET', '/api/inbox', { token: maria.token })).data.reroute, null, 'se entrega una sola vez');
  await call('POST', '/api/alerts/' + alert.id + '/resolve', { token: caro.token }); assert.equal((await call('GET', '/api/alerts', { token: caro.token })).data.length, 0);
  let ended = (await call('POST', '/api/trips/' + trip.id + '/end', { token: maria.token, body: { status: 'arrived' } })).data; assert.equal(ended.status, 'arrived'); assert.equal(ended.helped, true);
  ended = (await call('POST', '/api/trips/' + trip.id + '/end', { token: maria.token, body: { feeling: 'good' } })).data; assert.equal(ended.feeling, 'good');
  assert.equal((await call('GET', '/api/places', { token: maria.token })).data.find((p) => p.id === taller.id).tripsOk, 0, 'un viaje con ayuda no cuenta');
  const feed = (await call('GET', '/api/feed?user=' + maria.id, { token: caro.token })).data.map((e) => e.kind); assert.ok(feed.includes('start') && feed.includes('arrive') && feed.includes('help'));

  // Autonomía: 5 viajes sin ayuda permiten subir a nivel 2; con todo en nivel 3 el plan se pausa solo.
  assert.equal((await call('POST', '/api/places/' + taller.id + '/level', { token: caro.token, body: { level: 2 } })).status, 409);
  for (let i = 0; i < 5; i++) { const t = (await call('POST', '/api/trips', { token: maria.token, body: { placeId: taller.id, placeName: 'Mi taller' } })).data; await call('POST', '/api/trips/' + t.id + '/end', { token: maria.token, body: { status: 'arrived' } }); }
  assert.equal((await call('POST', '/api/places/' + taller.id + '/level', { token: caro.token, body: { level: 2 } })).data.level, 2);
  await call('POST', '/api/places/' + taller.id + '/level', { token: maria.token, body: { level: 3 } });
  assert.equal((await call('GET', '/api/subscription', { token: caro.token })).data.state, 'trial');
  await call('POST', '/api/places/' + pan.id + '/level', { token: maria.token, body: { level: 3 } });
  sub = (await call('GET', '/api/subscription', { token: caro.token })).data; assert.equal(sub.state, 'paused_autonomy'); assert.equal(sub.active, false);
  assert.equal((await call('GET', '/api/places?user=' + maria.id, { token: caro.token })).status, 403);
  // La ayuda sigue llegando con el plan en pausa.
  const a2 = (await call('POST', '/api/alerts', { token: maria.token, body: { kind: 'call' } })).data; assert.equal((await call('GET', '/api/alerts', { token: caro.token })).data[0].id, a2.id);
  // Un lugar nuevo en nivel 1 reactiva el plan.
  await call('POST', '/api/places', { token: maria.token, body: { name: 'Biblioteca', lat: -33.45, lon: -70.61 } });
  assert.equal((await call('GET', '/api/subscription', { token: caro.token })).data.state, 'active');
  // En nivel 3 el acompañante no ve el viaje en vivo.
  const t3 = (await call('POST', '/api/trips', { token: maria.token, body: { placeId: pan.id, placeName: 'La panadería' } })).data;
  live = (await call('GET', '/api/live?user=' + maria.id, { token: caro.token })).data; assert.equal(live.trip, null); assert.equal(live.autonomous, true);
  await call('POST', '/api/trips/' + t3.id + '/end', { token: maria.token, body: { status: 'abandoned' } });
  assert.equal((await call('POST', '/api/subscription', { token: caro.token, body: { action: 'pause' } })).data.state, 'paused_manual');
  assert.equal((await call('POST', '/api/subscription', { token: caro.token, body: { action: 'activate' } })).data.state, 'active');

  // Planificador e hitos por HTTP.
  const plan = (await call('GET', '/api/plan?flat=-33.4502&flon=-70.6002&tlat=-33.4502&tlon=-70.6198')).data; assert.equal(plan.transitAvailable, true); assert.equal(plan.options[0].legs[0].route, '506');
  assert.equal((await call('GET', '/api/plan?flat=x&flon=1&tlat=1&tlon=1')).status, 400);
  const lm = (await call('POST', '/api/landmarks', { body: { points: [{ lat: -33.45, lon: -70.6 }, { lat: -33.45, lon: -70.61 }, { lat: -33.3, lon: -70.5 }] } })).data.landmarks;
  assert.equal(lm[0].kind, 'semaforo'); assert.equal(lm[1].kind, 'pharmacy'); assert.equal(lm[1].name, 'Cruz Verde'); assert.equal(lm[2], null);
  await call('POST', '/api/landmarks', { body: { points: [{ lat: -33.45, lon: -70.6 }] } }); assert.equal(overpassCalls, 1, 'usa caché');

  // Superadmin: resumen sin ubicaciones.
  assert.equal((await call('POST', '/api/admin/login', { body: { token: 'malo' } })).status, 401);
  const admin = (await call('POST', '/api/admin/login', { body: { token: 'secreto' } })).data;
  assert.equal((await call('GET', '/api/admin/summary', { token: caro.token })).status, 403);
  const s = (await call('GET', '/api/admin/summary', { token: admin.token })).data;
  assert.equal(s.users, 1); assert.equal(s.caregivers, 2); assert.equal(s.mrrClp, 4990); assert.equal(s.tripsWeek, 6); assert.equal(s.tripsWeekNoHelpPct, 83); assert.equal(s.helpSteps[0].text, 'Bájate por la puerta de atrás.');
  assert.ok(!JSON.stringify(s).includes('"lat"'));
  assert.equal((await call('GET', '/admin')).status, 200);
  // Borrar y desvincular.
  assert.equal((await call('DELETE', '/api/places/' + pan.id, { token: otra.token })).status, 403);
  await call('DELETE', '/api/places/' + pan.id, { token: maria.token }); await call('DELETE', '/api/link/' + caro.id, { token: maria.token });
  assert.equal((await call('GET', '/api/places?user=' + maria.id, { token: caro.token })).status, 403);
});
