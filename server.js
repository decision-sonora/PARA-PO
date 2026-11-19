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

function buildVerifiedHint(message) {
    const text = message.toLowerCase();
    const lines = [];
    for (const d of DISTANCES_FROM_KCC) {
        if (d.aliases.some(a => new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text))) {
            lines.push(`${d.label} to KCC Mall: ${d.km} km. Traditional fare PHP ${computeFare(d.km, false)}, modern fare PHP ${computeFare(d.km, true)}.`);
        }
    }
    const m = text.match(/(\d+(?:\.\d+)?)\s*km/);
    if (m) {
        const km = Math.min(parseFloat(m[1]), 200);
        lines.push(`For ${km} km: traditional fare PHP ${computeFare(km, false)}, modern fare PHP ${computeFare(km, true)}.`);
    }
    return lines.length
        ? '\n\nSERVER-VERIFIED FIGURES FOR THIS QUESTION (use these exactly, do not recalculate):\n' + lines.join('\n')
        : '';
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
6. You do not have verified jeepney route or schedule data. If asked which jeepney to ride, say so and point to the live map and the route shown on each jeepney.
7. Students, senior citizens and persons with disabilities are entitled to a 20 percent fare discount on public transport. Mention it when relevant.

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

app.get('/health', (req, res) => res.json({ ok: true, jeepneys: Object.keys(activeJeepneys).length }));
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
let activePings = {};      // plate -> Map(key -> { passLat, passLon, at, testId? }); key = socketId, or "test:<id>" for test passengers
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

// ---- test passenger helpers (used by the admin demo console) ----
function pushTestPassenger(p) { emitTest('test_passenger_update', p); }

function emitPingCancelled(plate, remaining) {
    io.to(`driver:${plate}`).emit('ping_cancelled', { plate, remaining });
    if (isTestPlate(plate)) io.to('admin').emit('ping_cancelled', { plate, remaining }); // test jeepneys are "driven" from the admin console
}

function dropPing(plate, key) {
    const m = activePings[plate];
    if (!m) return 0;
    m.delete(key);
    if (m.size === 0) delete activePings[plate];
    return m.size;
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
            const waiting = activePings[plate]?.size || 0;
            if (waiting) socket.emit('driver_alert', { plate, message: `${waiting} passenger(s) waiting for you!`, count: waiting });
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
            if (p.testId) {
                const tp = testPassengers[p.testId];
                if (tp && tp.pingPlate === plate) { tp.pingPlate = null; pushTestPassenger(tp); }
                io.to('admin').emit('test_ping_acknowledged', { plate, id: p.testId });
            } else {
                io.to(key).emit('ping_acknowledged', { plate });
            }
        }
        delete activePings[plate];
        io.to(`driver:${plate}`).emit('alert_cleared', { plate });
        if (isTestPlate(plate)) io.to('admin').emit('alert_cleared', { plate });
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
        activePings[plate].set(socket.id, { passLat, passLon, at: Date.now() });
        const waiting = activePings[plate].size;

        const reachable = alertDriver(plate, {
            plate,
            count: waiting,
            message: `Passenger waiting ${Math.round(dist)} meters away!` + (waiting > 1 ? ` (${waiting} passengers waiting)` : '')
        });
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
        activePings[plate].set(`test:${id}`, { passLat: p.lat, passLon: p.lon, at: Date.now(), testId: id });
        p.pingPlate = plate;
        pushTestPassenger(p);
        const waiting = activePings[plate].size;

        const reachable = alertDriver(plate, {
            plate,
            count: waiting,
            message: `Passenger waiting ${Math.round(dist)} meters away!` + (waiting > 1 ? ` (${waiting} passengers waiting)` : '')
        });
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
            io.emit('jeepney_removed', plate);
        }
    }

    // pings nobody answered
    for (const plate of Object.keys(activePings)) {
        for (const [key, p] of activePings[plate]) {
            if (now - p.at > PING_TTL_MS) {
                notifyPingEnd(plate, key, p, 'timeout');
                activePings[plate].delete(key);
            }
        }
        if (activePings[plate].size === 0) delete activePings[plate];
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
