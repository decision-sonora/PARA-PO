'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const OpenAI = require('openai');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';       // set to lock admin socket events
const DRIVER_KEY = process.env.DRIVER_KEY || '';         // set to lock driver endpoints/events
const ADMIN_PATH = process.env.ADMIN_PATH || '/admin-secret-2026';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
let testPublic = process.env.TEST_PUBLIC === 'true';     // show test jeepneys to commuters? (admins can flip this live for demos)
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const ADMIN_OPEN = !ADMIN_TOKEN;
const DRIVER_OPEN = !DRIVER_KEY;

const MAX_CAPACITY = 20;
const STALE_JEEPNEY_MS = Number(process.env.STALE_JEEPNEY_MS) || 90 * 1000;  // drop jeepneys silent this long
const PING_TTL_MS = 5 * 60 * 1000;                                           // pings expire after 5 min
const MAX_PING_DISTANCE_M = Number(process.env.MAX_PING_DISTANCE_M) || 2000; // ignore pings from too far away

if (ADMIN_OPEN) console.warn('[WARN] ADMIN_TOKEN not set: admin socket events are open to everyone.');
if (DRIVER_OPEN) console.warn('[WARN] DRIVER_KEY not set: driver endpoints/events are open to everyone.');
if (!process.env.GROQ_API_KEY) console.warn('[WARN] GROQ_API_KEY not set: /api/ask-ai will be disabled.');

const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*';

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/other proxies
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10kb' }));

// ==================== HELPERS ====================
function safeEqual(a, b) {
    const A = Buffer.from(String(a || ''));
    const B = Buffer.from(String(b || ''));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function makeLimiter(max, windowMs) {
    const hits = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }, windowMs).unref();
    return (key) => {
        const now = Date.now();
        let e = hits.get(key);
        if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
        e.count += 1;
        return e.count <= max;
    };
}

function normalizePlate(p) {
    const plate = String(p || '').trim().toUpperCase();
    return /^[A-Z0-9 -]{2,20}$/.test(plate) ? plate : '';
}

function validCoords(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) &&
        lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
        !(lat === 0 && lon === 0); // 0,0 = "no GPS fix" in most devices
}

function cleanRoute(r) {
    if (r === undefined || r === null) return null;
    if (typeof r === 'string') return r.trim().slice(0, 100);
    try { return JSON.stringify(r).length <= 2000 ? r : null; } catch { return null; }
}

function getDistance(lat1, lon1, lat2, lon2) { // Haversine, meters (straight-line)
    const R = 6371e3;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==================== ROUTE CATALOG ====================
// STARTER DATA: each route is a list of named stops. Stop coordinates are looked up from OpenStreetMap
// (Nominatim) at startup and cached in .geocache.json, so nothing here is hand-typed GPS.
// Edit this list to match the real LTFRB / city route franchises. A route is drawn as a line from
// ROUTE_ANCHOR (downtown) out through its stops, ordered by distance from the anchor.
// Keep ids short and unique; drivers pick them from a dropdown. 'UNASSIGNED' is added by the pages.
const ROUTE_ANCHOR = 'Plaza Pershing';
const ROUTE_CATALOG = [
    { id: 'AYALA', stops: ['Ayala'] },
    { id: 'SINNUNUC', stops: ['Sinunuc'] },
    { id: 'CANELAR', stops: ['Canelar'] },
    { id: 'GUIWAN', stops: ['Guiwan'] },
    { id: 'TUMAGA', stops: ['Tumaga'] },
    { id: 'BALIWASAN', stops: ['Baliwasan', 'Western Mindanao State University'] },
    { id: 'PASONANCA', stops: ['Pasonanca'] },
    { id: 'PUTIK', stops: ['Putik'] },
    { id: 'STA MARIA', stops: ['Santa Maria'] },
    { id: 'SAN ROQUE', stops: ['San Roque'] },
    { id: 'CALARIAN', stops: ['Calarian'] },
    { id: 'TETUAN', stops: ['Tetuan', 'KCC Mall de Zamboanga'] },
    { id: 'MERCEDES', stops: ['Mercedes'] },
    { id: 'TALISAYAN', stops: ['Talisayan'] },
    { id: 'RECODO', stops: ['Recodo'] },
    { id: 'CAWIT', stops: ['Cawit'] },
    { id: 'AIRPORT', stops: ['Zamboanga International Airport'] }
];

const GEO_CACHE_FILE = path.join(__dirname, '.geocache.json');
let geoCache = {};
try { geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8')) || {}; } catch { geoCache = {}; }
let routesReady = false;
const routePaths = {}; // id -> { path: [[lat, lon], ...], names: [stop names in path order, anchor excluded] }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function geocodeStop(name) {
    if (geoCache[name]) return geoCache[name];
    try {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ph&bounded=1' +
            '&viewbox=121.85,7.25,122.35,6.85&q=' + encodeURIComponent(name + ', Zamboanga City');
        const r = await fetch(url, { headers: { 'User-Agent': 'PARA-PO/1.0 (jeepney tracker)' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const j = await r.json();
        if (!Array.isArray(j) || !j.length) return null;
        const lat = parseFloat(j[0].lat), lon = parseFloat(j[0].lon);
        if (!validCoords(lat, lon)) return null;
        geoCache[name] = { lat, lon };
        return geoCache[name];
    } catch (e) {
        console.warn('[routes] geocode failed for', name, e.message);
        return null;
    }
}

async function buildRoutePaths() {
    const names = new Set([ROUTE_ANCHOR]);
    for (const r of ROUTE_CATALOG) for (const s of r.stops) names.add(s);

    let fetched = false, missing = 0;
    for (const n of names) {
        const cached = !!geoCache[n];
        const g = await geocodeStop(n);
        if (!g) missing += 1;
        if (!cached) { fetched = fetched || !!g; await sleep(1100); } // Nominatim allows ~1 request/second
    }
    if (fetched) { try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache)); } catch { /* read-only disk is fine */ } }

    const anchor = geoCache[ROUTE_ANCHOR];
    for (const r of ROUTE_CATALOG) {
        const entries = r.stops.filter(s => geoCache[s]).map(s => ({ name: s, lat: geoCache[s].lat, lon: geoCache[s].lon }));
        if (anchor) entries.sort((a, b) => getDistance(anchor.lat, anchor.lon, a.lat, a.lon) - getDistance(anchor.lat, anchor.lon, b.lat, b.lon));
        const pts = entries.map(e => [e.lat, e.lon]);
        const pathPts = anchor ? [[anchor.lat, anchor.lon], ...pts] : pts;
        if (pathPts.length >= 2) routePaths[r.id] = { path: pathPts, names: entries.map(e => e.name) };
        else delete routePaths[r.id];
    }
    routesReady = Object.keys(routePaths).length > 0;
    console.log(`[routes] ${Object.keys(routePaths).length}/${ROUTE_CATALOG.length} routes ready` + (missing ? `, ${missing} stop(s) could not be located` : ''));
    if (missing) setTimeout(() => buildRoutePaths().catch(e => console.error('[routes]', e)), 10 * 60 * 1000).unref(); // retry later
}
buildRoutePaths().catch(e => console.error('[routes]', e));

// distance from a point to a polyline (meters) and how far along the polyline the closest point is
function projectOnPath(pathPts, lat, lon) {
    const mx = 111320 * Math.cos(lat * Math.PI / 180), my = 110540;
    let best = { dist: Infinity, along: 0 }, acc = 0;
    for (let i = 1; i < pathPts.length; i++) {
        const a = pathPts[i - 1], b = pathPts[i];
        const segLen = getDistance(a[0], a[1], b[0], b[1]);
        const ax = (a[1] - lon) * mx, ay = (a[0] - lat) * my;
        const dx = (b[1] - lon) * mx - ax, dy = (b[0] - lat) * my - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best.dist) best = { dist: d, along: acc + segLen * t };
        acc += segLen;
    }
    return best;
}

