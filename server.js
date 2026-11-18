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

// ==================== AI CHATBOT SETUP ====================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/ask-ai', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ error: "Message required" });

        // Give the AI a personality and context
        const systemPrompt = "You are PARA-PO Bot, a helpful assistant for jeepney commuters in Zamboanga City. Keep your answers short and friendly. The base fare is PHP 13 and it is PHP 15 per kilometer. Popular routes are Ayala and Sinnunuc. If asked about the weather or unrelated topics, politely steer them back to commuting.";

        const response = await ai.models.generateContent({
            model: "gemini-1.5-flash", 
            contents: [
                { role: 'user', parts: [{ text: systemPrompt + "\n\nUser: " + userMessage }] }
            ]
        });
        res.json({ reply: response.text });
    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "AI is currently resting. Try again later." });
    }
});

// ==================== PAGE ROUTES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin-secret-2026', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ==================== REAL-TIME DATA (SOCKETS) ====================
let activeJeepneys = {};

io.on('connection', (socket) => {
    // Send existing jeepneys to new connections
    socket.emit('initial_data', activeJeepneys);

    // Admin places Test Jeepney
    socket.on('admin_place_jeepney', (data) => {
        activeJeepneys["TEST-JEEP"] = { route: "TEST-JEEP", lat: data.lat, lon: data.lon };
        io.emit('jeepney_update', activeJeepneys["TEST-JEEP"]);
    });

    // Admin places Test Passenger
    socket.on('admin_place_passenger', (data) => {
        io.emit('passenger_update', { lat: data.lat, lon: data.lon });
    });

    // Admin removes Test Jeepney
    socket.on('admin_remove_jeepney', () => {
        delete activeJeepneys["TEST-JEEP"];
        io.emit('jeepney_lost', "TEST-JEEP");
    });

    // Hardware ESP32 Updates
    socket.on('esp32_update', (data) => {
        activeJeepneys[data.route] = data;
        io.emit('jeepney_update', data);
    });
});

// Start Server
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log("Website running on port " + PORT);
});
