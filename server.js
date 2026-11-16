const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path'); // Added this

const app = express();
app.use(cors());
app.use(express.json());

// THIS IS THE FIX: Tell Express to serve your HTML file
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

let activeJeepneys = {};

app.post('/api/update', (req, res) => {
    const { route, lat, lon } = req.body;
    activeJeepneys[route] = { route, lat, lon, lastSeen: Date.now() };
    io.emit('jeepney_update', activeJeepneys[route]);
    res.status(200).send("OK");
});

setInterval(() => {
    const now = Date.now();
    for (let route in activeJeepneys) {
        if (now - activeJeepneys[route].lastSeen > 30000) {
            delete activeJeepneys[route];
            io.emit('jeepney_lost', route);
        }
    }
}, 10000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log("Website running on port " + PORT);
});
