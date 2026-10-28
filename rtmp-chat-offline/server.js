'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
const streamKeys = require('./lib/stream-keys');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Trust X-Forwarded-Proto from a reverse proxy on this host only, so the app
// knows a viewer arrived over HTTPS. Scoped to loopback on purpose: a request
// straight from the internet cannot spoof the header, because its connection
// did not come from 127.0.0.1.
app.set('trust proxy', 'loopback');

const PORT = parsePort(process.env.PORT, 8080);
const DEFAULT_STREAM = process.env.DEFAULT_STREAM || 'arthas';

/**
 * Resolve a port from the environment.
 * PORT=0 is meaningful (bind a random free port) so it must survive - a plain
 * `Number(x) || 8080` would silently turn 0 back into 8080.
 */
function parsePort(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return fallback;
    return port;
}

const MAX_MESSAGES_PER_ROOM = 200;
const MAX_MESSAGES_PER_SECOND = 2;
const RATE_LIMIT_WINDOW = 1000;
const ROOM_TTL = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL = 30000;

const DEFAULT_COLOR = '#bf94ff';
const SYSTEM_COLOR = '#8b8b8b';
const MAX_USERNAME = 20;
const MAX_MESSAGE = 500;
const MAX_STREAM = 64;
const STREAM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

app.disable('x-powered-by');

// The UI is entirely local. These headers keep it from loading anything from
// the network, and from being framed or sniffed by another site.
// frame-src/media-src allow the MediaMTX player, which is served from the HLS
// port - possibly a different host when STREAM_BASE is in use.
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "frame-src http: https:",
    "media-src 'self' http: https: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
].join('; ');

app.use((req, res, next) => {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.use(express.json({ limit: '16kb' }));

// Cheap liveness probe for ./rtmp-chat.sh status/doctor and systemd.
app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.use(streamKeys.router);
app.use(express.static(path.join(__dirname, 'public')));

// roomKey -> { messages, users: Map<clientId, user>, createdAt, lastActivity }
const rooms = new Map();
// ws -> client session
const clients = new Map();
// roomKey -> Set<ws>
const roomClients = new Map();

// ------------------------------------------------------------------ validation

function clean(value, max) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function sanitizeStream(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    return STREAM_NAME_RE.test(name) ? name : '';
}

function sanitizeColor(value) {
    return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim() : DEFAULT_COLOR;
}

// ------------------------------------------------------------------ rooms

function getOrCreateRoom(roomKey) {
    let room = rooms.get(roomKey);
    if (!room) {
        room = { messages: [], users: new Map(), createdAt: Date.now(), lastActivity: Date.now() };
        rooms.set(roomKey, room);
    }
    return room;
}

function addMessageToRoom(room, message) {
    room.messages.push(message);
    room.lastActivity = Date.now();
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
        room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
}

function userList(room) {
    return Array.from(room.users.values()).map((u) => ({ id: u.id, username: u.username, color: u.color }));
}

function broadcast(roomKey, payload, excludeWs) {
    const targets = roomClients.get(roomKey);
    if (!targets || targets.size === 0) return;
    const raw = JSON.stringify(payload);
    for (const ws of targets) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
}

function broadcastUsers(roomKey) {
    const room = rooms.get(roomKey);
    if (!room) return;
    broadcast(roomKey, { type: 'users', users: userList(room) });
}

/** Per-connection fixed window rate limit (was per-username, shared across rooms). */
function allowMessage(client) {
    const now = Date.now();
    if (now - client.windowStart >= RATE_LIMIT_WINDOW) {
        client.windowStart = now;
        client.count = 1;
        return true;
    }
    if (client.count >= MAX_MESSAGES_PER_SECOND) return false;
    client.count++;
    return true;
}

function joinRoom(ws, roomKey, username, color) {
    leaveRoom(ws);

    const room = getOrCreateRoom(roomKey);
    const client = {
        id: crypto.randomUUID(),
        roomKey,
        username,
        color,
        windowStart: Date.now(),
        count: 0,
        lastWarn: 0
    };

    room.users.set(client.id, { id: client.id, username, color });
    room.lastActivity = Date.now();

    let targets = roomClients.get(roomKey);
    if (!targets) {
        targets = new Set();
        roomClients.set(roomKey, targets);
    }
    targets.add(ws);

    clients.set(ws, client);

    ws.send(JSON.stringify({ type: 'history', messages: room.messages }));
    ws.send(JSON.stringify({ type: 'users', users: userList(room) }));
    ws.send(JSON.stringify({
        type: 'chat',
        system: true,
        username: 'System',
        color: SYSTEM_COLOR,
        message: 'Welcome to the chat!',
        ts: Date.now()
    }));

    broadcastUsers(roomKey);
}

function leaveRoom(ws) {
    const client = clients.get(ws);
    if (!client) return;

    const targets = roomClients.get(client.roomKey);
    if (targets) {
        targets.delete(ws);
        if (targets.size === 0) roomClients.delete(client.roomKey);
    }

    const room = rooms.get(client.roomKey);
    if (room) {
        room.users.delete(client.id);
        room.lastActivity = Date.now();
        if (room.users.size === 0) room.messages = [];   // don't leak history between sittings
        broadcastUsers(client.roomKey);
    }

    clients.delete(ws);
}

function cleanupRooms() {
    const now = Date.now();
    for (const [roomKey, room] of rooms) {
        if (room.users.size === 0 && now - room.lastActivity > ROOM_TTL) {
            rooms.delete(roomKey);
            roomClients.delete(roomKey);
        }
    }
}

// ------------------------------------------------------------------ websocket

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            return;
        }
        if (!data || typeof data.type !== 'string') return;

        if (data.type === 'join') {
            const roomKey = sanitizeStream(data.stream);
            if (!roomKey) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid stream name.' }));
                return;
            }
            const username = clean(data.username, MAX_USERNAME);
            if (!username) {
                ws.send(JSON.stringify({ type: 'error', message: 'Username is required.' }));
                return;
            }
            joinRoom(ws, roomKey, username, sanitizeColor(data.color));
            return;
        }

        const client = clients.get(ws);
        if (!client) return;

        if (data.type === 'chat') {
            const message = clean(data.message, MAX_MESSAGE);
            if (!message) return;

            if (!allowMessage(client)) {
                const now = Date.now();
                if (now - client.lastWarn > RATE_LIMIT_WINDOW) {
                    client.lastWarn = now;
                    ws.send(JSON.stringify({ type: 'error', message: 'You are sending messages too fast. Please wait.' }));
                }
                return;
            }

            const room = rooms.get(client.roomKey);
            if (!room) return;

            const payload = {
                username: client.username,
                color: client.color,
                message,
                ts: Date.now()
            };
            addMessageToRoom(room, payload);
            broadcast(client.roomKey, { type: 'chat', ...payload }, ws);
            return;
        }

        if (data.type === 'get-users') {
            broadcastUsers(client.roomKey);
        }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
});