const ROUTE_TOLERANCE_M = 1200;   // stops are coarse, so allow some slack between a point and the drawn line
const MIN_RIDE_M = 300;           // origin and destination must be at least this far apart along the route

const planLimiter = makeLimiter(20, 60 * 1000);

app.get('/api/routes', (req, res) => {
    res.json({ ready: routesReady, routes: ROUTE_CATALOG.map(r => ({ id: r.id, stops: r.stops })) });
});

app.post('/api/plan', (req, res) => {
    if (!planLimiter(req.ip)) return res.status(429).json({ error: 'Too many searches. Please wait a moment.' });
    const b = req.body || {};
    const fromLat = Number(b.fromLat), fromLon = Number(b.fromLon), toLat = Number(b.toLat), toLon = Number(b.toLon);
    if (!validCoords(fromLat, fromLon) || !validCoords(toLat, toLon)) return res.status(400).json({ error: 'Invalid coordinates.' });
    if (!routesReady) return res.status(503).json({ error: 'Route data is still loading. Try again in a minute.' });

    const matches = [], servesDestination = [], servesOrigin = [];
    for (const r of ROUTE_CATALOG) {
        const rp = routePaths[r.id];
        if (!rp) continue;
        const o = projectOnPath(rp.path, fromLat, fromLon);
        const d = projectOnPath(rp.path, toLat, toLon);
        if (d.dist <= ROUTE_TOLERANCE_M) servesDestination.push({ id: r.id, distM: Math.round(d.dist) });
        if (o.dist <= ROUTE_TOLERANCE_M) servesOrigin.push({ id: r.id, distM: Math.round(o.dist) });
        if (o.dist <= ROUTE_TOLERANCE_M && d.dist <= ROUTE_TOLERANCE_M && Math.abs(o.along - d.along) >= MIN_RIDE_M) {
            matches.push({
                id: r.id,
                stops: rp.names,
                walkToBoardM: Math.round(o.dist),
                walkFromAlightM: Math.round(d.dist),
                rideM: Math.round(Math.abs(o.along - d.along)),
                towards: d.along > o.along ? rp.names[rp.names.length - 1] : ROUTE_ANCHOR,
                path: rp.path
            });
        }
    }
    matches.sort((a, b) => (a.walkToBoardM + a.walkFromAlightM) - (b.walkToBoardM + b.walkFromAlightM));
    servesDestination.sort((a, b) => a.distM - b.distM);
    servesOrigin.sort((a, b) => a.distM - b.distM);
    res.json({ routes: matches.slice(0, 5), servesDestination: servesDestination.slice(0, 4), servesOrigin: servesOrigin.slice(0, 4) });
});

// ==================== FARE + DISTANCE (server-side, so the AI never does the math) ====================
function computeFare(km, modern) {
    const base = modern ? 17 : 14;
    const perKm = modern ? 2.4 : 2;
    const extraKm = Math.max(0, Math.ceil(km - 4)); // any started succeeding km is charged
    return Number((base + extraKm * perKm).toFixed(2));
}

