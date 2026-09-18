const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { OAuth2Client } = require('google-auth-library');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// GANTI DENGAN CLIENT ID DARI GOOGLE CLOUD CONSOLE
const GOOGLE_CLIENT_ID = "344856021698-6137n8cifj18d1v1kknhgusbs3tn08v2.apps.googleusercontent.com";
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Endpoint Verifikasi Token Google Asli
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    res.json({
      success: true,
      user: {
        name: payload.name,
        email: payload.email,
        picture: payload.picture
      }
    });
  } catch (error) {
    res.status(401).json({ success: false, message: 'Token Google Tidak Valid' });
  }
});

// Manajemen WebSocket Real-Time (Web <-> Server <-> ESP32-C3)
let socketClients = new Set();
let esp32Socket = null;
let currentRelayState = false;

wss.on('connection', (ws, req) => {
  const isESP32 = req.url === '/esp32';

  if (isESP32) {
    console.log('[Hardware] ESP32-C3 Terhubung!');
    esp32Socket = ws;
    // Kirim status awal ke ESP32
    ws.send(JSON.stringify({ type: 'SET_RELAY', state: currentRelayState }));
  } else {
    console.log('[Web] Client Dashboard Terhubung!');
    socketClients.add(ws);
    // Kirim status terkini ke Web
    ws.send(JSON.stringify({ type: 'STATE_UPDATE', state: currentRelayState, online: esp32Socket !== null }));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Menerima perintah sakelar dari Web Dashboard
      if (data.type === 'TOGGLE_RELAY') {
        currentRelayState = data.state;
        
        // Teruskan perintah ke ESP32-C3 jika terhubung
        if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
          esp32Socket.send(JSON.stringify({ type: 'SET_RELAY', state: currentRelayState }));
        }

        // Broadcast status terbaru ke semua Web Dashboard yang terbuka
        broadcastWeb({ type: 'STATE_UPDATE', state: currentRelayState, online: esp32Socket !== null });
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    if (ws === esp32Socket) {
      console.log('[Hardware] ESP32-C3 Terputus!');
      esp32Socket = null;
      broadcastWeb({ type: 'STATE_UPDATE', state: currentRelayState, online: false });
    } else {
      socketClients.delete(ws);
    }
  });
});

function broadcastWeb(data) {
  socketClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});