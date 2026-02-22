const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Configuration ───────────────────────────────────────────────────────
const PLAYER_COLORS = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF', '#FF8B94', '#B8B5FF'];
const PLAYER_NAMES  = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];

// ─── Game State ───────────────────────────────────────────────────────────────
let players = {}; // socketId → { id, name, color, cursor, ready }

let gameState = {
  phase: 'waiting',   // waiting | countdown | active | success | fail
  puzzle: null,
  countdown: 0,
  syncWindow: 1500,   // ms tolerance for simultaneous actions
};

function createPuzzle(playerCount) {
  const nodes = [];
  const gridSize = Math.ceil(Math.sqrt(playerCount + 2));

  // Each player gets a "private" node + shared nodes in the center
  for (let i = 0; i < playerCount; i++) {
    nodes.push({
      id: `private_${i}`,
      owner: Object.keys(players)[i] || null,
      type: 'private',
      activated: false,
      x: 15 + (i % gridSize) * 22,
      y: 30 + Math.floor(i / gridSize) * 22,
    });
  }

  // Shared nodes that require ALL players to activate simultaneously
  nodes.push({ id: 'shared_A', owner: null, type: 'shared', activated: false, x: 42, y: 55 });
  nodes.push({ id: 'shared_B', owner: null, type: 'shared', activated: false, x: 58, y: 55 });

  return {
    nodes,
    connections: generateConnections(nodes),
    activationLog: [],
    startTime: null,
    requiredSync: 'all_shared', // All players must hold shared nodes in sync
  };
}

function generateConnections(nodes) {
  const connections = [];
  const shared = nodes.filter(n => n.type === 'shared');
  const privates = nodes.filter(n => n.type === 'private');

  // Each private node connects to a shared node
  privates.forEach((p, i) => {
    connections.push({ from: p.id, to: shared[i % shared.length].id });
  });
  // Shared nodes connect to each other
  for (let i = 0; i < shared.length - 1; i++) {
    connections.push({ from: shared[i].id, to: shared[i + 1].id });
  }
  return connections;
}

function checkSyncCondition() {
  if (!gameState.puzzle) return false;
  const sharedNodes = gameState.puzzle.nodes.filter(n => n.type === 'shared');
  const allActivated = sharedNodes.every(n => n.activated);
  if (!allActivated) return false;

  // Check that all activations happened within syncWindow
  const sharedActivations = gameState.puzzle.activationLog
    .filter(e => e.type === 'shared' && e.action === 'activate')
    .slice(-sharedNodes.length);

  if (sharedActivations.length < sharedNodes.length) return false;

  const times = sharedActivations.map(e => e.time);
  const spread = Math.max(...times) - Math.min(...times);
  return spread <= gameState.syncWindow;
}

function broadcastState() {
  io.emit('game:state', {
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, color: p.color, ready: p.ready,
    })),
    game: gameState,
  });
}

// ─── Socket Handlers ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const idx = Object.keys(players).length % PLAYER_COLORS.length;
  players[socket.id] = {
    id: socket.id,
    name: PLAYER_NAMES[idx],
    color: PLAYER_COLORS[idx],
    cursor: { x: 50, y: 50 },
    ready: false,
  };

  console.log(`[+] ${players[socket.id].name} connected (${socket.id.slice(0,6)})`);

  // Send player their own identity
  socket.emit('player:identity', { id: socket.id, ...players[socket.id] });
  broadcastState();

  // ── Cursor tracking
  socket.on('cursor:move', ({ x, y }) => {
    if (!players[socket.id]) return;
    players[socket.id].cursor = { x, y };
    socket.broadcast.emit('cursor:update', {
      id: socket.id,
      name: players[socket.id].name,
      color: players[socket.id].color,
      x, y,
    });
  });

  // ── Player ready toggle
  socket.on('player:ready', () => {
    if (!players[socket.id]) return;
    players[socket.id].ready = !players[socket.id].ready;
    
    const allReady = Object.values(players).every(p => p.ready) && Object.keys(players).length >= 2;
    
    if (allReady && gameState.phase === 'waiting') {
      startCountdown();
    } else {
      broadcastState();
    }
  });

  // ── Node interaction
  socket.on('node:activate', ({ nodeId }) => {
    if (!gameState.puzzle || gameState.phase !== 'active') return;
    const node = gameState.puzzle.nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Private nodes can only be activated by their owner
    if (node.type === 'private' && node.owner !== socket.id) return;

    node.activated = true;
    gameState.puzzle.activationLog.push({
      nodeId, playerId: socket.id,
      type: node.type, action: 'activate',
      time: Date.now(),
    });

    io.emit('node:updated', { nodeId, activated: true, activatedBy: players[socket.id]?.name });

    if (checkSyncCondition()) {
      gameState.phase = 'success';
      io.emit('game:success', { message: 'Synchronisation parfaite !' });
      setTimeout(() => resetGame(), 4000);
    }
  });

  socket.on('node:deactivate', ({ nodeId }) => {
    if (!gameState.puzzle || gameState.phase !== 'active') return;
    const node = gameState.puzzle.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (node.type === 'private' && node.owner !== socket.id) return;

    node.activated = false;
    gameState.puzzle.activationLog.push({
      nodeId, playerId: socket.id,
      type: node.type, action: 'deactivate',
      time: Date.now(),
    });
    io.emit('node:updated', { nodeId, activated: false });
  });

  // ── Disconnect
  socket.on('disconnect', () => {
    const name = players[socket.id]?.name;
    delete players[socket.id];
    console.log(`[-] ${name} disconnected`);
    if (Object.keys(players).length === 0) resetGame(true);
    io.emit('cursor:remove', { id: socket.id });
    broadcastState();
  });
});

function startCountdown() {
  gameState.phase = 'countdown';
  gameState.countdown = 3;
  broadcastState();

  const tick = setInterval(() => {
    gameState.countdown--;
    if (gameState.countdown <= 0) {
      clearInterval(tick);
      startGame();
    } else {
      broadcastState();
    }
  }, 1000);
}

function startGame() {
  const playerList = Object.keys(players);
  gameState.puzzle = createPuzzle(playerList.length);
  gameState.puzzle.startTime = Date.now();

  // Assign private nodes to players
  playerList.forEach((socketId, i) => {
    const node = gameState.puzzle.nodes.find(n => n.id === `private_${i}`);
    if (node) node.owner = socketId;
  });

  gameState.phase = 'active';
  broadcastState();
}

function resetGame(silent = false) {
  gameState = {
    phase: 'waiting',
    puzzle: null,
    countdown: 0,
    syncWindow: 1500,
  };
  Object.values(players).forEach(p => p.ready = false);
  if (!silent) broadcastState();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 Collab Game Server running on port ${PORT}\n`);
});
