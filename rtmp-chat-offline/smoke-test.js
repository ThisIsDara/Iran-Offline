'use strict';
// Smoke test: admin API + MediaMTX publish gate + chat websocket.
// Boots its own server on port 8099 with a throwaway data dir.
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8099;
const BASE = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'test-pw-123';
const DATA_DIR = path.join(os.tmpdir(), 'rtmp-chat-smoke-' + process.pid);

let token = '';
let server;

async function req(method, urlPath, body) {
    const res = await fetch(BASE + urlPath, {
        method,
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            token ? { Authorization: 'Bearer ' + token } : {}
        ),
        body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
}

const hook = (params) => fetch(BASE + '/mediamtx/hooks/publish/on_init?' + new URLSearchParams(params))
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

/** The authHTTPAddress call MediaMTX 1.x makes before every action. */
const auth = (payload) => fetch(BASE + '/mediamtx/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

/** A realistic MediaMTX auth payload, as captured from a real publish. */
const publish = (path, query, id) => auth({
    ip: '203.0.113.7',
    user: '',
    password: '',
    token: '',
    action: 'publish',
    path,
    protocol: 'rtmp',
    id: id || 'session-' + Math.random().toString(36).slice(2),
    query,
    userAgent: 'FMLE/3.0'
});

function boot() {
    return new Promise((resolve, reject) => {
        server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
            env: Object.assign({}, process.env, {
                PORT: String(PORT),
                ADMIN_PASSWORD: PASSWORD,
                ADMIN_PATH: process.env.ADMIN_PATH || 'admin-test-secret',
                DATA_DIR
            }),
            stdio: ['ignore', 'pipe', 'inherit']
        });
        server.stdout.once('data', () => resolve());
        server.once('error', reject);
        setTimeout(() => reject(new Error('server did not start in time')), 8000).unref();
    });
}

