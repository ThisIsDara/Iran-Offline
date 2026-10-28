'use strict';

/* ============================================================== state */

const TOKEN_KEY = 'adminToken';
let token = sessionStorage.getItem(TOKEN_KEY) || '';
let keys = [];
// RTMP ingest URL, filled in from /api/admin/config so the OBS snippet we hand
// out matches what the streamer can actually reach.
let rtmpBase = 'rtmp://YOUR_SERVER:1935/live';

/** The exact two OBS fields for a given room + secret. */
function obsSettings(room, secret) {
    return 'Server:     ' + rtmpBase + '\n' +
           'Stream Key: ' + room + '?key=' + secret;
}
let pollTimer = null;
let toastTimer = null;

const el = {};

/* ============================================================== helpers */

function cacheDom() {
    [
        'login-view', 'login-form', 'password-input', 'login-error', 'dash-view',
        'stat-active', 'stat-live', 'stat-total', 'stat-streams', 'enforcement-note',
        'keys-body', 'keys-empty', 'new-key-btn', 'refresh-btn', 'logout-btn',
        'mtx-snippet', 'obs-server', 'key-dialog', 'key-form', 'cancel-btn', 'form-error',
        'f-label', 'f-stream', 'f-expiry', 'f-note', 'error-toast'
    ].forEach((id) => { el[id] = document.getElementById(id); });
}

function toast(message, kind) {
    const box = el['error-toast'];
    box.textContent = message;
    box.classList.toggle('info', kind === 'info');
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
}

async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options);
    opts.headers['Content-Type'] = 'application/json';
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;

    const response = await fetch(path, opts);
    let body = null;
    try {
        body = await response.json();
    } catch (e) {
        body = null;
    }

    if (response.status === 401) {
        token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        showLogin();
        throw new Error((body && body.error) || 'Session expired');
    }
    if (!response.ok) throw new Error((body && body.error) || 'Request failed');
    return body;
}

function formatDate(ms) {
    if (!ms) return 'never';
    const date = new Date(ms);
    if (isNaN(date.getTime())) return 'never';
    const days = Math.ceil((ms - Date.now()) / 86400000);
    const relative = days <= 0 ? 'expired' : days === 1 ? '1 day' : days + ' days';
    return date.toLocaleDateString() + ' (' + relative + ')';
}

function copyText(text, label) {
    const done = () => toast((label || 'Copied') + ': ' + text, 'info');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
        fallbackCopy(text, done);
    }
}

function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
        document.execCommand('copy');
        done();
    } catch (e) {
        toast('Copy failed — select the text manually', 'info');
    }
    document.body.removeChild(area);
}

/* ============================================================== views */

function showLogin() {
    clearInterval(pollTimer);
    el['dash-view'].classList.add('hidden');
    el['login-view'].classList.remove('hidden');
    el['password-input'].value = '';
    el['password-input'].focus();
}

function showDashboard() {
    el['login-view'].classList.add('hidden');
    el['dash-view'].classList.remove('hidden');
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 5000);
}

/* ============================================================== render */

function renderStats() {
    const active = keys.filter((k) => k.active).length;
    const live = keys.filter((k) => k.live > 0).length;
    const rooms = new Set(keys.filter((k) => k.active).map((k) => k.stream));

    el['stat-active'].textContent = active;
    el['stat-live'].textContent = live;
    el['stat-total'].textContent = keys.length;
    el['stat-streams'].textContent = rooms.size;

    const note = el['enforcement-note'];
    if (active === 0) {
        note.innerHTML = '<span style="color:#ef4444">No active keys.</span> MediaMTX will reject every publish attempt — nobody can stream until you create one.';
    } else {
        note.textContent = 'Publishes are validated by the chat server on every stream start. Revoking a key takes effect the next time that streamer connects.';
    }
}

function renderKeys() {
    const body = el['keys-body'];
    body.replaceChildren(...keys.map(renderRow));
    el['keys-empty'].classList.toggle('hidden', keys.length > 0);
}

