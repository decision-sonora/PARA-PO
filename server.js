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

        const systemPrompt = `You are PARA-PO Bot, a helpful assistant for jeepney commuters in Zamboanga City. Keep answers short and friendly. 
        
        RULES:
        1. DO NOT use markdown formatting (no asterisks like **, no hashtags, no bold). Use plain text only.
        2. Use these Zamboanga City locations as your geographic reference: Ayala, San Jose Gusu, Sinnunuc, Tetuan, Canelar, Guiwan, Tumaga, Putik, Divisoria, Sta. Maria, Sta. Barbara, Baliwasan, San Roque, Calarian, Cawit, Recodo, Talisayan, Pasonanca.
        3. If asked for a distance between two places, estimate it based on real-world geography of these locations.
        
        Fare Rules:
        - Traditional Jeepneys: Minimum fare is PHP 14 for the first four kilometers, with an additional PHP 2 for every succeeding kilometer.
        - Modern Jeepneys: Minimum fare is PHP 17 for the first four kilometers, with an additional PHP 2.40 for every succeeding kilometer.`;

        const completion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b", 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
        });

        let aiReply = completion.choices[0].message.content.replace(/\*\*/g, '');
        res.json({ reply: aiReply });
    } catch (error) {
        res.status(500).json({ error: "AI Error: " + error.message }); 
    }
});

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/driver', (req, res) => res.sendFile(path.join(__dirname, 'driver.html')));
app.get('/admin-secret-2026', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ==================== REAL-TIME DATA ====================
let activeJeepneys = {}; 
let testJeepneys = {}; 
let testPassengers = {}; 

app.post('/api/update', (req, res) => {
    const data = req.body;
    activeJeepneys[data.plate] = data;
    io.emit('jeepney_update', data);
    res.status(200).send("OK");
});

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

io.on('connection', (socket) => {
    socket.emit('initial_jeepneys', activeJeepneys);
    socket.emit('initial_test_jeepneys', testJeepneys);
    socket.emit('initial_test_passengers', testPassengers);

    // --- PASSENGER: Broadcast Location ---
    socket.on('passenger_location_update', (data) => {
        io.emit('passenger_location_update', { lat: data.lat, lon: data.lon });
    });

    // --- DRIVER: Update Route ---
    socket.on('driver_update_route', (data) => {
        const plate = data.plate;
        const newRoute = data.route;

        if (activeJeepneys[plate]) {
            activeJeepneys[plate].route = newRoute;
            io.emit('jeepney_update', activeJeepneys[plate]);
        }
        if (testJeepneys[plate]) {
            testJeepneys[plate].route = newRoute;
            io.emit('test_jeepney_update', testJeepneys[plate]);
        }
    });

    // --- ADMIN: Place Test Jeepney ---
    socket.on('admin_place_test_jeepney', (data) => {
        const plate = "TEST-" + Math.floor(Math.random() * 1000);
        testJeepneys[plate] = { plate: plate, route: data.route, lat: data.lat, lon: data.lon };
        io.emit('test_jeepney_update', testJeepneys[plate]);
    });

    socket.on('admin_move_test_jeepney', (data) => {
        if (testJeepneys[data.plate]) {
            testJeepneys[data.plate].lat = data.lat;
            testJeepneys[data.plate].lon = data.lon;
            io.emit('test_jeepney_update', testJeepneys[data.plate]);
        }
    });

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

    socket.on('admin_delete_test_passenger', (id) => {
        delete testPassengers[id];
        io.emit('test_passenger_deleted', id);
    });

    socket.on('admin_clear_all', () => {
        testJeepneys = {};
        testPassengers = {};
        io.emit('clear_all_test_objects');
    });

    // --- PASSENGER: Ping Specific Driver (FIXED) ---
    socket.on('passenger_ping', (data) => {
        const requestedPlate = data.plate; // The exact jeepney the passenger clicked
        const allJeeps = { ...activeJeepneys, ...testJeepneys };
        
        if (allJeeps[requestedPlate]) {
            const targetJeep = allJeeps[requestedPlate];
            // Calculate distance between passenger and the EXACT jeepney they selected
            const dist = getDistance(targetJeep.lat, targetJeep.lon, data.passLat, data.passLon);
            
            // Only alert the specific driver
            io.emit('driver_alert', { 
                plate: requestedPlate, 
                message: `Passenger waiting ${Math.round(dist)} meters away!` 
            });
            socket.emit('ping_sent', { plate: requestedPlate, distance: dist });
        } else {
            socket.emit('ping_sent', { error: "That jeepney is no longer active." });
        }
    });

    socket.on('driver_acknowledge', (data) => {
        io.emit('ping_acknowledged', { plate: data.plate });
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Server running on port " + PORT));