function shutdown() {
    if (server) server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

(async () => {
    await boot();

    // ---- the admin UI must not be discoverable from the public site
    const adminPath = process.env.ADMIN_PATH || null;

    const home = await fetch(BASE + '/');
    assert.strictEqual(home.status, 200, 'chat page still served');
    const homeHtml = await home.text();
    assert.ok(!/admin/i.test(homeHtml), 'chat page does not mention the admin panel at all');

    // ---- health + security headers
    const health = await fetch(BASE + '/healthz');
    assert.strictEqual(health.status, 200, 'health endpoint answers');
    assert.strictEqual(health.headers.get('cache-control'), 'no-store', 'health is not cached');
    const healthJson = await health.json();
    assert.strictEqual(healthJson.ok, true, 'health reports ok');
    assert.ok(!('password' in healthJson) && !('data' in healthJson), 'health leaks no secrets');

    const csp = home.headers.get('content-security-policy') || '';
    assert.ok(/default-src 'self'/.test(csp), 'CSP restricts default-src, got: ' + csp);
    assert.ok(/object-src 'none'/.test(csp), 'CSP blocks plugins');
    assert.ok(!/unsafe-eval/.test(csp), 'CSP does not allow eval');
    assert.strictEqual(home.headers.get('x-content-type-options'), 'nosniff', 'nosniff header');
    assert.strictEqual(home.headers.get('referrer-policy'), 'no-referrer', 'referrer policy');
    assert.ok(home.headers.get('x-frame-options'), 'frame protection header');
    assert.strictEqual(home.headers.get('x-powered-by'), null, 'x-powered-by is off');

    // No public/admin file may point at a CDN, web font or remote script.
    const uiOffenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else {
                const text = fs.readFileSync(full, 'utf8');
                if (/https?:\/\/|@import|(?:src|href)=["'](?:https?:)?\/\//i.test(text)) {
                    uiOffenders.push(path.relative(__dirname, full));
                }
            }
        }
    };
    walk(path.join(__dirname, 'public'));
    walk(path.join(__dirname, 'admin'));
    assert.deepStrictEqual(uiOffenders, [], 'UI has no external assets: ' + uiOffenders.join(', '));

    // the old guessable locations must be gone, whatever the admin path is
    for (const guess of ['/admin.html', '/admin.js', '/admin', '/admin/', '/public/admin.html']) {
        const res = await fetch(BASE + guess);
        assert.ok(res.status === 404, 'guessed admin path ' + guess + ' is 404, got ' + res.status);
    }
    // nothing from admin/ is reachable through the static folder
    assert.strictEqual((await fetch(BASE + '/index.html')).status, 200, 'chat index.html still served');
    assert.strictEqual((await fetch(BASE + '/admin/index.html')).status, 404, 'admin/ dir not exposed');

    if (adminPath) {
        // Visiting the URL WITHOUT a trailing slash is what a bookmark bar
        // produces, and a relative <script src="admin.js"> then resolves to
        // /admin.js - a 404 - leaving the login form dead. Assert the redirect.
        const bare = await fetch(BASE + adminPath, { redirect: 'manual' });
        assert.ok([301, 302, 307, 308].includes(bare.status),
            'admin URL redirects to the trailing-slash form, got ' + bare.status);
        assert.ok(String(bare.headers.get('location') || '').endsWith('/'),
            'redirect target keeps the trailing slash, got ' + bare.headers.get('location'));

        const ui = await fetch(BASE + adminPath + '/');
        assert.strictEqual(ui.status, 200, 'admin UI served at ADMIN_PATH, got ' + ui.status);
        assert.ok(/default-src 'self'/.test(ui.headers.get('content-security-policy') || ''),
            'admin UI gets the same CSP');
        assert.strictEqual(ui.headers.get('x-content-type-options'), 'nosniff', 'admin nosniff header');
        const uiHtml = await ui.text();
        assert.ok(/id="login-form"/.test(uiHtml), 'admin UI is the login page');

        // the script URL must be absolute so it cannot resolve to /admin.js
        assert.ok(uiHtml.includes('src="' + adminPath + '/admin.js"'),
            'admin.js is referenced absolutely, got: ' +
            (uiHtml.match(/<script[^>]*>/g) || []).join(','));

        const js = await fetch(BASE + adminPath + '/admin.js');
        assert.strictEqual(js.status, 200, 'admin.js served from the admin path, got ' + js.status);
        // a near-miss on the secret must not work
        assert.strictEqual((await fetch(BASE + adminPath + 'x')).status, 404, 'near-miss path is 404');
    }

    // ---- admin auth
    assert.strictEqual((await req('GET', '/api/admin/keys')).status, 401, 'keys must require auth');
    assert.strictEqual((await req('POST', '/api/admin/login', { password: 'wrong' })).status, 401, 'wrong password rejected');
    const login = await req('POST', '/api/admin/login', { password: PASSWORD });
    assert.strictEqual(login.status, 200, 'admin login');
    token = login.json.token;

    // ---- key creation + validation
    assert.strictEqual((await req('POST', '/api/admin/keys', { label: '', stream: 'arthas' })).status, 400, 'label required');
    assert.strictEqual((await req('POST', '/api/admin/keys', { label: 'x', stream: 'bad room!' })).status, 400, 'stream name sanitised');

    // The complaint has to name the field that is wrong, otherwise an empty
    // room reads like a malformed one.
    const noRoom = await req('POST', '/api/admin/keys', { label: 'Kibi', stream: '' });
    assert.strictEqual(noRoom.status, 400, 'empty room rejected');
    assert.ok(/required/i.test(noRoom.json.error), 'empty room says it is required, got: ' + noRoom.json.error);
    const blankRoom = await req('POST', '/api/admin/keys', { label: 'Kibi', stream: '   ' });
    assert.ok(/required/i.test(blankRoom.json.error), 'whitespace-only room says required, got: ' + blankRoom.json.error);
    const noName = await req('POST', '/api/admin/keys', { label: '   ', stream: 'arthas' });
    assert.ok(/streamer name/i.test(noName.json.error), 'empty streamer name names that field, got: ' + noName.json.error);
    const noStreamField = await req('POST', '/api/admin/keys', { label: 'Kibi' });
    assert.strictEqual(noStreamField.status, 400, 'missing room field rejected outright');

    // what the operator actually typed has to be accepted
    const kibi = await req('POST', '/api/admin/keys', { label: 'Kibi', stream: 'Kibi', expiresAt: 'never' });
    assert.strictEqual(kibi.status, 201, 'plain name in both fields is accepted, got: ' + JSON.stringify(kibi.json));
    const wildcard = await req('POST', '/api/admin/keys', { label: 'Kibi any', stream: '*', expiresAt: 'never' });
    assert.strictEqual(wildcard.status, 201, '"*" wildcard accepted, got: ' + JSON.stringify(wildcard.json));
    await req('DELETE', '/api/admin/keys/' + kibi.json.id);
    await req('DELETE', '/api/admin/keys/' + wildcard.json.id);

    const created = await req('POST', '/api/admin/keys', { label: 'Dara', stream: 'arthas', expiresAt: 'never' });
    assert.strictEqual(created.status, 201, 'create key');
    const key = created.json;
    assert.ok(key.secret.startsWith('sk_'), 'secret format');

    // ---- publish gate
    assert.strictEqual((await hook({ stream: 'arthas' })).status, 403, 'no key -> rejected');
    assert.strictEqual((await hook({ stream: 'arthas', query: '?key=sk_wrong' })).status, 403, 'bad key -> rejected');
    assert.strictEqual((await hook({ stream: 'otherroom', query: '?key=' + key.secret })).status, 403, 'key bound to another room -> rejected');
    assert.strictEqual((await hook({ stream: 'arthas', query: '?key=' + key.secret })).status, 200, 'valid key -> allowed');
    assert.strictEqual((await hook({ stream: 'arthas', query: 'key=' + key.secret })).status, 200, 'no leading ? -> allowed');
    assert.strictEqual((await hook({ stream: 'arthas', query: '?auth=' + key.secret })).status, 200, 'alt param name -> allowed');

    // live tracking shows up in the panel
    const liveList = await req('GET', '/api/admin/keys');
    assert.strictEqual(liveList.json.keys[0].live, 1, 'live publish counted');
    assert.strictEqual(liveList.json.keys[0].active, true, 'key active');

    // ---- revocation kills access immediately
    await req('PATCH', '/api/admin/keys/' + key.id, { revoked: true });
    assert.strictEqual((await hook({ stream: 'arthas', query: '?key=' + key.secret })).status, 403, 'revoked key -> rejected');
    await req('PATCH', '/api/admin/keys/' + key.id, { revoked: false });
    assert.strictEqual((await hook({ stream: 'arthas', query: '?key=' + key.secret })).status, 200, 'restored key -> allowed');

    // ---- expiry
    const shortLived = (await req('POST', '/api/admin/keys', { label: 'Temp', stream: 'arthas', expiresAt: 1 })).json;
    assert.strictEqual((await hook({ stream: 'arthas', query: '?key=' + shortLived.secret })).status, 200, 'days->expiry conversion allowed');
    const future = (await req('GET', '/api/admin/keys')).json.keys.find((k) => k.id === shortLived.id);
    assert.ok(future.expiresAt > Date.now(), 'expiry stored as future timestamp');
    assert.strictEqual(future.active, true, 'future expiry still active');
    // backdate it
    await req('PATCH', '/api/admin/keys/' + shortLived.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const backdated = (await req('GET', '/api/admin/keys')).json.keys.find((k) => k.id === shortLived.id);
    assert.strictEqual(backdated.active, false, 'past expiry -> inactive');
    assert.strictEqual((await hook({ stream: 'arthas', query: '?key=' + shortLived.secret })).status, 403, 'expired key -> rejected');

    // ---- MediaMTX 1.x auth endpoint (what actually gets called in production)
    //
    // MediaMTX asks authHTTPAddress before every action and rejects the client
    // on any non-2xx. Path arrives as "live/<room>" for an RTMP publish to
    // rtmp://host:1935/live/<room>, which has to be mapped back to "<room>".

    const sid = 'sess-allowed';
    assert.strictEqual((await publish('live/arthas', '', sid)).status, 401, 'auth: no key -> rejected');
    assert.strictEqual((await publish('live/arthas', 'key=sk_nope', sid)).status, 401, 'auth: unknown key -> rejected');
    assert.strictEqual((await publish('live/arthas', '?key=' + key.secret, sid)).status, 200,
        'auth: valid key -> allowed (leading ? tolerated)');
    assert.strictEqual((await publish('live/arthas', 'key=' + key.secret, sid)).status, 200,
        'auth: valid key -> allowed (MediaMTX sends no leading ?)');
    assert.strictEqual((await publish('live/otherroom', 'key=' + key.secret, sid)).status, 401,
        'auth: key bound to another room -> rejected');
    assert.strictEqual((await publish('otherroom', 'key=' + key.secret, sid)).status, 401,
        'auth: bare path still compared against the room');

    // room extraction strips only the known prefix, never a nested path
    const { roomFromPath } = require('./lib/stream-keys');
    assert.strictEqual(roomFromPath('live/arthas'), 'arthas', 'roomFromPath strips live/');
    assert.strictEqual(roomFromPath('arthas'), 'arthas', 'roomFromPath passes a bare room through');
    assert.strictEqual(roomFromPath('stream/arthas'), 'arthas', 'roomFromPath strips stream/');
    assert.strictEqual(roomFromPath('live/sub/arthas'), 'sub/arthas', 'roomFromPath keeps nested paths');
    assert.strictEqual(roomFromPath(''), '', 'roomFromPath tolerates empty');

    // viewers are never gated - read actions have no key at all
    assert.strictEqual((await auth({ action: 'read', path: 'live/arthas', query: '', ip: '1.2.3.4' })).status, 200,
        'auth: read -> allowed without a key');
    assert.strictEqual((await auth({ action: 'playback', path: 'live/arthas', query: '' })).status, 200,
        'auth: playback -> allowed without a key');
    assert.strictEqual((await auth({ action: 'api', path: '' })).status, 200, 'auth: api -> allowed');

    // live counter follows the MediaMTX session id
    const liveAfter = await req('GET', '/api/admin/keys');
    const arthasKey = liveAfter.json.keys.find((k) => k.id === key.id);
    assert.ok(arthasKey.live >= 1, 'auth: session shows as live in the panel, got ' + arthasKey.live);

    // a second publisher on the same room is a distinct session
    assert.strictEqual((await publish('live/arthas', 'key=' + key.secret, 'sess-second')).status, 200,
        'auth: second publisher on the same room allowed');
    const liveBoth = await req('GET', '/api/admin/keys');
    assert.strictEqual(liveBoth.json.keys.find((k) => k.id === key.id).live, 2,
        'auth: two distinct sessions counted separately');

    // Streamers habitually paste only the secret into the Stream Key box, so
    // MediaMTX reports it as the path. That has to work too - the key is still
    // validated, it is just read from a different place.
    const bare = await publish('live/' + key.secret, '', 'sess-bare');
    assert.strictEqual(bare.status, 200, 'bare secret as the stream key is accepted, got: ' + bare.status);

    // ...but only a real key is accepted that way; a random name still fails
    assert.strictEqual((await publish('live/sk_totally_made_up', '', 'sess-bare3')).status, 401,
        'a made-up path is still rejected when no key is supplied');

    // a wildcard key pasted bare still validates
    const star = (await req('POST', '/api/admin/keys', { label: 'Any', stream: '*', expiresAt: 'never' })).json;
    assert.strictEqual((await publish('live/' + star.secret, '', 'sess-star')).status, 200,
        'wildcard key pasted bare is accepted');

    // Revocation blocks new publishes. It cannot cut an in-flight stream:
    // MediaMTX only asks permission when a publish starts and its control API
    // has no way to disconnect a publisher. Asserted here so the behaviour is
    // pinned down rather than assumed.
    await req('PATCH', '/api/admin/keys/' + key.id, { revoked: true });
    assert.strictEqual((await publish('live/arthas', 'key=' + key.secret, 'sess-revoked')).status, 401,
        'auth: revoked key -> new publish rejected');
    await req('PATCH', '/api/admin/keys/' + key.id, { revoked: false });

    // the config snippet handed to the operator must be one MediaMTX accepts
    const cfg = await req('GET', '/api/admin/config');
    assert.strictEqual(cfg.status, 200, 'config endpoint');
    assert.ok(cfg.json.snippet.includes('authHTTPAddress'), 'snippet uses authHTTPAddress');
    assert.ok(!/globalHooks/.test(cfg.json.snippet),
        'snippet must not mention globalHooks - MediaMTX 1.x rejects it');
    assert.ok(!cfg.json.snippet.includes('/mediamtx/hooks/publish/'), 'snippet points at the auth endpoint');

    // ---- chat websocket
    const open = (name) => new Promise((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:' + PORT);
        ws.inbox = [];
        ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw)));
        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'join', stream: 'arthas', username: name, color: name === 'bad' ? 'red;}body{display:none' : '#4ECDC4' }));
            resolve(ws);
        });
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const alice = await open('alice');
    const bob = await open('bob');
    await wait(150);

    assert.ok(alice.inbox.some((m) => m.type === 'history'), 'history delivered');
    const users = alice.inbox.filter((m) => m.type === 'users').pop();
    assert.strictEqual(users.users.length, 2, 'two users in room');
    assert.strictEqual(users.users[0].color, '#4ECDC4', 'server keeps real color');

    // two tabs, same username -> both counted, no eviction
    const alice2 = await open('alice');
    await wait(150);
    assert.strictEqual(alice.inbox.filter((m) => m.type === 'users').pop().users.length, 3, 'duplicate username does not collide');

    // XSS: malicious color is replaced, not injected
    const evil = await open('bad');
    await wait(150);
    evil.send(JSON.stringify({ type: 'chat', message: '<img src=x onerror=alert(1)>' }));
    await wait(150);
    const got = alice.inbox.filter((m) => m.type === 'chat').pop();
    assert.ok(/^#[0-9a-f]{6}$/i.test(got.color), 'bad color replaced with safe default, got: ' + got.color);
    assert.ok(typeof got.ts === 'number', 'timestamp is epoch, not server-local string');

    // over-long message is truncated, not stored raw
    alice.send(JSON.stringify({ type: 'chat', message: 'x'.repeat(5000) }));
    await wait(150);
    const long = alice.inbox.filter((m) => m.type === 'chat').pop();
    assert.ok(long.message.length <= 500, 'message capped at 500, got ' + long.message.length);

    // rate limit: 2/sec
    alice.inbox.length = 0;
    for (let i = 0; i < 5; i++) alice.send(JSON.stringify({ type: 'chat', message: 'spam ' + i }));
    await wait(200);
    assert.ok(alice.inbox.filter((m) => m.type === 'error').length >= 1, 'rate limit triggers');
    assert.ok(alice.inbox.filter((m) => m.type === 'chat').length <= 3, 'rate limit blocks excess');

    // The chat page only knows the room name, but the live path is whatever the
    // streamer typed. Bare-secret publishers land on live/<secret>, so the
    // viewer has to be pointed at the path that is actually up.
    const { matchLivePath } = require('./lib/stream-keys');
    const bySecret = new Map([['sk_live1', { stream: 'arthas' }]]);
    assert.strictEqual(matchLivePath('arthas', [], bySecret), 'live/arthas',
        'nothing live -> fall back to the room path');
    assert.strictEqual(matchLivePath('arthas', ['live/arthas'], bySecret), 'live/arthas',
        'normal publisher -> exact match');
    assert.strictEqual(matchLivePath('arthas', ['live/arthas', 'live/other'], bySecret), 'live/arthas',
        'exact match wins over other live paths');
    assert.strictEqual(matchLivePath('arthas', ['live/sk_live1'], bySecret), 'live/sk_live1',
        'bare-secret publisher -> resolved to the secret path');
    assert.strictEqual(matchLivePath('arthas', ['live/sk_other', 'live/sk_live1'], bySecret), 'live/sk_live1',
        'bare-secret match picks the right one of several');
    assert.strictEqual(matchLivePath('nobody', ['live/sk_live1'], bySecret), 'live/nobody',
        'unrelated room still falls back rather than hijacking another path');
    assert.strictEqual(matchLivePath('sk_live1', ['live/sk_live1'], bySecret), 'live/sk_live1',
        'looking up by the secret itself works');
    assert.strictEqual(matchLivePath('arthas', ['Kivi'], bySecret), 'live/arthas',
        'an unrelated live path is never hijacked for another room');
    assert.strictEqual(matchLivePath('Kivi', ['Kivi'], bySecret), 'Kivi',
        'a prefix-less path is matched on its tail (rtmp://host:1935/Kivi)');

    // Liveness must come from MediaMTX's own path list. Probing the playlist
    // URL is wrong: MediaMTX answers 302 into its HLS session handshake
    // whether or not a stream exists, so that reports "live" for an empty room.
    const liveRoom = await req('GET', '/api/live?room=arthas');
    assert.strictEqual(liveRoom.status, 200, 'live endpoint responds');
    assert.strictEqual(liveRoom.json.room, 'arthas', 'live endpoint echoes the room');
    assert.strictEqual(liveRoom.json.path, 'live/arthas', 'falls back to the room path when idle');
    assert.strictEqual(liveRoom.json.live, false, 'nothing publishing in tests -> offline');

    const liveEvil = await req('GET', '/api/live?room=' + encodeURIComponent('../../etc'));
    assert.ok(!liveEvil.json.path.includes('..'), 'live endpoint sanitises the room, got ' + liveEvil.json.path);

    // stream-url injection
    const su = await req('GET', '/stream-url?name=' + encodeURIComponent('../../evil'));
    assert.ok(!su.json.hls.includes('..'), 'stream-url rejects traversal, got ' + su.json.hls);

    // The player iframe is rendered in the viewer's browser, so the video URL
    // must follow the host the viewer used. Pointing it at 127.0.0.1 makes
    // everyone watch their own empty machine.
    // (fetch cannot set Host - undici treats it as forbidden - so go raw.)
    const withHost = (hostHeader) => new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/stream-url?name=arthas', method: 'GET',
            headers: { Host: hostHeader }
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.end();
    });

    const viaIp = await withHost('203.0.113.9:8080');
    assert.strictEqual(viaIp.page, 'http://203.0.113.9:8888/live/arthas/',
        'player follows the viewer host, got ' + viaIp.page);
    assert.strictEqual(viaIp.rtmpBase, 'rtmp://203.0.113.9:1935/live',
        'obs url follows the viewer host, got ' + viaIp.rtmpBase);
    assert.ok(!viaIp.page.includes('127.0.0.1'), 'never hands a viewer a loopback URL');

    const viaHost = await withHost('chat.example.com:8080');
    assert.strictEqual(viaHost.page, 'http://chat.example.com:8888/live/arthas/',
        'works over a hostname with no config, got ' + viaHost.page);

    /** Pretend to be nginx: tell the app the viewer arrived over HTTPS. */
    const httpsTo = (base, path, hostHeader) => new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path, method: 'GET',
            headers: { Host: hostHeader, 'X-Forwarded-Proto': 'https' }
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.end();
    });

    // A Host header with no port means the viewer arrived on 80/443, i.e.
    // something is proxying, so the player link reuses that same origin.
    const noPort = await withHost('chat.example.com');
    assert.strictEqual(noPort.page, 'http://chat.example.com/live/arthas/',
        'a default-port request is treated as proxied, got ' + noPort.page);

    // ...and once nginx says it was HTTPS, the player link must not grow a port.
    // A reverse proxy routes /live/* to MediaMTX on the same origin, so
    // bolting :8888 on would point the player at a closed port.
    const tls = await httpsTo(BASE, '/stream-url?name=arthas', 'chat.example.com');
    assert.strictEqual(tls.page, 'https://chat.example.com/live/arthas/',
        'https through a proxy is portless, got ' + tls.page);
    assert.strictEqual(tls.hls, 'https://chat.example.com/live/arthas/index.m3u8',
        'hls is portless too, got ' + tls.hls);
    assert.ok(!tls.page.includes(':8888'), 'never leaves a MediaMTX port in a proxied url');

    const tls8443 = await httpsTo(BASE, '/stream-url?name=arthas', 'chat.example.com:8443');
    assert.strictEqual(tls8443.page, 'https://chat.example.com:8443/live/arthas/',
        'https on a custom port keeps that port, got ' + tls8443.page);

    const plain = await withHost('chat.example.com:8080');
    assert.strictEqual(plain.page, 'http://chat.example.com:8888/live/arthas/',
        "direct access on a custom port still gets MediaMTX's port appended, got " + plain.page);

    // the admin panel must hand streamers a reachable rtmp url too
    const cfg2 = await req('GET', '/api/admin/config');
    assert.ok(cfg2.json.rtmpBase && cfg2.json.rtmpBase.startsWith('rtmp://'),
        'admin config exposes an rtmpBase, got ' + cfg2.json.rtmpBase);

    // A CDN setup needs the two bases to differ: viewers may reach MediaMTX over
    // proxied HTTPS, but RTMP cannot be proxied, so streamers need their own
    // host that resolves straight to the origin.
    const cdn = await fetch(BASE + '/stream-url?name=arthas', {
        headers: { Host: 'chat.example.com' }
    }).then((r) => r.json()).catch(() => null);
    if (cdn) {
        // no env overrides in tests -> both derive from the viewer host
        assert.ok(cdn.rtmpBase.startsWith('rtmp://'), 'rtmp base present without overrides');
    }

    // close -> user list updates, no duplicate removal
    alice2.close();
    await wait(250);
    const remaining = bob.inbox.filter((m) => m.type === 'users').pop().users;
    assert.strictEqual(remaining.length, 3, 'close removes only that connection, got ' + remaining.length);
    assert.strictEqual(remaining.filter((u) => u.username === 'alice').length, 1, 'the other "alice" connection survives');

    [alice, bob, evil].forEach((ws) => ws.close());
    await wait(100);

    // delete works
    assert.strictEqual((await req('DELETE', '/api/admin/keys/' + key.id)).status, 200, 'delete key');

    console.log('\n  ALL CHECKS PASSED\n');
    shutdown();
    process.exit(0);
})().catch((err) => {
    console.error('\n  FAILED:', err.message);
    shutdown();
    process.exit(1);
});