const DISTANCES_FROM_KCC = [
    { label: 'Ayala', aliases: ['ayala'], km: 16.0 },
    { label: 'Zamboanga International Airport', aliases: ['airport', 'zamboanga international airport'], km: 3.7 },
    { label: 'WMSU', aliases: ['wmsu', 'western mindanao state university'], km: 3.2 },
    { label: 'Fort Pilar', aliases: ['fort pilar'], km: 1.4 },
    { label: 'SM City Mindpro', aliases: ['sm city mindpro', 'sm mindpro', 'mindpro'], km: 0.5 }
];

function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildRouteHint(text) {
    const lines = [];
    for (const r of ROUTE_CATALOG) {
        const terms = [r.id.toLowerCase(), ...r.stops.map(s => s.toLowerCase())];
        if (terms.some(t => new RegExp('\\b' + escRegex(t) + '\\b').test(text))) {
            lines.push(`Route ${r.id} serves: ${r.stops.join(', ')}.`);
        }
        if (lines.length >= 5) break;
    }
    return lines;
}

function buildVerifiedHint(message) {
    const text = message.toLowerCase();
    const lines = [];
    for (const d of DISTANCES_FROM_KCC) {
        if (d.aliases.some(a => new RegExp('\\b' + escRegex(a) + '\\b').test(text))) {
            lines.push(`${d.label} to KCC Mall: ${d.km} km. Traditional fare PHP ${computeFare(d.km, false)}, modern fare PHP ${computeFare(d.km, true)}.`);
        }
    }
    const m = text.match(/(\d+(?:\.\d+)?)\s*km/);
    if (m) {
        const km = Math.min(parseFloat(m[1]), 200);
        lines.push(`For ${km} km: traditional fare PHP ${computeFare(km, false)}, modern fare PHP ${computeFare(km, true)}.`);
    }
    let out = lines.length
        ? '\n\nSERVER-VERIFIED FIGURES FOR THIS QUESTION (use these exactly, do not recalculate):\n' + lines.join('\n')
        : '';
    const routeLines = buildRouteHint(text);
    if (routeLines.length) out += '\n\nSERVER-VERIFIED ROUTE MATCHES FOR THIS QUESTION:\n' + routeLines.join('\n');
    return out;
}

