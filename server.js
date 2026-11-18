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

// ==================== DEEPSEEK AI SETUP ====================
const deepseek = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY || 'missing-key'
});

app.post('/api/ask-ai', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: "Message required" });
        if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: "DEEPSEEK_API_KEY missing in Render." });

        const systemPrompt = "You are PARA-PO Bot, a helpful assistant for jeepney commuters in Zamboanga City. Keep answers short and friendly. Base fare is PHP 13 + PHP 15/km. Popular routes: Ayala, Sinnunuc.";

        const completion = await deepseek.chat.completions.create({
            model: "deepseek-chat", 
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

// THIS IS THE ROUTE YOUR ESP32 USES TO SEND DATA
app.post('/api/update', (req, res) => {
    const data = req.body;
    activeJeepneys[data.plate] = data;
    io.emit('jeepney_update', data);
    res.status(200).send("OK");
});

// Haversine helper (for distance calculations)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

io.on('connection', (socket) => {
    socket.emit('initial_data', activeJeepneys);

    // Calculate distance when a passenger pings
    socket.on('passenger_ping', (data) => {
        let closestJeep = null;
        let minDistance = Infinity;

        for (let plate in activeJeepneys) {
            const jeep = activeJeepneys[plate];
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

    socket.on('driver_acknowledge', (data) => {
        io.emit('ping_acknowledged', { plate: data.plate });
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Server running on port " + PORT));
