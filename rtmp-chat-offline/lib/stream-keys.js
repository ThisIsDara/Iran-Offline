'use strict';

/**
 * Stream key store + admin API + MediaMTX publish authorization.
 *
 * MediaMTX asks us to authorize an action; we answer 2xx to allow it and
 * anything else to reject it. Only `publish` is gated - reading is public.
 *
 * Two wire formats are supported, because MediaMTX changed its hook API:
 *
 *   - `POST /mediamtx/auth`   current (v1.x). This is `authHTTPAddress`.
 *     MediaMTX POSTs
 *       {ip,user,password,token,action,path,protocol,id,query,userAgent}
 *     for every action it wants to perform.
 *
 *   - `/mediamtx/hooks/publish/on_*`  the older `globalHooks` URL API. MediaMTX
 *     >= 1.0 REMOVED `globalHooks` and refuses to start if it is present, so
 *     this exists purely for people still on a legacy build.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'stream-keys.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'admin-password.txt');
const ADMIN_PATH_FILE = path.join(DATA_DIR, 'admin-path.txt');
const ADMIN_UI_DIR = path.join(__dirname, '..', 'admin');

const SESSION_TTL = 12 * 60 * 60 * 1000;   // admin login sessions
const LIVE_TTL = 6 * 60 * 60 * 1000;       // stale "currently publishing" entries
const KEY_PREFIX = 'sk_';
const ANY_STREAM = '*';
const STREAM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Path prefix MediaMTX puts in front of the room when the RTMP URL is
 * rtmp://host:1935/live/<room>. The admin panel stores plain room names
 * ("arthas"), so this has to come back off before comparing.
 */
const RTMP_PATH_PREFIXES = ['live', 'stream', 'streams'];

// query-string params that may carry the secret
const AUTH_PARAMS = new Set([
    'key', 'streamkey', 'stream_key', 'auth', 'token', 'secret', 'pass', 'password', 'pw'
]);

// MediaMTX hook action names (both old and new generations, since which one
// exists depends on the MediaMTX version). Matched on the last path segment so
// any base URL works.
const HOOK_GATE = new Set(['on_init', 'on_stream_create']);
const HOOK_RELEASE = new Set(['on_deinit', 'on_stream_close']);
const HOOK_IGNORE = new Set([
    'on_record_ready', 'on_record_segment_ready', 'on_segment_ready',
    'on_validate', 'on_ready', 'on_conn_open', 'on_session_open'
]);
const HOOK_RE = /\/(on_init|on_stream_create|on_deinit|on_stream_close|on_record_ready|on_record_segment_ready|on_segment_ready|on_validate|on_ready|on_conn_open|on_session_open)$/;

const state = {
    keys: [],              // key records
    bySecret: new Map(),   // secret -> key record
    sessions: new Map(),   // token -> expiresAt
    live: new Map()        // liveId -> { keyId, stream, ip, protocol, startedAt }
};

let generatedPassword = null;
// the secret admin URL, read or minted once per process
let cachedAdminPath = null;
// set by server.js once it has resolved the port, so the admin panel shows the
// port the server is really listening on
let listenPort = 0;

// ---------------------------------------------------------------- helpers

function clean(value, max) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function isValidStreamName(name) {
    return typeof name === 'string' && (name === ANY_STREAM || STREAM_NAME_RE.test(name));
}

function persist() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(KEYS_FILE, JSON.stringify({ version: 1, keys: state.keys }, null, 2));
        try { fs.chmodSync(KEYS_FILE, 0o600); } catch (e) { /* best effort on Windows */ }
    } catch (err) {
        console.error('[keys] failed to save:', err.message);
    }
}

function reindex() {
    state.bySecret = new Map(state.keys.map((k) => [k.secret, k]));
}

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
        const list = Array.isArray(raw.keys) ? raw.keys : [];
        state.keys = list.filter((k) => k && typeof k.id === 'string' && typeof k.secret === 'string' && typeof k.stream === 'string');
    } catch (e) {
        state.keys = [];
    }
    reindex();
}

// ---------------------------------------------------------------- admin auth

