// Planificador simple de transporte público sobre patrones GTFS.
// Busca viajes directos y con una combinación, y los puntúa con un costo
// generalizado que castiga combinaciones y caminata ("fácil de seguir").
const R = 6371000, rad = (d) => d * Math.PI / 180;
export function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const WALK_FACTOR = 1.3;   // de línea recta a distancia por calles
const WALK_SPEED = 1.0;    // m/s, ritmo tranquilo
const CELL = 0.005;        // ~550 m
const ACCESS_M = 700, TRANSFER_M = 200;

export class Planner {
  constructor(data) {
    this.stops = data.stops; this.patterns = data.patterns;
    this.grid = new Map(); this.byStop = new Map();
    this.stops.forEach((s, i) => { const k = this.key(s.lat, s.lon); (this.grid.get(k) || this.grid.set(k, []).get(k)).push(i); });
    this.patterns.forEach((p, pi) => p.stops.forEach((s, i) => { (this.byStop.get(s) || this.byStop.set(s, []).get(s)).push([pi, i]); }));
  }
  key(lat, lon) { return Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL); }
  near(pt, radius) {
    const out = [], cy = Math.floor(pt.lat / CELL), cx = Math.floor(pt.lon / CELL), n = Math.ceil(radius / 400);
    for (let y = cy - n; y <= cy + n; y++) for (let x = cx - n; x <= cx + n; x++)
      for (const i of this.grid.get(y + ':' + x) || []) { const d = dist(pt, this.stops[i]) * WALK_FACTOR; if (d <= radius) out.push([i, d]); }
    return out;
  }
  leg(pi, i, j) {
    const p = this.patterns[pi], S = (k) => { const s = this.stops[p.stops[k]]; return { name: s.name, lat: s.lat, lon: s.lon }; };
    return { type: p.type === 1 ? 'metro' : 'bus', route: p.name, headsign: p.headsign || '', color: p.color || (p.type === 1 ? '#C81E35' : '#C81E35'),
      board: S(i), alight: S(j), nStops: j - i, stopNames: p.stops.slice(i + 1, j + 1).map((s) => this.stops[s].name),
      seconds: Math.max(60, p.times[j] - p.times[i]), headwayMin: p.headway || 10 };
  }
  plan(from, to) {
    const O = this.near(from, ACCESS_M), D = this.near(to, ACCESS_M);
    const destMap = new Map(); // patrón -> mejor bajada [j, caminata]
    for (const [s, d] of D) for (const [pi, j] of this.byStop.get(s) || []) { const c = destMap.get(pi); if (!c || d < c[1]) destMap.set(pi, [j, d]); }
    const cands = [];
    const push = (legs, walkO, walkD, walkX) => {
      const ride = legs.reduce((a, l) => a + l.seconds, 0), wait = legs.reduce((a, l) => a + l.headwayMin * 30, 0);
      const walkM = walkO + walkD + walkX, total = ride + wait + walkM / WALK_SPEED;
      const cost = ride + wait + (walkM / WALK_SPEED) * 1.5 + (legs.length - 1) * 600;
      cands.push({ legs, walkO, walkD, walkX, walkM, seconds: total, cost, transfers: legs.length - 1, metro: legs.some((l) => l.type === 'metro') });
    };
    for (const [s, dO] of O) for (const [p1, i] of this.byStop.get(s) || []) {
      const hit = destMap.get(p1);
      if (hit && hit[0] > i) push([this.leg(p1, i, hit[0])], dO, hit[1], 0);
      const P = this.patterns[p1];
      for (let k = i + 1; k < P.stops.length; k++) {
        const a = this.stops[P.stops[k]];
        for (const [b, dX] of this.near(a, TRANSFER_M)) for (const [p2, m] of this.byStop.get(b) || []) {
          if (p2 === p1 || this.patterns[p2].name === P.name) continue;
          const h2 = destMap.get(p2);
          if (h2 && h2[0] > m) push([this.leg(p1, i, k), this.leg(p2, m, h2[0])], dO, h2[1], dX);
        }
      }
    }
    const best = (f) => cands.filter(f).sort((a, b) => a.cost - b.cost)[0];
    const fmt = (c, id) => c && {
      id, title: id === 'metro' ? 'En metro' : 'En micro', minutes: Math.round(c.seconds / 60), walkMinutes: Math.round(c.walkM / WALK_SPEED / 60),
      transfers: c.transfers, vehicles: c.legs.map((l) => (l.type === 'metro' ? 'Metro ' : 'Micro ') + l.route),
      ease: c.transfers === 0 ? (c.walkM / WALK_SPEED <= 600 ? 3 : 2) : 1, walkMeters: [Math.round(c.walkO), Math.round(c.walkX), Math.round(c.walkD)], legs: c.legs };
    const walkM = dist(from, to) * WALK_FACTOR;
    const options = [fmt(best((c) => !c.metro), 'bus'), fmt(best((c) => c.metro), 'metro')].filter(Boolean);
    return { walk: { id: 'walk', title: 'Caminando', minutes: Math.round(walkM / WALK_SPEED / 60), meters: Math.round(walkM), ease: walkM <= 900 ? 3 : walkM <= 1800 ? 2 : 1 }, options };
  }
}