function renderRow(key) {
    const row = document.createElement('tr');

    const nameCell = cell(key.label || '(unnamed)', 'sub-note');
    if (key.note) {
        const note = document.createElement('small');
        note.textContent = key.note;
        nameCell.appendChild(note);
    }

    row.append(
        nameCell,
        cell(key.stream === '*' ? 'any room' : key.stream, 'mono'),
        secretCell(key),
        statusCell(key),
        cell(formatDate(key.expiresAt), 'muted'),
        actionCell(key)
    );
    return row;
}

function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
}

function secretCell(key) {
    const td = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'secret-cell';

    const code = document.createElement('code');
    code.textContent = key.secret.slice(0, 10) + '…' + key.secret.slice(-4);
    code.title = key.secret;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn small';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => copyText(key.secret, 'Stream key copied'));

    // Hand over the two OBS fields filled in. The single most common support
    // call is a streamer pasting only the secret into the Stream Key box,
    // which MediaMTX then treats as the room name and the publish is rejected.
    const obsBtn = document.createElement('button');
    obsBtn.className = 'btn small';
    obsBtn.textContent = 'Copy OBS setup';
    obsBtn.title = 'Server + Stream Key, ready to paste';
    obsBtn.addEventListener('click', () => {
        const room = key.stream === '*' ? 'ROOM' : key.stream;
        copyText(obsSettings(room, key.secret), 'OBS settings copied - paste into OBS');
    });

    const revealBtn = document.createElement('button');
    revealBtn.className = 'btn small';
    revealBtn.textContent = 'Show';
    revealBtn.addEventListener('click', () => {
        const hidden = code.textContent.includes('…');
        code.textContent = hidden ? key.secret : key.secret.slice(0, 10) + '…' + key.secret.slice(-4);
        revealBtn.textContent = hidden ? 'Hide' : 'Show';
    });

    wrap.append(code, revealBtn, copyBtn, obsBtn);
    td.appendChild(wrap);
    return td;
}

function statusCell(key) {
    const td = document.createElement('td');
    const pill = document.createElement('span');

    if (!key.active) {
        pill.className = 'pill ' + (key.revokedAt ? 'revoked' : 'expired');
        pill.textContent = key.revokedAt ? 'REVOKED' : 'EXPIRED';
    } else {
        pill.className = 'pill active';
        pill.textContent = 'ACTIVE';
    }
    td.appendChild(pill);

    if (key.live > 0) {
        const live = document.createElement('span');
        live.className = 'pill live';
        live.textContent = 'LIVE';
        // A revoked key cannot start a new publish, but MediaMTX only asks us
        // for permission when a stream starts - there is no way to cut an
        // in-flight one. Say so rather than implying the stream is dead.
        if (key.revokedAt || key.active === false) live.title =
            'Still connected. MediaMTX checks a key when a stream starts, so this one runs until the streamer stops it.';
        td.appendChild(live);
    }
    return td;
}

function actionCell(key) {
    const td = document.createElement('td');
    td.style.textAlign = 'right';
    td.style.whiteSpace = 'nowrap';

    if (key.revokedAt) {
        td.appendChild(actionButton('Restore', 'btn small', async () => {
            await mutate(key.id, { revoked: false }, 'Key restored');
        }));
    } else {
        td.appendChild(actionButton('Revoke', 'btn small danger', async () => {
            const extra = key.live > 0
                ? '\n\nThis key is LIVE right now. It cannot reconnect, but the\ncurrent stream keeps running - MediaMTX only asks permission\nwhen a stream starts, so the streamer has to stop it themselves.'
                : '';
            if (!confirm('Revoke this key?\n\n' + key.label + ' cannot reconnect or start a new stream.' + extra)) return;
            await mutate(key.id, { revoked: true }, 'Key revoked');
        }));
    }

    td.appendChild(actionButton('Delete', 'btn small danger', async () => {
        if (!confirm('Permanently delete this key? This cannot be undone.')) return;
        try {
            await api('/api/admin/keys/' + encodeURIComponent(key.id), { method: 'DELETE' });
            toast('Key deleted');
            refresh();
        } catch (err) {
            toast(err.message);
        }
    }));

    return td;
}