const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            leaveRoom(ws);
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_INTERVAL);
heartbeatTimer.unref();

const roomTimer = setInterval(cleanupRooms, ROOM_TTL);
roomTimer.unref();

// ------------------------------------------------------------------ http

// Is anything actually being published for this room? Lets the page show
// "LIVE" / "OFFLINE" instead of an unexplained black rectangle, and poll to
// pick the stream up the moment the streamer connects.
app.get('/api/live', async (req, res) => {
    const room = sanitizeStream(req.query.room) || DEFAULT_STREAM;
    try {
        res.json(await streamKeys.liveStatusFor(room));
    } catch (e) {
        res.json({ room, path: 'live/' + room, live: false });
    }
});

// The player iframe runs in the viewer's browser, so this has to be resolved
// per-request from the host they reached us on - see streamKeys.streamBaseFor.
// The path itself is looked up too: a streamer who pastes only the secret ends
// up on a live path that is not named after the room, and hardcoding live/<room>
// would leave the player staring at "stream not found".
app.get('/stream-url', async (req, res) => {
    const name = sanitizeStream(req.query.name) || DEFAULT_STREAM;
    const base = streamKeys.streamBaseFor(req);
    let path;
    try {
        path = await streamKeys.livePathFor(name);
    } catch (e) {
        path = 'live/' + name;
    }
    res.json({
        stream: name,
        page: `${base}/${path}/`,
        hls: `${base}/${path}/index.m3u8`,
        webrtc: `${base}/webrtc/${path}`,
        path,
        rtmpBase: streamKeys.rtmpBaseFor(req)
    });
});

streamKeys.setPort(PORT);

server.listen(PORT, () => {
    const adminPath = streamKeys.ensureAdminPath();
    console.log(`Chat server running on http://localhost:${PORT}`);
    console.log(`Admin panel:               http://localhost:${PORT}${adminPath}`);
    console.log(`  (not linked from the site; this URL is stored in data/admin-path.txt)`);
    console.log(`MediaMTX ports:            rtmp ${process.env.RTMP_PORT || 1935}, stream ${process.env.STREAM_PORT || 8888}`);
    console.log(`Video URLs are built per request from the viewer's host, so the`);
    console.log(`player follows whoever is watching. Set STREAM_BASE to override.`);
    console.log(`Active stream keys:        ${streamKeys.activeKeyCount()}`);
    console.log(`Publish gate:              POST /mediamtx/auth  (mediamtx.yml: authHTTPAddress)`);
});

// Close websockets and the HTTP listener on systemd stop / Ctrl-C. Without
// this, a restart waits for the SIGKILL timeout and viewers see a dead tab.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received - shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    for (const ws of wss.clients) {
        try { ws.close(1001, 'server shutting down'); } catch (e) { /* already closed */ }
    }
    server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
