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
        2. If asked about a location, use the database below.
        3. If asked for a distance, use the verified distance matrix below to answer accurately. Do not guess.
        
        ZAMBOANGA CITY LANDMARK DATABASE:
        Malls: KCC Mall de Zamboanga, SM City Mindpro, City Mall Tetuan, Southway Square, Canelar Barter Trade.
        Tourist Spots: Fort Pilar, Pasonanca Park, Paseo del Mar, R.T. Lim Boulevard, Cawa-Cawa Boulevard, Sta. Cruz Island, Taluksangay Mosque, Plaza Pershing, Metropolitan Cathedral.
        Schools: Western Mindanao State University (WMSU), Ateneo de Zamboanga University (ADZU), Universidad de Zamboanga (UZ), Zamboanga State College of Marine Sciences and Technology (ZSCMST), Don Pablo Lorenzo Memorial High School.
        Hospitals: Zamboanga City Medical Center (ZCMC), Brent Hospital, Mindanao Central Sanitarium, Zamboanga Doctors Hospital.
        Transport: Zamboanga International Airport, Integrated Bus Terminal (Canelar).
        Roads: Governor Camins Avenue, Maria Clara Lobregat Highway, Veterans Avenue, La Purisima Street, Nuñez Extension, Airport Road.
        Barangays: Ayala, San Jose Gusu, Sinnunuc, Tetuan, Canelar, Guiwan, Tumaga, Putik, Divisoria, Sta. Maria, Sta. Barbara, Baliwasan, San Roque, Calarian, Cawit, Recodo, Talisayan, Pasonanca, Mercedes, Sta. Catalina, San Jose Cawa-Cawa.
        
        VERIFIED DRIVING DISTANCE MATRIX (From KCC Mall):
        - Ayala to KCC Mall: 16.0 km
        - Zamboanga International Airport to KCC Mall: 3.7 km
        - WMSU to KCC Mall: 3.2 km
        - Fort Pilar to KCC Mall: 1.4 km
        - SM City Mindpro to KCC Mall: 0.5 km
        
        Fare Rules:
        - Traditional Jeepneys: Minimum PHP 14 for first 4km, +PHP 2 per succeeding km.
        - Modern Jeepneys: Minimum PHP 17 for first 4km, +PHP 2.40 per succeeding km.`;

        const completion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b", 
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
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
let jeepneyStatus = {}; 
let activePings = {}; 

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
    socket.emit('initial_status', jeepneyStatus);

    socket.on('driver_update_route', (data) => {
        if (activeJeepneys[data.plate]) {
            activeJeepneys[data.plate].route = data.route;
            io.emit('jeepney_update', activeJeepneys[data.plate]);
        }
        if (testJeepneys[data.plate]) {
            testJeepneys[data.plate].route = data.route;
            io.emit('test_jeepney_update', testJeepneys[data.plate]);
        }
    });

    socket.on('toggle_full', (data) => {
        if (jeepneyStatus[data.plate]) {
            jeepneyStatus[data.plate].isFull = data.isFull;
            io.emit('status_update', { plate: data.plate, status: jeepneyStatus[data.plate] });
        }
    });

    socket.on('passenger_board', (data) => {
        if (!jeepneyStatus[data.plate]) jeepneyStatus[data.plate] = { count: 0, max: 20, isFull: false };
        if (jeepneyStatus[data.plate].count < jeepneyStatus[data.plate].max) jeepneyStatus[data.plate].count += 1;
        if (jeepneyStatus[data.plate].count >= jeepneyStatus[data.plate].max) jeepneyStatus[data.plate].isFull = true;
        io.emit('status_update', { plate: data.plate, status: jeepneyStatus[data.plate] });
    });

    socket.on('passenger_disembark', (data) => {
        if (jeepneyStatus[data.plate]) {
            if (jeepneyStatus[data.plate].count > 0) jeepneyStatus[data.plate].count -= 1;
            if (jeepneyStatus[data.plate].count < jeepneyStatus[data.plate].max) jeepneyStatus[data.plate].isFull = false;
            io.emit('status_update', { plate: data.plate, status: jeepneyStatus[data.plate] });
        }
    });

    socket.on('admin_place_test_jeepney', (data) => {
        const plate = "TEST-" + Math.floor(Math.random() * 1000);
        testJeepneys[plate] = { plate: plate, route: data.route, lat: data.lat, lon: data.lon };
        if (!jeepneyStatus[plate]) jeepneyStatus[plate] = { count: 0, max: 20, isFull: false };
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
        delete testJeepneys[plate]; delete jeepneyStatus[plate];
        io.emit('test_jeepney_deleted', plate);
    });

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
        testJeepneys = {}; testPassengers = {};
        io.emit('clear_all_test_objects');
    });

    socket.on('passenger_ping', (data) => {
        const requestedPlate = data.plate; 
        const allJeeps = { ...activeJeepneys, ...testJeepneys };
        
        if (allJeeps[requestedPlate]) {
            const targetJeep = allJeeps[requestedPlate];
            const dist = getDistance(targetJeep.lat, targetJeep.lon, data.passLat, data.passLon);
            
            activePings[requestedPlate] = { socketId: socket.id, passLat: data.passLat, passLon: data.passLon };
            
            io.emit('driver_alert', { plate: requestedPlate, message: `Passenger waiting ${Math.round(dist)} meters away!` });
            io.emit('admin_route_to_passenger', { plate: requestedPlate, passLat: data.passLat, passLon: data.passLon });
            socket.emit('ping_sent', { plate: requestedPlate, distance: dist });
        } else {
            socket.emit('ping_sent', { error: "Jeepney no longer active." });
        }
    });

    socket.on('driver_acknowledge', (data) => {
        const ping = activePings[data.plate];
        if (ping) {
            io.to(ping.socketId).emit('ping_acknowledged', { plate: data.plate });
            delete activePings[data.plate];
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Server running on port " + PORT));