function toPlainText(t) {
    return String(t || '')
        .replace(/\*\*|__|`/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*\*\s+/gm, '- ')
        .trim();
}

// ==================== GROQ AI ====================
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY || 'missing-key',
    timeout: 20000,
    maxRetries: 1
});

const SYSTEM_PROMPT = `You are PARA-PO Bot, a helpful assistant for jeepney commuters in Zamboanga City. Keep answers short and friendly.

RULES:
1. DO NOT use markdown formatting (no asterisks, no hashtags, no bold). Use plain text only.
2. Reply in the same language the commuter uses (English, Tagalog, Chavacano, Cebuano, etc.).
3. If asked about a location, use the database below.
4. For distances, use ONLY the verified matrix or the SERVER-VERIFIED FIGURES section if present. If a distance is not listed, say you do not have a verified distance for it and suggest checking the route on the PARA-PO map. Never guess a number.
5. For fares, use ONLY figures given in SERVER-VERIFIED FIGURES. If none are given, explain the fare rules and ask for the distance. Never calculate fares yourself.
6. You have a ROUTE CATALOG below (route names and the places they serve). You do NOT have schedules, exact roads, or which jeepneys are online. When asked which jeepney to ride, name routes only from the catalog or the SERVER-VERIFIED ROUTE MATCHES section, say the catalog is a guide, and tell the commuter to type the destination in the "Where are you going?" box on the PARA-PO map to see the route and the jeepneys on it live. If the place is not in the catalog, say so and point to that box.
7. Students, senior citizens and persons with disabilities are entitled to a 20 percent fare discount on public transport. Mention it when relevant.

ROUTE CATALOG (route name: places served, starting from downtown):
${ROUTE_CATALOG.map(r => `- ${r.id}: ${r.stops.join(', ')}`).join('\n')}

ZAMBOANGA CITY LANDMARK DATABASE:
Malls: KCC Mall de Zamboanga, SM City Mindpro, City Mall Tetuan, Southway Square, Canelar Barter Trade.
Tourist Spots: Fort Pilar, Pasonanca Park, Paseo del Mar, R.T. Lim Boulevard, Cawa-Cawa Boulevard, Sta. Cruz Island, Taluksangay Mosque, Plaza Pershing, Metropolitan Cathedral.
Schools: Western Mindanao State University (WMSU), Ateneo de Zamboanga University (ADZU), Universidad de Zamboanga (UZ), Zamboanga State College of Marine Sciences and Technology (ZSCMST), Don Pablo Lorenzo Memorial High School.
Hospitals: Zamboanga City Medical Center (ZCMC), Brent Hospital, Mindanao Central Sanitarium, Zamboanga Doctors Hospital.
Transport: Zamboanga International Airport, Integrated Bus Terminal (Canelar).
Roads: Governor Camins Avenue, Maria Clara Lobregat Highway, Veterans Avenue, La Purisima Street, Nu\u00f1ez Extension, Airport Road.
Barangays: Ayala, San Jose Gusu, Sinnunuc, Tetuan, Canelar, Guiwan, Tumaga, Putik, Divisoria, Sta. Maria, Sta. Barbara, Baliwasan, San Roque, Calarian, Cawit, Recodo, Talisayan, Pasonanca, Mercedes, Sta. Catalina, San Jose Cawa-Cawa.

VERIFIED DRIVING DISTANCE MATRIX (From KCC Mall):
${DISTANCES_FROM_KCC.map(d => `- ${d.label} to KCC Mall: ${d.km.toFixed(1)} km`).join('\n')}

Fare Rules:
- Traditional Jeepneys: Minimum PHP 14 for first 4km, +PHP 2 per succeeding km.
- Modern Jeepneys: Minimum PHP 17 for first 4km, +PHP 2.40 per succeeding km.`;

const aiLimiter = makeLimiter(15, 60 * 1000); // 15 questions/min per IP

function cleanHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.slice(-6)
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .map(h => ({ role: h.role, content: h.content.slice(0, 500) }));
}

app.post('/api/ask-ai', async (req, res) => {
    try {
        if (!aiLimiter(req.ip)) return res.status(429).json({ error: 'Too many questions. Please wait a moment.' });

        const userMessage = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
        if (!userMessage) return res.status(400).json({ error: 'Message required' });
        if (userMessage.length > 500) return res.status(400).json({ error: 'Message too long (max 500 characters).' });
        if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'The assistant is not available right now.' });

        const completion = await groq.chat.completions.create({
            model: GROQ_MODEL,
            temperature: 0.3,
            max_tokens: 600,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...cleanHistory(req.body.history),
                { role: 'user', content: userMessage + buildVerifiedHint(userMessage) }
            ]
        });

        const reply = toPlainText(completion.choices?.[0]?.message?.content);
        res.json({ reply: reply || 'Sorry, I could not come up with an answer. Please try again.' });
    } catch (error) {
        console.error('[ask-ai]', error);
        res.status(502).json({ error: 'The assistant is having trouble right now. Please try again shortly.' });
    }
});

// ==================== PAGE ROUTES ====================
const STATIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
const pageFile = (name) => {
    const inPublic = path.join(__dirname, 'public', name);
    return fs.existsSync(inPublic) ? inPublic : path.join(__dirname, name);
};

app.get('/health', (req, res) => res.json({ ok: true, jeepneys: Object.keys(activeJeepneys).length, routesReady }));
app.get('/', (req, res) => res.sendFile(pageFile('index.html')));
app.get('/driver', (req, res) => res.sendFile(pageFile('driver.html')));
app.get(ADMIN_PATH, (req, res) => res.sendFile(pageFile('admin.html')));

// Never serve server code, secrets, or the admin page by its direct filename.
const BLOCKED = /^\/(server\.js|package(-lock)?\.json|node_modules|admin\.html|render\.yaml|dockerfile)/;
app.use((req, res, next) => {
    let p;
    try { p = decodeURIComponent(req.path).toLowerCase(); } catch { return res.status(400).end(); }
    if (BLOCKED.test(p) || p.includes('/.')) return res.status(404).end();
    next();
});
app.use(express.static(STATIC_DIR, { dotfiles: 'deny', index: false }));

// ==================== REAL-TIME STATE ====================
let activeJeepneys = {};   // plate -> { plate, lat, lon, route, lastSeen, ... }
let testJeepneys = {};
let testPassengers = {};   // id -> { id, lat, lon, boarded: plate|null, pingPlate: plate|null }
let jeepneyStatus = {};    // plate -> { count, max, isFull, manualFull }
let activePings = {};      // plate -> Map(key -> { passLat, passLon, at, ack, testId? }); key = socketId, or "test:<id>" for test passengers
let testSeq = 0;

const isTestPlate = (plate) => String(plate).startsWith('TEST-');

function ensureStatus(plate) {
    if (!jeepneyStatus[plate]) jeepneyStatus[plate] = { count: 0, max: MAX_CAPACITY, isFull: false, manualFull: false };
    return jeepneyStatus[plate];
}
function recomputeFull(s) { s.isFull = s.manualFull || s.count >= s.max; }
function broadcastStatus(plate) { io.emit('status_update', { plate, status: jeepneyStatus[plate] }); }

function emitTest(event, payload) {
    if (testPublic) return io.emit(event, payload);
    const plate = typeof payload === 'string' ? payload : payload && payload.plate;
    let target = io.to('admin');
    if (plate && isTestPlate(plate)) target = target.to(`driver:${plate}`); // a driver hub "driving" this test jeepney
    target.emit(event, payload);
}

function getAnyJeepney(plate, socket) {
    if (activeJeepneys[plate]) return activeJeepneys[plate];
    const t = testJeepneys[plate];
    if (t && (testPublic || socket?.data?.isAdmin || (socket?.data?.isDriver && socket.data.plate === plate))) return t;
    return null;
}

// ---- ping helpers ----
// Pings stay on the books after the driver acknowledges them (ack = true) so the driver keeps the
// passenger's location on the map until the passenger boards, cancels, or the ping expires.
function unackedCount(plate) {
    const m = activePings[plate];
    if (!m) return 0;
    let n = 0;
    for (const p of m.values()) if (!p.ack) n += 1;
    return n;
}

function pingId(key, p) {
    return p.testId || crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8); // never expose socket ids
}

// send the driver the current list of waiting passengers so the driver hub can draw the road line
function emitDriverPings(plate) {
    const m = activePings[plate];
    const passengers = m ? [...m].map(([key, p]) => ({ id: pingId(key, p), lat: p.passLat, lon: p.passLon, ack: !!p.ack })) : [];
    io.to(`driver:${plate}`).emit('driver_pings', { plate, passengers });
}

function pushTestPassenger(p) { emitTest('test_passenger_update', p); }

function emitPingCancelled(plate, remaining) {
    io.to(`driver:${plate}`).emit('ping_cancelled', { plate, remaining });
    if (isTestPlate(plate)) io.to('admin').emit('ping_cancelled', { plate, remaining }); // test jeepneys are "driven" from the admin console
    emitDriverPings(plate);
}

function dropPing(plate, key) {
    const m = activePings[plate];
    if (!m) return 0;
    m.delete(key);
    if (m.size === 0) delete activePings[plate];
    return unackedCount(plate);
}

function cancelTestPing(id) {
    const p = testPassengers[id];
    if (!p || !p.pingPlate) return;
    const plate = p.pingPlate;
    p.pingPlate = null;
    const remaining = dropPing(plate, `test:${id}`);
    emitPingCancelled(plate, remaining);
    pushTestPassenger(p);
}

function releaseTestSeat(id) {
    const p = testPassengers[id];
    if (!p || !p.boarded) return;
    const plate = p.boarded;
    p.boarded = null;
    const s = jeepneyStatus[plate];
    if (s) {
        if (s.count > 0) s.count -= 1;
        recomputeFull(s);
        broadcastStatus(plate);
    }
    pushTestPassenger(p);
}

function detachFromJeepney(plate) { // jeepney vanished: free any test passengers tied to it
    for (const p of Object.values(testPassengers)) {
        let changed = false;
        if (p.boarded === plate) { p.boarded = null; changed = true; }
        if (p.pingPlate === plate) { p.pingPlate = null; changed = true; }
        if (changed) pushTestPassenger(p);
    }
}

function carryPassengers(plate, lat, lon) { // riders move with their jeepney
    for (const p of Object.values(testPassengers)) {
        if (p.boarded === plate) { p.lat = lat; p.lon = lon; pushTestPassenger(p); }
    }
}

// tell whoever made a ping that it ended (real passenger socket, or the admin console for test passengers)
function notifyPingEnd(plate, key, p, reason) {
    if (p && p.testId) {
        const tp = testPassengers[p.testId];
        if (tp && tp.pingPlate === plate) { tp.pingPlate = null; pushTestPassenger(tp); }
        io.to('admin').emit('test_ping_expired', { plate, id: p.testId, reason });
    } else {
        io.to(key).emit('ping_expired', { plate, reason });
    }
}

// ==================== HTTP: DRIVER GPS UPDATES ====================
const updateLimiter = makeLimiter(120, 60 * 1000);

app.post('/api/update', (req, res) => {
    if (!DRIVER_OPEN && !safeEqual(req.get('x-driver-key'), DRIVER_KEY)) {
        return res.status(401).send('Unauthorized');
    }
    const d = req.body || {};
    const plate = normalizePlate(d.plate);
    const lat = Number(d.lat);
    const lon = Number(d.lon);

    if (!plate || isTestPlate(plate)) return res.status(400).send('Invalid plate');
    if (!validCoords(lat, lon)) return res.status(400).send('Invalid coordinates');
    if (!updateLimiter(plate)) return res.status(429).send('Too many updates');

    const prev = activeJeepneys[plate] || {};
    const isNew = !activeJeepneys[plate];
    const route = d.route !== undefined ? cleanRoute(d.route) : prev.route;

    activeJeepneys[plate] = { ...prev, ...d, plate, lat, lon, route, lastSeen: Date.now() };
    ensureStatus(plate);

    io.emit('jeepney_update', activeJeepneys[plate]);
    carryPassengers(plate, lat, lon);
    if (isNew) broadcastStatus(plate);
    res.status(200).send('OK');
});

// ==================== SOCKET.IO ====================
function promoteAdmin(socket) {
    socket.data.isAdmin = true;
    socket.join('admin');
    socket.emit('initial_test_jeepneys', testJeepneys);
    socket.emit('initial_test_passengers', testPassengers);
    socket.emit('test_public_state', testPublic);
}

function canDrive(socket, plate) {
    if (socket.data.isAdmin) return true;
    if (DRIVER_OPEN) return true;
    return socket.data.isDriver && (!socket.data.plate || socket.data.plate === plate);
}

function alertDriver(plate, payload) {
    if (isTestPlate(plate)) { io.to('admin').to(`driver:${plate}`).emit('driver_alert', payload); return true; } // demo: admin console and any driver hub on this test jeepney
    const room = `driver:${plate}`;
    const hasDriver = (io.sockets.adapter.rooms.get(room)?.size || 0) > 0;
    if (hasDriver) { io.to(room).emit('driver_alert', payload); return true; }
    if (DRIVER_OPEN) { io.emit('driver_alert', payload); return true; } // legacy: driver pages that never registered
    return false;
}

function releaseSeat(socket) {
    const plate = socket.data.boardedPlate;
    if (!plate) return;
    socket.data.boardedPlate = null;
    const s = jeepneyStatus[plate];
    if (!s) return;
    if (s.count > 0) s.count -= 1;
    recomputeFull(s);
    broadcastStatus(plate);
}

io.on('connection', (socket) => {
    const auth = socket.handshake.auth || {};
    socket.data.isAdmin = false;
    socket.data.isDriver = !DRIVER_OPEN && safeEqual(auth.driverKey, DRIVER_KEY);
    socket.data.plate = null;
    socket.data.boardedPlate = null;

    socket.emit('initial_jeepneys', activeJeepneys);
    socket.emit('initial_status', jeepneyStatus);

    if (ADMIN_OPEN || safeEqual(auth.adminToken, ADMIN_TOKEN)) promoteAdmin(socket);
    else if (testPublic) { socket.emit('initial_test_jeepneys', testJeepneys); socket.emit('initial_test_passengers', testPassengers); }

    const on = (event, handler) => socket.on(event, (...args) => {
        try { handler(...args); } catch (e) { console.error(`[socket:${event}]`, e); }
    });
    const pingLimiter = makeLimiter(1, 5000);

    // ---- auth helpers for pages that cannot set handshake auth ----
    on('admin_login', (token, cb) => {
        const ok = ADMIN_OPEN || safeEqual(token, ADMIN_TOKEN);
        if (ok) promoteAdmin(socket);
        if (typeof cb === 'function') cb({ ok });
    });

    on('driver_register', (data, cb) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        const authorized = !!plate && (DRIVER_OPEN || socket.data.isAdmin || safeEqual(data.key, DRIVER_KEY) || socket.data.isDriver);
        const ok = authorized && (!isTestPlate(plate) || !!testJeepneys[plate]); // test plates must exist
        if (ok) {
            socket.data.isDriver = true;
            socket.data.plate = plate;
            socket.join(`driver:${plate}`);
            if (testJeepneys[plate]) socket.emit('test_jeepney_update', testJeepneys[plate]);
            if (jeepneyStatus[plate]) socket.emit('status_update', { plate, status: jeepneyStatus[plate] });
            // deliver any passengers already waiting
            const waiting = unackedCount(plate);
            if (waiting) socket.emit('driver_alert', { plate, message: `${waiting} passenger(s) waiting for you!`, count: waiting });
            if (activePings[plate]) emitDriverPings(plate);
        }
        if (typeof cb === 'function') cb({ ok });
    });

    // lets the driver hub list test jeepneys it can drive (demo mode)
    on('driver_test_list', (data, cb) => {
        if (typeof cb !== 'function') return;
        data = data || {};
        const ok = DRIVER_OPEN || socket.data.isAdmin || socket.data.isDriver || safeEqual(data.key, DRIVER_KEY);
        cb(ok ? { ok: true, jeepneys: Object.values(testJeepneys).map(t => ({ plate: t.plate, route: t.route })) } : { ok: false });
    });

    // ---- driver events ----
    on('driver_update_route', (data) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        if (!plate || !canDrive(socket, plate)) return;
        const route = cleanRoute(data.route);
        if (activeJeepneys[plate]) {
            activeJeepneys[plate].route = route;
            io.emit('jeepney_update', activeJeepneys[plate]);
        }
        if (testJeepneys[plate]) {
            testJeepneys[plate].route = route;
            emitTest('test_jeepney_update', testJeepneys[plate]);
        }
    });

    on('toggle_full', (data) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        if (!plate || !canDrive(socket, plate) || !getAnyJeepney(plate, socket)) return;
        const s = ensureStatus(plate);
        s.manualFull = Boolean(data.isFull);   // driver's choice is never overridden by passenger taps
        recomputeFull(s);
        broadcastStatus(plate);
    });

    on('driver_set_count', (data) => { // lets the driver correct drift in the passenger count
        data = data || {};
        const plate = normalizePlate(data.plate);
        const n = Math.round(Number(data.count));
        if (!plate || !Number.isFinite(n) || !canDrive(socket, plate) || !getAnyJeepney(plate, socket)) return;
        const s = ensureStatus(plate);
        s.count = Math.min(Math.max(n, 0), s.max);
        recomputeFull(s);
        broadcastStatus(plate);
    });

    on('driver_acknowledge', (data) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        if (!plate || !canDrive(socket, plate)) return;
        const pings = activePings[plate];
        if (!pings) return;
        for (const [key, p] of pings) {
            if (p.ack) continue; // already acknowledged earlier
            p.ack = true;        // keep the ping: the driver still needs the passenger's location
            if (p.testId) io.to('admin').emit('test_ping_acknowledged', { plate, id: p.testId });
            else io.to(key).emit('ping_acknowledged', { plate });
        }
        io.to(`driver:${plate}`).emit('alert_cleared', { plate });
        if (isTestPlate(plate)) io.to('admin').emit('alert_cleared', { plate });
        emitDriverPings(plate);
    });

    // ---- passenger events ----
    on('passenger_board', (data) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        if (!plate || !getAnyJeepney(plate, socket)) return;
        if (socket.data.boardedPlate === plate) return;       // ignore double taps
        if (socket.data.boardedPlate) releaseSeat(socket);    // moved to another jeepney
        const s = ensureStatus(plate);
        if (s.count >= s.max) {
            socket.emit('board_rejected', { plate, reason: 'full' });
            return;
        }
        // a passenger who boards no longer needs any ping they had open
        for (const pl of Object.keys(activePings)) {
            if (activePings[pl].has(socket.id)) emitPingCancelled(pl, dropPing(pl, socket.id));
        }
        s.count += 1;
        socket.data.boardedPlate = plate;
        recomputeFull(s);
        broadcastStatus(plate);
    });

    on('passenger_disembark', (data) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        if (plate && socket.data.boardedPlate === plate) releaseSeat(socket);
    });

    on('passenger_ping', (data) => {
        data = data || {};
        if (!pingLimiter(socket.id)) return socket.emit('ping_sent', { error: 'Please wait a few seconds before pinging again.' });

        const plate = normalizePlate(data.plate);
        const passLat = Number(data.passLat);
        const passLon = Number(data.passLon);
        if (!validCoords(passLat, passLon)) return socket.emit('ping_sent', { error: 'Could not read your location. Please enable GPS.' });

        const jeep = getAnyJeepney(plate, socket);
        if (!jeep) return socket.emit('ping_sent', { error: 'Jeepney no longer active.' });
        if (jeepneyStatus[plate]?.isFull) return socket.emit('ping_sent', { error: 'This jeepney is already full.' });

        const dist = getDistance(jeep.lat, jeep.lon, passLat, passLon);
        if (dist > MAX_PING_DISTANCE_M) {
            return socket.emit('ping_sent', { error: `This jeepney is still ${Math.round(dist)} m away. Ping again when it is closer.` });
        }

        if (!activePings[plate]) activePings[plate] = new Map();
        activePings[plate].set(socket.id, { passLat, passLon, at: Date.now(), ack: false });
        const waiting = unackedCount(plate);

        const reachable = alertDriver(plate, {
            plate,
            count: waiting,
            message: `Passenger waiting ${Math.round(dist)} meters away!` + (waiting > 1 ? ` (${waiting} passengers waiting)` : '')
        });
        emitDriverPings(plate);
        io.to('admin').emit('admin_route_to_passenger', { plate, passLat, passLon });
        socket.emit('ping_sent', { plate, distance: dist, driverOnline: reachable });
    });

    on('passenger_cancel_ping', (data) => {
        data = data || {};
        const plate = normalizePlate(data.plate);
        if (!plate || !activePings[plate]?.has(socket.id)) return;
        const remaining = dropPing(plate, socket.id);
        emitPingCancelled(plate, remaining);
    });

    // ---- admin events ----
    const adminOnly = (event, handler) => on(event, (...args) => { if (socket.data.isAdmin) handler(...args); });

    adminOnly('admin_place_test_jeepney', (data) => {
        data = data || {};
        const lat = Number(data.lat), lon = Number(data.lon);
        if (!validCoords(lat, lon)) return;
        const plate = `TEST-${++testSeq}`;
        testJeepneys[plate] = { plate, route: cleanRoute(data.route), lat, lon };
        ensureStatus(plate);
        emitTest('test_jeepney_update', testJeepneys[plate]);
        broadcastStatus(plate);
    });

    adminOnly('admin_move_test_jeepney', (data) => {
        data = data || {};
        const plate = String(data.plate || '');
        const lat = Number(data.lat), lon = Number(data.lon);
        if (!testJeepneys[plate] || !validCoords(lat, lon)) return;
        testJeepneys[plate].lat = lat;
        testJeepneys[plate].lon = lon;
        emitTest('test_jeepney_update', testJeepneys[plate]);
        carryPassengers(plate, lat, lon);
    });

    adminOnly('admin_delete_test_jeepney', (plate) => {
        plate = String(plate || '');
        if (!testJeepneys[plate]) return;
        detachFromJeepney(plate);
        delete testJeepneys[plate];
        delete jeepneyStatus[plate];
        delete activePings[plate];
        emitDriverPings(plate);
        emitTest('test_jeepney_deleted', plate);
    });

    adminOnly('admin_place_test_passenger', (data) => {
        data = data || {};
        const lat = Number(data.lat), lon = Number(data.lon);
        if (!validCoords(lat, lon)) return;
        const id = `PASS-${++testSeq}`;
        testPassengers[id] = { id, lat, lon, boarded: null, pingPlate: null };
        pushTestPassenger(testPassengers[id]);
    });

    adminOnly('admin_move_test_passenger', (data) => {
        data = data || {};
        const id = String(data.id || '');
        const lat = Number(data.lat), lon = Number(data.lon);
        const p = testPassengers[id];
        if (!p || p.boarded || !validCoords(lat, lon)) return;
        p.lat = lat; p.lon = lon;
        const ping = p.pingPlate && activePings[p.pingPlate]?.get(`test:${id}`);
        if (ping) { ping.passLat = lat; ping.passLon = lon; emitDriverPings(p.pingPlate); } // driver line follows the moved passenger
        pushTestPassenger(p);
    });

    adminOnly('admin_delete_test_passenger', (id) => {
        id = String(id || '');
        if (!testPassengers[id]) return;
        cancelTestPing(id);
        releaseTestSeat(id);
        delete testPassengers[id];
        emitTest('test_passenger_deleted', id);
    });

    // test passenger pings a jeepney, exactly like a real commuter would
    adminOnly('admin_test_ping', (data) => {
        data = data || {};
        const id = String(data.id || '');
        const plate = normalizePlate(data.plate);
        const p = testPassengers[id];
        if (!p) return;
        const reply = (extra) => socket.emit('test_ping_result', { id, plate, ...extra });

        if (p.boarded) return reply({ error: `${id} is already riding ${p.boarded}.` });
        const jeep = getAnyJeepney(plate, socket);
        if (!jeep) return reply({ error: 'Jeepney no longer active.' });
        if (jeepneyStatus[plate]?.isFull) return reply({ error: 'This jeepney is already full.' });

        const dist = getDistance(jeep.lat, jeep.lon, p.lat, p.lon);
        if (dist > MAX_PING_DISTANCE_M) return reply({ error: `This jeepney is still ${Math.round(dist)} m away. Move one closer.` });

        cancelTestPing(id); // one active ping per passenger
        if (!activePings[plate]) activePings[plate] = new Map();
        activePings[plate].set(`test:${id}`, { passLat: p.lat, passLon: p.lon, at: Date.now(), ack: false, testId: id });
        p.pingPlate = plate;
        pushTestPassenger(p);
        const waiting = unackedCount(plate);

        const reachable = alertDriver(plate, {
            plate,
            count: waiting,
            message: `Passenger waiting ${Math.round(dist)} meters away!` + (waiting > 1 ? ` (${waiting} passengers waiting)` : '')
        });
        emitDriverPings(plate);
        io.to('admin').emit('admin_route_to_passenger', { plate, passLat: p.lat, passLon: p.lon, passengerId: id });
        reply({ ok: true, distance: dist, driverOnline: reachable });
    });

    adminOnly('admin_test_cancel_ping', (data) => { cancelTestPing(String((data || {}).id || '')); });

    adminOnly('admin_test_board', (data) => {
        data = data || {};
        const id = String(data.id || '');
        const plate = normalizePlate(data.plate);
        const p = testPassengers[id];
        if (!p) return;
        const reply = (extra) => socket.emit('test_ping_result', { id, plate, ...extra });
        if (!getAnyJeepney(plate, socket)) return reply({ error: 'Jeepney no longer active.' });
        if (p.boarded === plate) return;
        const s = ensureStatus(plate);
        if (s.count >= s.max) return reply({ error: `${plate} is full.` });
        releaseTestSeat(id);   // moving between jeepneys
        cancelTestPing(id);
        s.count += 1;
        p.boarded = plate;
        recomputeFull(s);
        broadcastStatus(plate);
        const j = getAnyJeepney(plate, socket);
        p.lat = j.lat; p.lon = j.lon;
        pushTestPassenger(p);
    });

    adminOnly('admin_test_disembark', (data) => { releaseTestSeat(String((data || {}).id || '')); });

    // flip whether commuters can see test jeepneys (turn on for a live demo, off afterwards)
    adminOnly('admin_set_public_test', (value) => {
        testPublic = Boolean(value);
        io.to('admin').emit('test_public_state', testPublic);
        if (testPublic) {
            io.except('admin').emit('initial_test_jeepneys', testJeepneys);
            io.except('admin').emit('initial_test_passengers', testPassengers);
        } else {
            io.except('admin').emit('clear_all_test_objects');
        }
    });

    adminOnly('admin_clear_all', () => {
        for (const id of Object.keys(testPassengers)) { cancelTestPing(id); releaseTestSeat(id); }
        for (const plate of Object.keys(testJeepneys)) {
            io.to(`driver:${plate}`).emit('test_jeepney_deleted', plate);
            delete jeepneyStatus[plate]; delete activePings[plate];
            emitDriverPings(plate);
        }
        testJeepneys = {};
        testPassengers = {};
        emitTest('clear_all_test_objects');
    });

    // ---- cleanup when a phone closes, loses signal, or switches tabs ----
    socket.on('disconnect', () => {
        try {
            releaseSeat(socket); // otherwise a vanished passenger keeps a seat taken forever
            for (const plate of Object.keys(activePings)) {
                if (activePings[plate].has(socket.id)) {
                    const remaining = dropPing(plate, socket.id);
                    emitPingCancelled(plate, remaining);
                }
            }
        } catch (e) { console.error('[disconnect]', e); }
    });
});

// ==================== PERIODIC CLEANUP ====================
const sweeper = setInterval(() => {
    const now = Date.now();

    // jeepneys that stopped reporting (driver went offline, phone died, app closed)
    for (const plate of Object.keys(activeJeepneys)) {
        if (now - (activeJeepneys[plate].lastSeen || 0) > STALE_JEEPNEY_MS) {
            delete activeJeepneys[plate];
            delete jeepneyStatus[plate];
            detachFromJeepney(plate);
            for (const [key, p] of (activePings[plate] || [])) notifyPingEnd(plate, key, p, 'offline');
            delete activePings[plate];
            emitDriverPings(plate);
            io.emit('jeepney_removed', plate);
        }
    }

    // pings nobody answered
    for (const plate of Object.keys(activePings)) {
        let removed = false;
        for (const [key, p] of activePings[plate]) {
            if (now - p.at > PING_TTL_MS) {
                notifyPingEnd(plate, key, p, 'timeout');
                activePings[plate].delete(key);
                removed = true;
            }
        }
        if (activePings[plate].size === 0) delete activePings[plate];
        if (removed) {
            const remaining = unackedCount(plate);
            io.to(`driver:${plate}`).emit('ping_cancelled', { plate, remaining });
            if (isTestPlate(plate)) io.to('admin').emit('ping_cancelled', { plate, remaining });
            emitDriverPings(plate);
        }
    }
}, 15 * 1000);
sweeper.unref();

// ==================== START / SHUTDOWN ====================
server.listen(PORT, '0.0.0.0', () => console.log('Server running on port ' + PORT));

function shutdown() {
    console.log('Shutting down...');
    clearInterval(sweeper);
    io.close(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
