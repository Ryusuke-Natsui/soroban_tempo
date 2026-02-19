const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

const rooms = new Map();

function now() {
  return Date.now();
}

function makeId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

function pruneExpiredRooms() {
  const threshold = now() - ROOM_TTL_MS;
  for (const [id, room] of rooms.entries()) {
    if (room.createdAt < threshold || room.closedAt) {
      for (const res of room.subscribers.values()) {
        res.end();
      }
      rooms.delete(id);
    }
  }
}
setInterval(pruneExpiredRooms, 60 * 1000).unref();

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getRoomState(room) {
  return {
    roomId: room.id,
    hostSessionId: room.hostSessionId,
    createdAt: room.createdAt,
    expiresAt: room.createdAt + ROOM_TTL_MS,
    closedAt: room.closedAt || null,
    settings: room.settings,
    status: room.status,
    round: room.round,
    participants: Object.values(room.participants).map((p) => ({
      sessionId: p.sessionId,
      nickname: p.nickname,
      joinedAt: p.joinedAt,
      isHost: p.sessionId === room.hostSessionId,
      lastResult: p.lastResult || null
    })),
    results: room.results
  };
}

function broadcast(room, type, payload = {}) {
  const event = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [sessionId, res] of room.subscribers.entries()) {
    if (room.participants[sessionId]) {
      res.write(event);
    }
  }
}

function ensureParticipant(room, sessionId) {
  return sessionId && room.participants[sessionId];
}

function sanitizeNickname(v) {
  return String(v || '').trim().slice(0, 10) || 'Guest';
}

function validateSettings(settings) {
  const tempo = Number(settings.tempo);
  const terms = Number(settings.terms);
  const digits = Number(settings.digits);
  const countdown = Number(settings.countdown);
  if (!(tempo > 0.2 && tempo <= 5)) return 'tempo out of range';
  if (![10, 15, 20, 30].includes(terms)) return 'invalid terms';
  if (![1, 2, 3].includes(digits)) return 'invalid digits';
  if (!['add', 'sub', 'mixed'].includes(settings.mode)) return 'invalid mode';
  if (![3, 5, 10].includes(countdown)) return 'invalid countdown';
  if (typeof settings.allowNegative !== 'boolean') return 'invalid allowNegative';
  if (typeof settings.beep !== 'boolean') return 'invalid beep';
  const seed = String(settings.seed || '').trim().slice(0, 64);
  if (!seed) return 'seed required';
  settings.seed = seed;
  return null;
}