/**
 * Where the admin UI lives.
 *
 * The panel is served from outside `public/`, at a random path persisted in
 * data/admin-path.txt, so it is neither linked from the site nor sitting at a
 * guessable /admin.html. Set ADMIN_PATH to pin it instead.
 *
 * This is obscurity on top of the real protection (password + bearer-token
 * sessions), not a replacement for it - it just stops the panel being found.
 */
function adminPath() {
    const fromEnv = clean(process.env.ADMIN_PATH, 64).replace(/[^A-Za-z0-9._~-]/g, '');
    if (fromEnv) return '/' + fromEnv;

    // Memoised on purpose. Without this, an unwritable DATA_DIR would mint a
    // fresh path on every single request and the URL would flap out from under
    // the operator on every refresh.
    if (cachedAdminPath) return cachedAdminPath;

    let stored = '';
    try {
        stored = fs.readFileSync(ADMIN_PATH_FILE, 'utf8').trim().replace(/^\/+|\/+$/g, '');
    } catch (e) { /* not generated yet */ }

    if (!stored) {
        stored = 'admin-' + crypto.randomBytes(9).toString('base64url');
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(ADMIN_PATH_FILE, stored + '\n');
            try { fs.chmodSync(ADMIN_PATH_FILE, 0o600); } catch (e) { /* best effort */ }
        } catch (e) {
            console.error('[keys] failed to persist admin path:', e.message);
        }
        console.log('\n  Admin panel path (generated, saved to ' + ADMIN_PATH_FILE + '):\n    /' + stored + '\n');
    }

    cachedAdminPath = '/' + stored;
    return cachedAdminPath;
}

function adminPassword() {
    if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;

    try {
        const stored = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
        if (stored) return stored;
    } catch (e) { /* not generated yet */ }

    if (!generatedPassword) {
        generatedPassword = crypto.randomBytes(9).toString('base64url');
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(PASSWORD_FILE, generatedPassword);
            try { fs.chmodSync(PASSWORD_FILE, 0o600); } catch (e) { /* best effort */ }
        } catch (e) {
            console.error('[keys] failed to persist admin password:', e.message);
        }
        console.log('\n  Admin password (generated, saved to ' + PASSWORD_FILE + '):\n    ' + generatedPassword + '\n');
    }
    return generatedPassword;
}

function passwordMatches(input) {
    const a = crypto.createHash('sha256').update(String(input == null ? '' : input)).digest();
    const b = crypto.createHash('sha256').update(adminPassword()).digest();
    return crypto.timingSafeEqual(a, b);
}

function createSession() {
    const token = crypto.randomBytes(24).toString('hex');
    state.sessions.set(token, Date.now() + SESSION_TTL);
    return { token, expiresAt: state.sessions.get(token) };
}

function sessionValid(token) {
    if (!token) return false;
    const expiresAt = state.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        state.sessions.delete(token);
        return false;
    }
    return true;
}

