// =====================================================================================
// server.js PATCH: faster route loading + live progress.  (This file is NOT run itself.)
// Four small edits. Nothing else in server.js changes.
// =====================================================================================


// -------------------------------------------------------------------------------------
// EDIT 1 of 4
// In server.js, find the block that starts at   const GEO_CACHE_FILE = ...
// and ends at the line                          buildRoutePaths().catch(e => console.error('[routes]', e));
// DELETE that whole block and PASTE this in its place.
// (projectOnPath(...) right below it stays exactly as it is.)
// -------------------------------------------------------------------------------------

// Where looked-up stop coordinates are remembered. Point GEO_CACHE_FILE at a persistent disk if your host
// wipes files on restart. geocache.seed.json (optional, committed to git) is loaded first, so a fresh
// deploy starts with every stop already known and routes are ready instantly.
const GEO_CACHE_FILE = process.env.GEO_CACHE_FILE || path.join(__dirname, '.geocache.json');
const GEO_SEED_FILE = path.join(__dirname, 'geocache.seed.json');
let geoCache = {};
for (const f of [GEO_SEED_FILE, GEO_CACHE_FILE]) {
    try { Object.assign(geoCache, JSON.parse(fs.readFileSync(f, 'utf8')) || {}); } catch { /* not there yet */ }
}
let routesReady = false;
const routePaths = {}; // id -> { path: [[lat, lon], ...], names: [stop names in path order, anchor excluded] }

// progress that the passenger page turns into a loading bar
const routeProgress = { done: 0, total: 0, missing: 0, routesReady: 0, routesTotal: ROUTE_CATALOG.length, finished: false };
function getProgress() {
    const pct = routeProgress.total ? Math.round(routeProgress.done / routeProgress.total * 100) : 0;
    return { ...routeProgress, percent: Math.min(100, pct) };
}
const emitProgress = () => io.emit('routes_progress', getProgress());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function saveGeoCache() { try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache)); } catch { /* read-only disk is fine */ } }

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

// Rebuild every route line from the stops known so far. Cheap (about 50 tiny routes), so it runs after
// each new stop: routes become usable one by one instead of all-or-nothing at the very end.
function rebuildRoutes() {
    const anchor = geoCache[ROUTE_ANCHOR];
    let ready = 0;
    for (const r of ROUTE_CATALOG) {
        const entries = r.stops.filter(s => geoCache[s]).map(s => ({ name: s, lat: geoCache[s].lat, lon: geoCache[s].lon }));
        if (anchor) entries.sort((a, b) => getDistance(anchor.lat, anchor.lon, a.lat, a.lon) - getDistance(anchor.lat, anchor.lon, b.lat, b.lon));
        const pts = entries.map(e => [e.lat, e.lon]);
        const pathPts = anchor ? [[anchor.lat, anchor.lon], ...pts] : pts;
        if (pathPts.length >= 2) { routePaths[r.id] = { path: pathPts, names: entries.map(e => e.name) }; ready += 1; }
        else delete routePaths[r.id];
    }
    routesReady = ready > 0;
    routeProgress.routesReady = ready;
}

async function buildRoutePaths() {
    const names = [...new Set([ROUTE_ANCHOR, ...ROUTE_CATALOG.flatMap(r => r.stops)])]; // anchor first
    const quiet = routeProgress.finished;            // a later retry should not bring the loading bar back
    const todo = names.filter(n => !geoCache[n]);

    rebuildRoutes();                                  // everything already remembered is usable right now
    if (!quiet) {
        routeProgress.total = names.length;
        routeProgress.done = names.length - todo.length;
        routeProgress.missing = 0;
        emitProgress();
    }

    let unsaved = 0, missing = 0;
    for (const n of todo) {
        const g = await geocodeStop(n);
        if (g) { unsaved += 1; rebuildRoutes(); } else missing += 1;
        if (!quiet) { routeProgress.done += 1; routeProgress.missing = missing; emitProgress(); }
        if (unsaved >= 5) { saveGeoCache(); unsaved = 0; } // keep progress even if the server restarts mid-way
        await sleep(1100);                                  // Nominatim allows ~1 request/second
    }
    if (unsaved) saveGeoCache();

    routeProgress.missing = missing;
    routeProgress.finished = true;
    emitProgress();
    console.log(`[routes] ${routeProgress.routesReady}/${ROUTE_CATALOG.length} routes ready` + (missing ? `, ${missing} stop(s) could not be located` : ''));
    if (todo.length && !missing && !fs.existsSync(GEO_SEED_FILE)) {
        console.log('[routes] Tip: copy .geocache.json to geocache.seed.json and commit it. New deploys will then load routes instantly.');
    }
    if (missing) setTimeout(() => buildRoutePaths().catch(e => console.error('[routes]', e)), 10 * 60 * 1000).unref(); // retry later, quietly
}
buildRoutePaths().catch(e => console.error('[routes]', e));


// -------------------------------------------------------------------------------------
// EDIT 2 of 4
// Replace the existing /api/routes handler with this one.
// -------------------------------------------------------------------------------------
app.get('/api/routes', (req, res) => {
    res.json({ ready: routesReady, progress: getProgress(), allowCustom: true, routes: ROUTE_CATALOG.map(r => ({ id: r.id, stops: r.stops })) });
});


// -------------------------------------------------------------------------------------
// EDIT 3 of 4
// In app.post('/api/plan', ...) replace the single line
//     if (!routesReady) return res.status(503).json({ error: 'Route data is still loading. Try again in a minute.' });
// with:
// -------------------------------------------------------------------------------------
    if (!routesReady) return res.status(503).json({ error: `Route data is still loading (${getProgress().percent}%). Try again in a moment.`, progress: getProgress() });

// ...and in the same handler, change the last line from
//     res.json({ routes: matches.slice(0, 5), servesDestination: ..., servesOrigin: ... });
// to also include the progress (so the page can warn that results may be incomplete while loading):
    res.json({ routes: matches.slice(0, 5), servesDestination: servesDestination.slice(0, 4), servesOrigin: servesOrigin.slice(0, 4), loading: !routeProgress.finished, progress: getProgress() });


// -------------------------------------------------------------------------------------
// EDIT 4 of 4  (two one-line changes)
//
// (a) In io.on('connection', ...), right after the line  socket.emit('initial_status', jeepneyStatus);
//     add:
// -------------------------------------------------------------------------------------
    socket.emit('routes_progress', getProgress());

// (b) Keep the seed file from being downloadable: add "geocache" to the BLOCKED regex, i.e. change
//       const BLOCKED = /^\/(server\.js|package(-lock)?\.json|node_modules|admin\.html|render\.yaml|dockerfile)/;
//     to:
//       const BLOCKED = /^\/(server\.js|package(-lock)?\.json|node_modules|admin\.html|render\.yaml|dockerfile|geocache)/;
