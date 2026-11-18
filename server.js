require('dotenv').config();
const express = require('express');
const http = require('http');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== AI SETUP ====================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/ask-ai', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: "Message required" });

        const response = await ai.models.generateContent({
            model: "gemini-1.5-flash", 
            contents: userMessage,
        });
        res.json({ reply: response.text });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "AI failed to respond" });
    }
});

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// SECRET ADMIN ROUTE
app.get('/admin-secret-2026', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==================== ESP32 & JEEPNEY DATA ====================
let activeJeepneys = {};

// Receives data from ESP32
app.post('/api/update', (req, res) => {
    const { route, lat, lon } = req.body;
    activeJeepneys[route] = { route, lat, lon, lastSeen: Date.now() };
    io.emit('jeepney_update', activeJeepneys[route]);
    res.status(200).send("OK");
});

// Cleanup inactive jeepneys
setInterval(() => {
    const now = Date.now();
    for (let route in activeJeepneys) {
        if (now - activeJeepneys[route].lastSeen > 30000) {
            delete activeJeepneys[route];
            io.emit('jeepney_lost', route);
        }
    }
}, 10000);

// ==================== ADMIN TEST JEEPNEY ====================
let testInterval = null;
const TEST_ROUTE_ID = "TEST-JEEP";

app.post('/api/admin/summon-test', (req, res) => {
    if (testInterval) clearInterval(testInterval);

    let lat = 6.9273;
    let lon = 122.0588;

    const firstPayload = { route: TEST_ROUTE_ID, lat: lat, lon: lon, lastSeen: Date.now() };
    activeJeepneys[TEST_ROUTE_ID] = firstPayload;
    io.emit('jeepney_update', firstPayload);

    testInterval = setInterval(() => {
        lat += (Math.random() - 0.5) * 0.0002;
        lon += (Math.random() - 0.5) * 0.0002;

        const payload = { route: TEST_ROUTE_ID, lat: lat, lon: lon, lastSeen: Date.now() };
        activeJeepneys[TEST_ROUTE_ID] = payload;
        io.emit('jeepney_update', payload);
    }, 3000);

    res.json({ status: 'success', lat: lat, lon: lon });
});

app.post('/api/admin/stop-test', (req, res) => {
    if (testInterval) clearInterval(testInterval);
    delete activeJeepneys[TEST_ROUTE_ID];
    io.emit('jeepney_lost', TEST_ROUTE_ID);
    res.json({ status: 'stopped' });
});

// ==================== ESP32 SERIAL BRIDGE ====================
// Wrapped in try/catch so Render doesn't crash when the ESP32 isn't plugged in
try {
    const port = new SerialPort({ path: 'COM3', baudRate: 115200 }); 
    port.on('error', (err) => console.log("Serial Port Error:", err.message));
    
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (data) => {
        const line = data.trim();
        if (line.startsWith("SCAN:")) io.emit('scan', line.replace("SCAN:", ""));
        else if (line.startsWith("BOARD:")) {
            const parts = line.replace("BOARD:", "").split(",");
            if (parts.length >= 3) io.emit('board', { uid: parts[0], lat: parseFloat(parts[1]), lon: parseFloat(parts[2]) });
        } 
        else if (line.startsWith("DEPART:")) {
            const parts = line.replace("DEPART:", "").split(",");
            if (parts.length >= 5) io.emit('depart', { uid: parts[0], lat: parseFloat(parts[1]), lon: parseFloat(parts[2]), dist: parts[3], fare: parts[4] });
        }
    });
} catch (err) {
    console.log("No ESP32 connected via USB. Web app will run without hardware.");
}

// ==================== START SERVER ====================
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log("=========================================");
    console.log("Website running on port " + PORT);
    console.log("=========================================");
});