function tokenFrom(req) {
    const header = req.get('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    return clean(req.get('x-admin-token') || req.query.token, 200);
}

function requireAdmin(req, res, next) {
    if (!sessionValid(tokenFrom(req))) return res.status(401).json({ error: 'Not authorized' });
    next();
}

// ---------------------------------------------------------------- key model

function isActive(key) {
    if (!key || key.revokedAt) return false;
    if (key.expiresAt && key.expiresAt <= Date.now()) return false;
    return true;
}

function liveCount(keyId) {
    const cutoff = Date.now() - LIVE_TTL;
    let n = 0;
    for (const entry of state.live.values()) {
        if (entry.keyId === keyId && entry.startedAt >= cutoff) n++;
    }
    return n;
}

function publicKey(key) {
    return {
        id: key.id,
        label: key.label,
        stream: key.stream,
        secret: key.secret,
        note: key.note,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt || null,
        revokedAt: key.revokedAt || null,
        active: isActive(key),
        live: liveCount(key.id)
    };
}

function findKey(id) {
    return state.keys.find((k) => k.id === id) || null;
}

function createKey(body) {
    const label = clean(body.label, 40);
    const stream = typeof body.stream === 'string' ? body.stream.trim() : '';
    const note = clean(body.note, 140);

    // Say which field is wrong. "Stream name may only contain letters..." for an
    // empty field reads like the value is malformed, not missing.
    if (!stream) return { error: 'Room / stream name is required. Use "*" to allow any room.' };
    if (!isValidStreamName(stream)) return { error: 'Room / stream name may only contain letters, numbers, dot, dash and underscore (or "*" for any room).' };
    if (!label) return { error: 'Streamer name is required (who is this key for?).' };

    let expiresAt = null;
    if (body.expiresAt === 'never' || body.expiresAt == null || body.expiresAt === '') {
        expiresAt = null;
    } else if (typeof body.expiresAt === 'number' || /^\d+$/.test(String(body.expiresAt))) {
        expiresAt = Date.now() + Number(body.expiresAt) * 24 * 60 * 60 * 1000;
    } else {
        const parsed = Date.parse(body.expiresAt);
        if (Number.isNaN(parsed)) return { error: 'Invalid expiry date.' };
        expiresAt = parsed;
    }

    const key = {
        id: crypto.randomUUID(),
        label,
        stream,
        secret: KEY_PREFIX + crypto.randomBytes(16).toString('hex'),
        note,
        createdAt: Date.now(),
        expiresAt,
        revokedAt: null
    };

    state.keys.push(key);
    reindex();
    persist();
    return { key };
}

function updateKey(id, body) {
    const key = findKey(id);
    if (!key) return { error: 'Key not found' };

    if (body.label !== undefined) key.label = clean(body.label, 40) || key.label;
    if (body.note !== undefined) key.note = clean(body.note, 140);
    if (body.stream !== undefined) {
        const stream = String(body.stream).trim();
        if (!stream) return { error: 'Room / stream name is required. Use "*" to allow any room.' };
        if (!isValidStreamName(stream)) return { error: 'Room / stream name may only contain letters, numbers, dot, dash and underscore (or "*" for any room).' };
        key.stream = stream;
    }

    if (body.expiresAt !== undefined) {
        if (body.expiresAt === 'never' || body.expiresAt === null || body.expiresAt === '') key.expiresAt = null;
        else if (typeof body.expiresAt === 'number' || /^\d+$/.test(String(body.expiresAt))) {
            key.expiresAt = Date.now() + Number(body.expiresAt) * 24 * 60 * 60 * 1000;
        } else {
            const parsed = Date.parse(body.expiresAt);
            if (Number.isNaN(parsed)) return { error: 'Invalid expiry date.' };
            key.expiresAt = parsed;
        }
    }
    if (body.revoked !== undefined) {
        const revoked = body.revoked === true || body.revoked === 'true';
        key.revokedAt = revoked ? (key.revokedAt || Date.now()) : null;
    }

    persist();
    return { key };
}

function deleteKey(id) {
    const index = state.keys.findIndex((k) => k.id === id);
    if (index === -1) return { error: 'Key not found' };
    state.keys.splice(index, 1);
    for (const [liveId, entry] of state.live) {
        if (entry.keyId === id) state.live.delete(liveId);
    }
    reindex();
    persist();
    return { ok: true };
}

// ---------------------------------------------------------------- publish auth

/** Pull the secret out of the RTMP query string (`?key=...`). */
function extractSecret(query) {
    if (typeof query !== 'string') return '';
    const q = query.replace(/^\?/, '');
    if (!q) return '';
    for (const part of q.split('&')) {
        const eq = part.indexOf('=');
        const name = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
        if (!AUTH_PARAMS.has(name)) continue;
        const value = eq === -1 ? part : part.slice(eq + 1);
        try {
            return decodeURIComponent(value.replace(/\+/g, ' '));
        } catch (e) {
            return value;
        }
    }
    return '';
}

/**
 * Reduce a MediaMTX path to the room name the admin panel knows about.
 *
 * `rtmp://host:1935/live/arthas` arrives as `live/arthas`; the key is stored
 * against `arthas`. Nested paths keep their slashes so they can never be
 * confused with a flat room name - they simply fail to match, which is the
 * safe direction.
 */
function roomFromPath(path) {
    let name = clean(path, 200);
    if (!name) return '';
    const slash = name.indexOf('/');
    if (slash === -1) return name;
    const head = name.slice(0, slash);
    if (RTMP_PATH_PREFIXES.includes(head)) name = name.slice(slash + 1);
    return clean(name, 64);
}

/**
 * Decide whether a publish attempt is allowed.
 * @returns {{ok: true, key: object} | {ok: false, reason: string}}
 */
function authorizePublish(stream, secret) {
    if (!secret) return { ok: false, reason: 'no stream key supplied' };

    const key = state.bySecret.get(secret);
    if (!key) return { ok: false, reason: 'unknown stream key' };
    if (key.revokedAt) return { ok: false, reason: 'stream key revoked' };
    if (key.expiresAt && key.expiresAt <= Date.now()) return { ok: false, reason: 'stream key expired' };
    if (key.stream !== ANY_STREAM && stream && key.stream !== stream) {
        return { ok: false, reason: 'stream key is not valid for stream "' + stream + '"' };
    }
    return { ok: true, key };
}

function markLive(keyId, stream, ip, protocol, sessionId) {
    // MediaMTX 1.x gives every publish a stable `id` - key on that and the
    // panel's "live" count tracks real sessions. The legacy hook API sends no
    // id, so fall back to the old key|stream|ip composite, which at least
    // collapses repeated hook calls from one publisher into a single entry.
    const id = sessionId || (keyId + '|' + stream + '|' + (ip || '?'));
    state.live.set(id, { keyId, stream, ip: ip || '', protocol: protocol || '', startedAt: Date.now() });
    return id;
}

function clearLive(sessionId, stream, ip) {
    if (sessionId) {
        state.live.delete(sessionId);
        return;
    }
    for (const [id, entry] of state.live) {
        if (entry.stream === stream && (!ip || entry.ip === ip)) state.live.delete(id);
    }
}

function cleanup() {
    const now = Date.now();
    for (const [token, expiresAt] of state.sessions) {
        if (expiresAt <= now) state.sessions.delete(token);
    }
    const cutoff = now - LIVE_TTL;
    for (const [id, entry] of state.live) {
        if (entry.startedAt < cutoff) state.live.delete(id);
    }
}

// ---------------------------------------------------------------- router

const router = express.Router();

function hookParams(req) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const pick = (name) => req.query[name] !== undefined ? req.query[name] : body[name];
    return {
        stream: clean(pick('stream'), 64),
        query: typeof pick('query') === 'string' ? pick('query') : '',
        ip: clean(pick('ip'), 64),
        protocol: clean(pick('protocol'), 16)
    };
}