function actionButton(label, className, onClick) {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.style.marginLeft = '6px';
    button.addEventListener('click', () => {
        button.disabled = true;
        onClick().catch((err) => toast(err.message)).finally(() => { button.disabled = false; });
    });
    return button;
}

async function mutate(id, body, successMessage) {
    await api('/api/admin/keys/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) });
    toast(successMessage);
    refresh();
}

/* ============================================================== data */

async function refresh() {
    try {
        const [list, config] = await Promise.all([
            api('/api/admin/keys'),
            api('/api/admin/config')
        ]);
        keys = list.keys;
        // The server knows both: viewers use a proxied HTTPS host, streamers
        // must use a host that resolves straight to the origin, so never
        // derive one from the other.
        rtmpBase = config.rtmpBase || (config.streamBase
            ? config.streamBase.replace(/^https?:\/\//, '') + ':1935/live'
            : 'rtmp://YOUR_SERVER:1935/live');
        renderStats();
        renderKeys();
        el['mtx-snippet'].textContent = config.snippet;
        el['obs-server'].textContent = rtmpBase;
    } catch (e) {
        if (e.message && e.message !== 'Session expired') toast(e.message);
    }
}

/* ============================================================== wiring */

function initLogin() {
    el['login-form'].addEventListener('submit', async (event) => {
        event.preventDefault();
        el['login-error'].textContent = '';
        try {
            const result = await api('/api/admin/login', {
                method: 'POST',
                body: JSON.stringify({ password: el['password-input'].value })
            });
            token = result.token;
            sessionStorage.setItem(TOKEN_KEY, token);
            showDashboard();
        } catch (err) {
            el['login-error'].textContent = err.message;
        }
    });
}

/** Mirrors the server's rules so a mistake is caught before the round-trip. */
function validateKeyForm(label, stream) {
    if (!label.trim()) return { field: 'f-label', error: 'Streamer name is required - who is this key for?' };
    if (!stream.trim()) {
        return { field: 'f-stream', error: 'Room / stream name is required. Enter a room name, or * to allow any room.' };
    }
    if (!/^\*$|^[A-Za-z0-9._-]{1,64}$/.test(stream.trim())) {
        return { field: 'f-stream', error: 'Room / stream name may only contain letters, numbers, dot, dash and underscore (or * for any room).' };
    }
    return null;
}

function initDialog() {
    el['new-key-btn'].addEventListener('click', () => {
        el['form-error'].textContent = '';
        el['key-form'].reset();
        el['key-dialog'].showModal();
        el['f-label'].focus();
    });

    el['cancel-btn'].addEventListener('click', () => el['key-dialog'].close());

    el['key-form'].addEventListener('submit', async (event) => {
        event.preventDefault();
        el['form-error'].textContent = '';

        const payload = {
            label: el['f-label'].value,
            stream: el['f-stream'].value,
            expiresAt: el['f-expiry'].value,
            note: el['f-note'].value
        };

        const problem = validateKeyForm(payload.label, payload.stream);
        if (problem) {
            el['form-error'].textContent = problem.error;
            el[problem.field].focus();
            return;
        }

        try {
            const created = await api('/api/admin/keys', { method: 'POST', body: JSON.stringify(payload) });
            el['key-dialog'].close();
            toast('Key created for ' + created.label, 'info');
            copyText(created.secret, 'Send this key to ' + created.label);
            refresh();
        } catch (err) {
            el['form-error'].textContent = err.message;
        }
    });
}

function initDashboard() {
    el['refresh-btn'].addEventListener('click', refresh);

    el['logout-btn'].addEventListener('click', async () => {
        try {
            await api('/api/admin/logout', { method: 'POST' });
        } catch (e) { /* already invalid */ }
        token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        showLogin();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    cacheDom();
    initLogin();
    initDialog();
    initDashboard();

    if (!token) return showLogin();

    // validate the stored session before showing anything
    try {
        await api('/api/admin/session');
        showDashboard();
    } catch (e) {
        showLogin();
    }
});
