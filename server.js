require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==================== GROQ AI SETUP ====================
const groq = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY || 'missing-key'
});

app.post('/api/ask-ai', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: "Message required" });
        if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY missing in Render." });

        const systemPrompt = "You are PARA-PO Bot, a helpful assistant for jeepney commuters in Zamboanga City. Keep answers short and friendly. Base fare is PHP 13 + PHP 15/km. Popular routes: Ayala, Sinnunuc.";

        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile", // Free, fast model on Groq
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
        });

        res.json({ reply: completion.choices[0].message.content });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "AI Error: " + error.message }); 
    }
});

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));
app.get('/admin-secret-2026', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ==================== REAL-TIME DATA ====================
let activeJeepneys = {}; 
let testJeepneys = {}; // Track admin test vehicles separately
let testPassengers = {}; // Track admin test passengers

// ESP32 sends data here
app.post('/api/update', (req, res) => {
    const data = req.body;
    activeJeepneys[data.plate] = data;
    io.emit('jeepney_update', data);
    res.status(200).send("OK");
});

// Haversine helper
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

io.on('connection', (socket) => {
    // Send initial data
    socket.emit('initial_jeepneys', activeJeepneys);
    socket.emit('initial_test_jeepneys', testJeepneys);
    socket.emit('initial_test_passengers', testPassengers);

    // --- ADMIN: Place Test Jeepney ---
    socket.on('admin_place_test_jeepney', (data) => {
        const plate = "TEST-" + Math.floor(Math.random() * 1000);
        testJeepneys[plate] = { plate: plate, route: data.route, lat: data.lat, lon: data.lon };
        io.emit('test_jeepney_update', testJeepneys[plate]);
    });

    // --- ADMIN: Move Test Jeepney ---
    socket.on('admin_move_test_jeepney', (data) => {
        if (testJeepneys[data.plate]) {
            testJeepneys[data.plate].lat = data.lat;
            testJeepneys[data.plate].lon = data.lon;
            io.emit('test_jeepney_update', testJeepneys[data.plate]);
        }
    });

    // --- ADMIN: Delete Test Jeepney ---
    socket.on('admin_delete_test_jeepney', (plate) => {
        delete testJeepneys[plate];
        io.emit('test_jeepney_deleted', plate);
    });

    // --- ADMIN: Place Test Passenger ---
    socket.on('admin_place_test_passenger', (data) => {
        const id = "PASS-" + Math.floor(Math.random() * 1000);
        testPassengers[id] = { id: id, lat: data.lat, lon: data.lon };
        io.emit('test_passenger_update', testPassengers[id]);
    });

    // --- ADMIN: Delete Test Passenger ---
    socket.on('admin_delete_test_passenger', (id) => {
        delete testPassengers[id];
        io.emit('test_passenger_deleted', id);
    });

    // --- ADMIN: Clear All ---
    socket.on('admin_clear_all', () => {
        testJeepneys = {};
        testPassengers = {};
        io.emit('clear_all_test_objects');
    });

    // --- PASSENGER: Ping Driver ---
    socket.on('passenger_ping', (data) => {
        let closestJeep = null;
        let minDistance = Infinity;

        // Check both real and test jeepneys
        const allJeeps = { ...activeJeepneys, ...testJeepneys };
        for (let plate in allJeeps) {
            const jeep = allJeeps[plate];
            const dist = getDistance(jeep.lat, jeep.lon, data.passLat, data.passLon);
            if (dist < minDistance) {
                minDistance = dist;
                closestJeep = jeep;
            }
        }

        if (closestJeep) {
            io.emit('driver_alert', { 
                plate: closestJeep.plate, 
                message: `Passenger waiting ${Math.round(minDistance)} meters away!` 
            });
            socket.emit('ping_sent', { plate: closestJeep.plate, distance: minDistance });
        } else {
            socket.emit('ping_sent', { error: "No jeepneys active nearby." });
        }
    });

    // --- DRIVER: Acknowledge ---
    socket.on('driver_acknowledge', (data) => {
        io.emit('ping_acknowledged', { plate: data.plate });
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Server running on port " + PORT));