/**
 * Pull a field out of a MediaMTX auth payload, tolerating GET and POST. */
function authField(body, name) {
    return body && typeof body[name] === 'string' ? body[name] : '';
}

// ------------------------------------------------------------------ media url
//
// The player is embedded in the browser, so the video URL has to be built from
// the *browser's* point of view. Resolving it on the server against a fixed
// address is the classic mistake here: pointing it at 127.0.0.1 makes every
// viewer's browser go looking for the stream on their own machine.
//
// Take the host the viewer already used to reach the chat, swap the chat port
// for the MediaMTX one, and it works over LAN, public IP or hostname with no
// configuration at all.
//
// STREAM_BASE and RTMP_BASE override each side independently, which is what a
// CDN setup needs: viewers can reach MediaMTX over proxied HTTPS, but
// streamers cannot push RTMP through an HTTP proxy, so the ingest host has to
// be a different, directly-resolved name.
//
//  STREAM_BASE  where viewers watch  (player page + HLS). Can be proxied HTTPS.
//  RTMP_BASE    where streamers push (OBS). Must resolve straight to the origin.
//
// With neither set, the bases follow the host the viewer arrived on. Two cases:
//
//   arrived on :8080 (nothing in front)  ->  host:8888, MediaMTX's own port
//   arrived on :443 (a reverse proxy)    ->  same origin, no port added
//
// The second case is what a Cloudflare/nginx front does: it routes /live/* to
// MediaMTX on the same hostname, so bolting :8888 on would break it.