function routeApi(req, res, urlObj) {
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && pathname === '/api/time') {
    return sendJson(res, 200, { serverNow: now() });
  }

  if (req.method === 'POST' && pathname === '/api/rooms') {
    return parseBody(req).then((body) => {
      const settings = body.settings || {};
      const err = validateSettings(settings);
      if (err) return sendJson(res, 400, { error: err });
      const roomId = makeId(8);
      const hostSessionId = makeToken();
      const nickname = sanitizeNickname(body.nickname || 'Host');
      const room = {
        id: roomId,
        hostSessionId,
        createdAt: now(),
        closedAt: null,
        settings,
        status: 'waiting',
        round: 1,
        participants: {
          [hostSessionId]: {
            sessionId: hostSessionId,
            nickname,
            joinedAt: now(),
            lastResult: null
          }
        },
        subscribers: new Map(),
        results: []
      };
      rooms.set(roomId, room);
      return sendJson(res, 201, {
        roomId,
        sessionId: hostSessionId,
        joinUrl: `/room/${roomId}`,
        state: getRoomState(room)
      });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const roomMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)$/);
  if (req.method === 'GET' && roomMatch) {
    const room = rooms.get(roomMatch[1]);
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    return sendJson(res, 200, getRoomState(room));
  }

  const joinMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/join$/);
  if (req.method === 'POST' && joinMatch) {
    const room = rooms.get(joinMatch[1]);
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    return parseBody(req).then((body) => {
      const nickname = sanitizeNickname(body.nickname);
      const sessionId = makeToken();
      room.participants[sessionId] = { sessionId, nickname, joinedAt: now(), lastResult: null };
      broadcast(room, 'state', getRoomState(room));
      return sendJson(res, 200, { sessionId, state: getRoomState(room) });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const startMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/start$/);
  if (req.method === 'POST' && startMatch) {
    const room = rooms.get(startMatch[1]);
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    return parseBody(req).then((body) => {
      if (body.sessionId !== room.hostSessionId) return sendJson(res, 403, { error: 'Host only' });
      const startAt = Number(body.startAt);
      if (!Number.isFinite(startAt) || startAt < now() + 1000) {
        return sendJson(res, 400, { error: 'startAt must be >= now + 1000ms (server-based)' });
      }
      room.status = 'scheduled';
      room.settings.startAt = startAt;
      room.results = [];
      for (const participant of Object.values(room.participants)) {
        participant.lastResult = null;
      }
      broadcast(room, 'state', getRoomState(room));
      broadcast(room, 'start_scheduled', { startAt, round: room.round });
      return sendJson(res, 200, getRoomState(room));
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const resultMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/result$/);
  if (req.method === 'POST' && resultMatch) {
    const room = rooms.get(resultMatch[1]);
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    return parseBody(req).then((body) => {
      const participant = ensureParticipant(room, body.sessionId);
      if (!participant) return sendJson(res, 403, { error: 'Unknown participant' });
      const existingIdx = room.results.findIndex((x) => x.sessionId === body.sessionId);
      const entry = {
        sessionId: body.sessionId,
        nickname: participant.nickname,
        answer: String(body.answer || ''),
        correct: Boolean(body.correct),
        submittedAt: now(),
        round: room.round
      };
      participant.lastResult = entry;
      if (existingIdx >= 0) room.results[existingIdx] = entry;
      else room.results.push(entry);
      broadcast(room, 'state', getRoomState(room));
      return sendJson(res, 200, { ok: true });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const rematchMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/rematch$/);
  if (req.method === 'POST' && rematchMatch) {
    const room = rooms.get(rematchMatch[1]);
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    return parseBody(req).then((body) => {
      if (body.sessionId !== room.hostSessionId) return sendJson(res, 403, { error: 'Host only' });
      room.status = 'waiting';
      room.round += 1;
      delete room.settings.startAt;
      room.results = [];
      for (const participant of Object.values(room.participants)) {
        participant.lastResult = null;
      }
      broadcast(room, 'state', getRoomState(room));
      return sendJson(res, 200, getRoomState(room));
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const closeMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/close$/);
  if (req.method === 'POST' && closeMatch) {
    const room = rooms.get(closeMatch[1]);
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    return parseBody(req).then((body) => {
      if (body.sessionId !== room.hostSessionId) return sendJson(res, 403, { error: 'Host only' });
      room.closedAt = now();
      room.status = 'closed';
      broadcast(room, 'state', getRoomState(room));
      for (const subscriber of room.subscribers.values()) subscriber.end();
      return sendJson(res, 200, { ok: true });
    }).catch((e) => sendJson(res, 400, { error: e.message }));
  }

  const eventsMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/events$/);
  if (req.method === 'GET' && eventsMatch) {
    const room = rooms.get(eventsMatch[1]);
    const sessionId = urlObj.searchParams.get('sessionId');
    if (!room || room.closedAt) return sendJson(res, 404, { error: 'Room not found' });
    if (!ensureParticipant(room, sessionId)) return sendJson(res, 403, { error: 'Unknown participant' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`event: state\ndata: ${JSON.stringify(getRoomState(room))}\n\n`);
    room.subscribers.set(sessionId, res);
    req.on('close', () => {
      room.subscribers.delete(sessionId);
    });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlObj) {
  let filePath = urlObj.pathname;
  if (filePath === '/') filePath = '/index.html';
  if (filePath.startsWith('/room/')) filePath = '/index.html';
  const abs = path.join(PUBLIC_DIR, path.normalize(filePath));
  if (!abs.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(abs, (err, data) => {
    if (err) {
      if (filePath !== '/index.html') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (fallbackErr, fallbackData) => {
          if (fallbackErr) return sendJson(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'Content-Type': mime['.html'], 'Cache-Control': 'no-store' });
          return res.end(fallbackData);
        });
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
      return;
    }
    const ext = path.extname(abs);
    const cacheControl = ext === '.html' ? 'no-store' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  if (urlObj.pathname.startsWith('/api/')) {
    return routeApi(req, res, urlObj);
  }
  return serveStatic(req, res, urlObj);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
