const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'jump-world-secret-change-in-prod';
const USERS_FILE = path.join(__dirname, 'users.json');
const WORLD_SEED = 42; // fixed seed so all clients get same terrain

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

app.get('/seed', (req, res) => res.json({ seed: WORLD_SEED }));

app.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 2-20 alphanumeric chars' });
  const users = readUsers();
  if (users[username]) return res.status(409).json({ error: 'Username taken' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { hash, createdAt: Date.now() };
  writeUsers(users);
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = readUsers();
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

// connected players: { ws, username, x, y, z, yaw }
const players = new Map();

function broadcast(data, excludeWs) {
  const msg = JSON.stringify(data);
  for (const [ws] of players) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  let authed = false;
  let username = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!authed) {
      if (msg.type !== 'auth') return ws.close();
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        username = payload.username;
      } catch {
        ws.send(JSON.stringify({ type: 'authFail', error: 'Invalid token' }));
        return ws.close();
      }
      authed = true;
      players.set(ws, { username, x: 0, y: 20, z: 0, yaw: 0 });

      // send current players list to new client
      const others = [];
      for (const [, p] of players) {
        if (p.username !== username) others.push({ username: p.username, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
      }
      ws.send(JSON.stringify({ type: 'init', players: others }));

      // tell everyone else this player joined
      broadcast({ type: 'join', username, x: 0, y: 20, z: 0, yaw: 0 }, ws);
      console.log(`+ ${username} (${players.size} online)`);
      return;
    }

    if (msg.type === 'move') {
      const p = players.get(ws);
      if (!p) return;
      p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw;
      broadcast({ type: 'move', username, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw }, ws);
    }
  });

  ws.on('close', () => {
    if (username) {
      players.delete(ws);
      broadcast({ type: 'leave', username }, ws);
      console.log(`- ${username} (${players.size} online)`);
    }
  });
});

server.listen(PORT, () => console.log(`Jump-World server on :${PORT}`));