const STREAM_PORT = Number(process.env.STREAM_PORT) || 8888;
const RTMP_PORT = Number(process.env.RTMP_PORT) || 1935;
const FORCED_STREAM_BASE = (process.env.STREAM_BASE || '').replace(/\/+$/, '');
const FORCED_RTMP_BASE = (process.env.RTMP_BASE || '').replace(/\/+$/, '');

/** The Host header exactly as sent, IPv6 literal kept intact. */
function rawHost(req) {
    return String((req && typeof req.get === 'function' ? req.get('host') : '') || '').trim();
}

/** Host the viewer used, minus the port. IPv6 brackets are kept. */
function browserHost(req) {
    const raw = rawHost(req);
    const close = raw.lastIndexOf(']');
    if (close !== -1) return raw.slice(0, close + 1);
    return raw.replace(/:\d+$/, '');
}

/** True when the viewer reached us on the default port for the scheme. */
function onDefaultPort(req) {
    if (!req || typeof req.get !== 'function') return false;
    const raw = rawHost(req);
    if (raw.indexOf(']') !== -1) return true;          // IPv6 literal, no port
    const colon = raw.lastIndexOf(':');
    if (colon === -1) return true;                       // :80 or :443 implied
    const port = Number(raw.slice(colon + 1));
    if (!Number.isInteger(port)) return true;
    return req.protocol === 'https' ? port === 443 : port === 80;
}

function streamBaseFor(req) {
    if (FORCED_STREAM_BASE) return FORCED_STREAM_BASE;
    const raw = rawHost(req);
    const host = browserHost(req);
    if (!host) return `http://127.0.0.1:${STREAM_PORT}`;
    const https = !!(req && req.protocol === 'https');

    // https means a TLS terminator sits in front, and that same proxy serves
    // MediaMTX - reuse the viewer's exact origin, port and all.
    if (https) return 'https://' + raw;

    // plain http on a normal port is also a proxy in front of us
    if (onDefaultPort(req)) return 'http://' + host;

    // Straight at this app on a custom port with no proxy: MediaMTX listens on
    // its own port, so say so.
    return `http://${host}:${STREAM_PORT}`;
}

