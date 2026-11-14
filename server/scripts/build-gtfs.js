// Convierte un GTFS (zip o URL) en data/gtfs.json con paraderos y patrones.
// Uso: npm run gtfs -- <archivo.zip | URL>   (o variable GTFS_URL)
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

export function unzip(buf) { // lector zip mínimo (sin zip64)
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip inválido');
  const n = buf.readUInt16LE(e + 10); let o = buf.readUInt32LE(e + 16); const files = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), nl = buf.readUInt16LE(o + 28), el = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32), lo = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nl);
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(ds, ds + csize);
    files[path.basename(name)] = () => (method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 2 ** 31 - 1 }));
    o += 46 + nl + el + cl;
  }
  return files;
}
function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; }
  out.push(cur); return out;
}
function eachRow(buf, fn) { // recorre el buffer línea a línea sin crear un string gigante
  let start = buf[0] === 0xef ? 3 : 0, head = null;
  while (start < buf.length) {
    let end = buf.indexOf(10, start); if (end < 0) end = buf.length;
    let line = buf.toString('utf8', start, end); if (line.endsWith('\r')) line = line.slice(0, -1); start = end + 1;
    if (!line) continue; const cols = splitCsv(line);
    if (!head) { head = Object.fromEntries(cols.map((c, i) => [c.trim(), i])); continue; }
    fn(cols, head);
  }
}
const secs = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

export function build(files) {
  const need = (n) => { if (!files[n]) throw new Error('falta ' + n); return files[n](); };
  const stops = [], stopIdx = new Map();
  eachRow(need('stops.txt'), (c, h) => { stopIdx.set(c[h.stop_id], stops.length); stops.push({ name: c[h.stop_name], lat: +c[h.stop_lat], lon: +c[h.stop_lon] }); });
  const routes = new Map();
  eachRow(need('routes.txt'), (c, h) => routes.set(c[h.route_id], { name: c[h.route_short_name] || c[h.route_long_name], type: +c[h.route_type], color: h.route_color != null && c[h.route_color] ? '#' + c[h.route_color] : null }));
  const trips = new Map();
  eachRow(need('trips.txt'), (c, h) => trips.set(c[h.trip_id], { route: c[h.route_id], dir: h.direction_id != null ? c[h.direction_id] : '0', headsign: h.trip_headsign != null ? c[h.trip_headsign] : '', st: [] }));
  eachRow(need('stop_times.txt'), (c, h) => { const t = trips.get(c[h.trip_id]); const s = stopIdx.get(c[h.stop_id]); if (t && s != null) t.st.push([+c[h.stop_sequence], s, secs(c[h.arrival_time] || c[h.departure_time] || '0:0:0')]); });
  const headways = new Map();
  if (files['frequencies.txt']) eachRow(files['frequencies.txt'](), (c, h) => { const t = trips.get(c[h.trip_id]); if (!t) return; const k = t.route + '|' + t.dir; (headways.get(k) || headways.set(k, []).get(k)).push(+c[h.headway_secs] / 60); });
  const groups = new Map();
  for (const t of trips.values()) { if (t.st.length < 2) continue; const k = t.route + '|' + t.dir; const g = groups.get(k) || groups.set(k, { best: t, n: 0 }).get(k); g.n++; if (t.st.length > g.best.st.length) g.best = t; }
  const patterns = [];
  for (const [k, g] of groups) {
    const r = routes.get(g.best.route); if (!r) continue; const type = r.type === 1 || r.type === 2 ? 1 : 3; if (![0, 1, 2, 3, 700].includes(r.type) && r.type < 700) continue;
    const st = g.best.st.sort((a, b) => a[0] - b[0]), t0 = st[0][2], hw = headways.get(k);
    const headway = hw ? Math.round(hw.sort((a, b) => a - b)[hw.length >> 1]) : Math.min(30, Math.max(3, Math.round(960 / g.n)));
    patterns.push({ name: r.name, type, color: r.color, headsign: g.best.headsign, headway, stops: st.map((x) => x[1]), times: st.map((x) => x[2] - t0) });
  }
  return { built: new Date().toISOString(), stops, patterns };
}
export async function buildFrom(src) {
  const buf = /^https?:/.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : fs.readFileSync(src);
  return build(unzip(buf));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2] || process.env.GTFS_URL; if (!src) { console.error('Indica un zip o URL de GTFS'); process.exit(1); }
  const data = await buildFrom(src); const out = path.join(here, '..', 'data', 'gtfs.json');
  fs.writeFileSync(out, JSON.stringify(data)); console.log(`GTFS listo: ${data.stops.length} paraderos, ${data.patterns.length} patrones -> ${out}`);
}
