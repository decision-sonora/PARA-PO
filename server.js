require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== AI SETUP ====================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/ask-ai', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: "Message required" });
        if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY missing in Render." });

        const systemPrompt = "You are PARA-PO Bot, a helpful assistant for jeepney commuters in Zamboanga City. Keep answers short and friendly. Base fare is PHP 13 + PHP 15/km. Popular routes: Ayala, Sinnunuc. If asked unrelated topics, steer back to commuting.";

        const response = await ai.models.generateContent({
            model: "gemini-1.5-flash", 
            contents: [{ role: 'user', parts: [{ text: systemPrompt + "\n\nUser: " + userMessage }] }]
        });
        res.json({ reply: response.text });
    } catch (error) {
        res.status(500).json({ error: "AI Error: " + error.message }); 
    }
});

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));
app.get('/admin-secret-2026', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ==================== REAL-TIME DATA & DRIFT FILTER ====================
let activeJeepneys = {}; // Format: { "PLATE": { route, plate, lat, lon, lastUpdate } }

// Helper: Haversine to filter GPS drift (ignore jumps > 100m in < 2 seconds)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

io.on('connection', (socket) => {
    socket.emit('initial_data', activeJeepneys);

    // ESP32 sends real data here
    socket.on('esp32_update', (data) => {
        const prev = activeJeepneys[data.plate];
        if (prev) {
            const dist = getDistance(prev.lat, prev.lon, data.lat, data.lon);
            const timeDiff = (Date.now() - prev.lastUpdate) / 1000;
            // Drift filter: If moved >100m in less than 2 seconds, ignore it.
            if (dist > 100 && timeDiff < 2) {
                console.log(`Ignored GPS Drift from ${data.plate}`);
                return; 
            }
        }
        data.lastUpdate = Date.now();
        activeJeepneys[data.plate] = data;
        io.emit('jeepney_update', data);
    });

    // Admin places Test Jeepney
    socket.on('admin_place_jeepney', (data) => {
        const plate = "TEST-" + Math.floor(Math.random()*1000);
        const jeep = { plate: plate, route: data.route, lat: data.lat, lon: data.lon, lastUpdate: Date.now() };
        activeJeepneys[plate] = jeep;
        io.emit('jeepney_update', jeep);
    });

    // Admin places Test Passenger
    socket.on('admin_place_passenger', (data) => {
        io.emit('passenger_update', { lat: data.lat, lon: data.lon });
    });

    // Passenger Pings Driver
    socket.on('passenger_ping', (data) => {
        // Send to driver dashboard
        io.emit('driver_alert', { 
            plate: data.plate, 
            message: `Passenger waiting nearby at coordinates ${data.lat.toFixed(4)}, ${data.lon.toFixed(4)}` 
        });
        // Notify passenger
        socket.emit('ping_sent', { plate: data.plate });
    });

    // Driver Acknowledges Ping
    socket.on('driver_acknowledge', (data) => {
        io.emit('ping_acknowledged', { plate: data.plate });
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Server running on port " + PORT));