function rtmpBaseFor(req) {
    if (FORCED_RTMP_BASE) return FORCED_RTMP_BASE;
    const host = FORCED_STREAM_BASE
        ? FORCED_STREAM_BASE.replace(/^https?:\/\//i, '').split(':')[0]
        : browserHost(req);
    return `rtmp://${host || '127.0.0.1'}:${RTMP_PORT}/live`;
}

// --------------------------------------------------------- live path lookup
//
// A streamer's real path is whatever they put in their Stream Key box. Paste
// the bare secret and it lands at live/<secret>; paste "room?key=..." and it
// lands at live/<room>. The chat page only knows the room name, so ask
// MediaMTX what is actually live rather than guessing - otherwise the viewer
// is told to open live/<room>, which does not exist, and the player says
// "stream not found".

const MTX_API = (process.env.MTX_API || 'http://127.0.0.1:9997').replace(/\/+$/, '');
const LIVE_PATH_TTL = 2000;
let livePathCache = { at: 0, paths: null };

async function fetchLivePaths() {
    if (livePathCache.paths && Date.now() - livePathCache.at < LIVE_PATH_TTL) {
        return livePathCache.paths;
    }
    let paths = [];
    try {
        const res = await fetch(MTX_API + '/v3/paths/list', {
            signal: AbortSignal.timeout(1500)
        });
        if (res.ok) {
            const body = await res.json();
            if (Array.isArray(body.items)) {
                paths = body.items
                    .filter((p) => p && p.name && p.ready)
                    .map((p) => String(p.name).replace(/^\/+|\/+$/g, ''));
            }
        }
    } catch (e) {
        // MediaMTX not up / API disabled - the caller falls back to live/<room>.
    }
    livePathCache = { at: Date.now(), paths };
    return paths;
}

/**
 * Given a room name, find the MediaMTX path a viewer should actually load.
 * Pure, so it can be tested without a MediaMTX around.
 *
 * @param {string} room
 * @param {string[]} livePaths paths currently up, e.g. ['live/Kivi']
 * @param {Map<string,object>} bySecret key records indexed by secret
 * @returns {string} the path to load, falling back to `live/<room>`
 */
function matchLivePath(room, livePaths, bySecret) {
    const fallback = 'live/' + room;
    if (!room || !Array.isArray(livePaths) || livePaths.length === 0) return fallback;

    const wanted = 'live/' + room;
    if (livePaths.includes(wanted)) return wanted;

    // The streamer pasted the bare secret, so the path ends in that secret.
    // Match it back to the room the key is bound to.
    for (const path of livePaths) {
        const tail = path.slice(path.lastIndexOf('/') + 1);
        if (tail === room) return path;
        const key = bySecret && bySecret.get(tail);
        if (key && key.stream === room) return path;
    }

    // A wildcard key tells us nothing about the room, so if exactly one thing
    // is live and the room matches nothing, still prefer the plain path.
    return fallback;
}

/** The path a viewer should load for `room`, resolved against MediaMTX. */
async function livePathFor(room) {
    const paths = await fetchLivePaths();
    return matchLivePath(room, paths, state.bySecret);
}

/**
 * Is anything actually being published for this room?
 *
 * Deliberately answered from MediaMTX's own path list rather than by fetching
 * the playlist URL: MediaMTX answers 302 into its HLS session handshake whether
 * or not a stream exists, so an HTTP probe reports "live" for an empty room.
 *
 * @returns {Promise<{room: string, path: string, live: boolean}>}
 */
async function liveStatusFor(room) {
    const paths = await fetchLivePaths();
    const path = matchLivePath(room, paths, state.bySecret);
    return { room, path, live: paths.includes(path) };
}

/**
 * `authHTTPAddress` handler - the current MediaMTX authorization API.
 *
 * MediaMTX POSTs every action it is about to perform and expects 20x to allow
 * it. Only `publish` is gated; anything else (read, playback, api, ...) is
 * answered 200 so viewers are never locked out. The generated mediamtx.yml
 * additionally sets authHTTPExclude for the non-publish actions, so a chat
 * server outage cannot take viewing down with it.
 */
router.all('/mediamtx/auth', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = clean(authField(body, 'action') || req.query.action, 24);
    const path = clean(authField(body, 'path') || req.query.path, 200);
    const query = authField(body, 'query') || (typeof req.query.query === 'string' ? req.query.query : '');
    const ip = clean(authField(body, 'ip') || req.query.ip, 64);
    const protocol = clean(authField(body, 'protocol') || req.query.protocol, 16);
    const sessionId = clean(authField(body, 'id') || req.query.id, 64);

    // Anything that is not a publish is not our business.
    if (action !== 'publish') {
        return res.status(200).json({ ok: true });
    }

    let room = roomFromPath(path);
    let secret = extractSecret(query);
    let viaBareKey = false;

    // Streamers overwhelmingly paste the secret straight into the Stream Key
    // box, so MediaMTX hands us the key where the room should be. Accept that
    // too: the key is still a secret that still has to validate, this just
    // removes the single most common reason a correct key gets rejected.
    if (!secret && state.bySecret.has(room)) {
        const byPath = state.bySecret.get(room);
        secret = room;
        viaBareKey = true;
        // Fall back to the room the key is bound to. MediaMTX has already
        // chosen the real path by this point, so this only affects logging and
        // the live-path hint below - the stream still lands at whatever path
        // the streamer actually asked for.
        if (byPath.stream && byPath.stream !== ANY_STREAM) room = byPath.stream;
    }

    const result = authorizePublish(room, secret);

    if (!result.ok) {
        clearLive(sessionId, room, ip);
        let hint = '';
        // Most rejections are an OBS Stream Key box holding only the secret.
        // Spell out what was expected instead of just "rejected".
        if (!secret) {
            hint = ' - the stream key must be "<room>?key=<the key>", not just the key';
        } else if (result.reason === 'unknown stream key') {
            hint = ' - check for a trailing space or a truncated copy';
        }
        console.log('[mediamtx] REJECT publish "' + (room || '?') + '" from ' + (ip || '?') + ': ' + result.reason + hint);
        return res.status(401).json({ ok: false, error: result.reason });
    }

    markLive(result.key.id, room, ip, protocol, sessionId);
    let extra = '';
    if (viaBareKey) {
        // The stream really landed at the path the streamer typed, so tell
        // them what to give viewers - and how to get a clean room name.
        const landed = path.replace(/^\/+|\/+$/g, '');
        extra = ' [used as the path: viewers open /' + landed +
                '/ - send "<room>?key=<key>" instead for a tidy URL]';
    }
    console.log('[mediamtx] allowed publish "' + (room || '?') + '" via key "' + result.key.label + '" from ' + (ip || '?') + ' [' + (protocol || '?') + ']' + extra);
    res.status(200).json({ ok: true, user: result.key.label });
});

