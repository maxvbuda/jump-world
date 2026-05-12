const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { MongoClient } = require('mongodb');

const GAME_FILE = path.join(__dirname, 'index.html');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'jump-world-secret-change-in-prod';
const MONGO_URI = process.env.MONGO_URI;
const WORLD_SEED = 42;

// MongoDB setup
let usersCol;
async function connectDB() {
  if (!MONGO_URI) { console.warn('No MONGO_URI — using in-memory user store'); return; }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db('jump-world');
  usersCol = db.collection('users');
  await usersCol.createIndex({ username: 1 }, { unique: true });
  console.log('MongoDB connected');
}
connectDB().catch(console.error);

// Fallback in-memory store when no MongoDB
const memUsers = {};
async function findUser(username) {
  if (usersCol) return usersCol.findOne({ username });
  return memUsers[username] || null;
}
async function createUser(username, hash) {
  if (usersCol) return usersCol.insertOne({ username, hash, createdAt: new Date() });
  memUsers[username] = { username, hash, createdAt: Date.now() };
}

app.use(express.json());
app.get('/', (req, res) => res.sendFile(GAME_FILE));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/seed', (req, res) => res.json({ seed: WORLD_SEED }));

app.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 2-20 alphanumeric chars' });
  if (await findUser(username)) return res.status(409).json({ error: 'Username taken' });
  const hash = await bcrypt.hash(password, 10);
  await createUser(username, hash);
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = await findUser(username);
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

      const others = [];
      for (const [, p] of players) {
        if (p.username !== username) others.push({ username: p.username, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
      }
      ws.send(JSON.stringify({ type: 'init', players: others }));
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

    if (msg.type === 'chat') {
      const text = String(msg.message || '').trim().slice(0, 200);
      if (!text) return;
      broadcast({ type: 'chat', username, message: text }, null);
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