// -------------------------------------------------------------------- legacy
// MediaMTX <= 0.21 URL hooks. Kept so an older binary still enforces keys;
// MediaMTX >= 1.0 dropped `globalHooks` and will not start with it in the
// config, which is why install.sh generates `authHTTPAddress` instead.

router.all(HOOK_RE, (req, res) => {
    const action = req.path.split('/').pop();
    const { stream, query, ip, protocol } = hookParams(req);

    if (HOOK_IGNORE.has(action)) return res.status(200).json({ ok: true });

    if (HOOK_RELEASE.has(action)) {
        clearLive(null, roomFromPath(stream), ip);
        console.log('[mediamtx] publish stopped: ' + (roomFromPath(stream) || '?') + ' from ' + (ip || '?'));
        return res.status(200).json({ ok: true });
    }

    if (HOOK_GATE.has(action)) {
        const room = roomFromPath(stream);
        const secret = extractSecret(query);
        const result = authorizePublish(room, secret);
        if (!result.ok) {
            console.log('[mediamtx] REJECT publish "' + (room || '?') + '" from ' + (ip || '?') + ': ' + result.reason);
            return res.status(403).json({ ok: false, error: result.reason });
        }
        markLive(result.key.id, room, ip, protocol);
        console.log('[mediamtx] allowed publish "' + (room || '?') + '" via key "' + result.key.label + '" from ' + (ip || '?'));
        return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------- admin UI
//
// Served from admin/ at the secret path only. It is deliberately NOT in
// public/, so nothing static can reach it and the public site does not
// advertise it. Every /admin* path that is not the real one falls through to
// a 404.

const ADMIN_UI_HTML = path.join(ADMIN_UI_DIR, 'index.html');
const ADMIN_UI_JS = path.join(ADMIN_UI_DIR, 'admin.js');
let adminHtmlCache = null;

/**
 * The page loads admin.js by a path we fill in here rather than a relative
 * "admin.js". A relative URL only resolves correctly if the browser is on a
 * trailing-slash URL; without it the browser asks for /admin.js, gets a 404,
 * and the login form silently does nothing.
 */
function adminIndexHtml(adminPath) {
    if (adminHtmlCache === null) {
        try {
            adminHtmlCache = fs.readFileSync(ADMIN_UI_HTML, 'utf8');
        } catch (e) {
            adminHtmlCache = '';
        }
    }
    return adminHtmlCache.replace(
        /(src|href)="admin\.js"/g,
        '$1="' + adminPath + '/admin.js"'
    );
}

router.get(/^\/admin-[A-Za-z0-9._~-]+$/, (req, res) => {
    const target = adminPath();
    if (req.path !== target) return res.status(404).end();
    // Keep the trailing slash so relative URLs on the page resolve the way a
    // reader expects, whatever gets bookmarked.
    res.redirect(302, target + '/');
});

router.get(/^\/admin-[A-Za-z0-9._~-]+\/$/, (req, res) => {
    const target = adminPath();
    if (req.path.replace(/\/$/, '') !== target) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.type('html').send(adminIndexHtml(target));
});

router.get(/^\/admin-[A-Za-z0-9._~-]+\/admin\.js$/, (req, res) => {
    const target = adminPath();
    if (req.path.replace(/\/admin\.js$/, '') !== target) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(ADMIN_UI_JS, (err) => {
        if (err) res.status(404).end();
    });
});

router.post('/api/admin/login', (req, res) => {

    if (!passwordMatches(req.body && req.body.password)) {
        return res.status(401).json({ error: 'Wrong password' });
    }
    res.json(createSession());
});

router.get('/api/admin/session', requireAdmin, (req, res) => {
    res.json({ ok: true });
});

router.post('/api/admin/logout', requireAdmin, (req, res) => {
    state.sessions.delete(tokenFrom(req));
    res.json({ ok: true });
});

router.get('/api/admin/keys', requireAdmin, (req, res) => {
    res.json({ keys: state.keys.map(publicKey) });
});

router.post('/api/admin/keys', requireAdmin, (req, res) => {
    const result = createKey(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.status(201).json(publicKey(result.key));
});

router.patch('/api/admin/keys/:id', requireAdmin, (req, res) => {
    const result = updateKey(req.params.id, req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(publicKey(result.key));
});

router.delete('/api/admin/keys/:id', requireAdmin, (req, res) => {
    const result = deleteKey(req.params.id);
    if (result.error) return res.status(404).json(result);
    res.json({ ok: true });
});

/**
 * The mediamtx.yml block that turns on key enforcement.
 *
 * `authMethod: http` + `authHTTPAddress` is the API MediaMTX v1.x supports.
 * The old `globalHooks: runOnInit: "http://..."` form was REMOVED - MediaMTX
 * refuses to start with `unknown field "globalHooks"`.
 *
 * Every non-publish action is excluded so viewers keep working even if the
 * chat server is down; only `publish` is gated, and it fails closed.
 */
function mediamtxSnippet(base) {
    return [
        '# --- add these to your mediamtx.yml ---',
        '# Stream keys are validated by the chat server on every publish.',
        '# Viewing is never gated (see authHTTPExclude below).',
        '',
        'authMethod: http',
        'authHTTPAddress: "' + base + '/mediamtx/auth"',
        '',
        '# Only publishing is gated. Everything else is always allowed, so',
        '# viewers keep working even if the chat server is down.',
        'authHTTPExclude:',
        '  - action: read',
        '  - action: playback',
        '  - action: api',
        '  - action: metrics',
        '  - action: pprof',
        '',
        '# Any room may be published to; the stream key decides who may.',
        'paths:',
        '  all_others:',
        '    source: publisher',
        '',
        '# then: systemctl restart mediamtx'
    ].join('\n');
}

router.get('/api/admin/config', requireAdmin, (req, res) => {
    // port comes from the server, not the raw env var: it may have been
    // resolved from a fallback, or be 0 (random port)
    const port = listenPort || Number(process.env.PORT) || 8080;
    const base = 'http://127.0.0.1:' + port;
    res.json({
        port,
        hookBaseUrl: base,
        authPath: '/mediamtx/auth',
        // The OBS snippet the streamer needs is written from the browser's
        // point of view, otherwise the admin would copy a 127.0.0.1 URL to
        // someone standing at a different machine.
        streamBase: streamBaseFor(req),
        rtmpBase: rtmpBaseFor(req),
        activeKeys: state.keys.filter(isActive).length,
        // install.sh writes this file for you; this is for people running
        // MediaMTX somewhere else entirely.
        snippet: mediamtxSnippet(base)
    });
});

load();
const cleanupTimer = setInterval(cleanup, 60000);
cleanupTimer.unref();

module.exports = {
    router,
    activeKeyCount: () => state.keys.filter(isActive).length,
    /** Called by install scripts so the operator sees the password without guessing. */
    ensurePassword: adminPassword,
    /** Same, for the secret admin URL - created once, then reused. */
    ensureAdminPath: adminPath,
    /** Called by server.js with the resolved listen port. */
    setPort: (port) => { listenPort = port; },
    /** install.sh writes config/mediamtx.yml from this, so the file on disk and
     *  the snippet in the admin panel can never drift apart. */
    mediamtxSnippet,
    roomFromPath,
    /** Video URLs must be built from the requesting browser's point of view. */
    streamBaseFor,
    rtmpBaseFor,
    /** The MediaMTX path a viewer should load for a room (handles the bare-key
     *  form, where the live path is not named after the room). */
    livePathFor,
    liveStatusFor,
    matchLivePath,
    authorizePublish
};
