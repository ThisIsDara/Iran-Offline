'use strict';

/* ============================================================== constants */

const COLORS = [
    '#FF7A1A', '#FFB057', '#FFD166', '#4ECDC4', '#45B7D1',
    '#96CEB4', '#F7DC6F', '#BB8FCE', '#FF6B6B', '#85C1E9'
];

const EMOJI_MAP = {
    laugh: '😂', smile: '😄', love: '❤️', heart: '💖', cry: '😢', wow: '😮', cool: '😎',
    angry: '😠', fire: '🔥', thumbsup: '👍', thumbsdown: '👎', clap: '👏', party: '🎉',
    star: '⭐', eyes: '👀', brain: '🧠', skull: '💀', bomb: '💣', sword: '⚔️', shield: '🛡️',
    crown: '👑', gem: '💎', money: '💰', hundred: '💯', ok: '👌', peace: '✌️', rock: '🤘',
    wave: '👋', point: '👈', call: '📞', phone: '📱', computer: '💻', game: '🎮',
    music: '🎵', movie: '🎬', eyes2: '🤯', poop: '💩', ok2: '👌'
};

const EMOJI_CATEGORIES = {
    Smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '🙄', '😬', '🤯'],
    Gestures: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '✌️', '🤞', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '👊', '👛', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '💪'],
    Hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟'],
    Objects: ['💯', '🔥', '⭐', '🌟', '✨', '💫', '💥', '💢', '💦', '💨', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '📱', '💻', '⌨️', '🖱️', '💾', '💿', '📀', '📷', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '💩'],
    Symbols: ['🚩', '🏁', '✅', '❌', '❓', '❗', '💤', '🔔', '🔕', '📢', '📣', '💬', '💭', '🗯️', '♠️', '♣️', '♦️', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤']
};

const DEFAULT_COLOR = '#FF7A1A';
const RECONNECT_STEPS = [1000, 2000, 4000, 8000, 15000, 30000];
const LIVE_POLL_MS = 6000;
const LIVE_POLL_MS_OFFLINE = 5000;
const GROUP_WINDOW_MS = 5 * 60 * 1000;   // same person, consecutive, within 5m
const STREAM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

let username = '';
let userColor = COLORS[0];
let streamName = '';
let ws = null;
let wsReady = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let userPollTimer = null;
let livePollTimer = null;
let liveState = 'checking';
let onlineUsers = [];
let selectedEmojiIndex = 0;
let selectedUserIndex = 0;
let popoutWindow = null;
let unreadCount = 0;
let stickToBottom = true;
let lastAuthor = '';
let lastAuthorAt = 0;
let lastDayKey = '';
let intentionalClose = false;

const dom = {};
const LS = {
    username: 'ember.username',
    room: 'ember.room',
    color: 'ember.color',
    overlay: 'ember.overlay'
};

/* ============================================================== helpers */

function cacheDom() {
    const ids = [
        'login-modal', 'join-form', 'username-input', 'username-error',
        'stream-input', 'room-error', 'color-picker', 'join-btn', 'welcome-msg',
        'main-container', 'room-name', 'room-chip', 'live-pill', 'live-pill-text',
        'users-btn', 'user-count', 'users-popover', 'users-list', 'users-total',
        'popout-chat-btn', 'transparent-btn', 'fullscreen-btn', 'leave-btn',
        'video-container', 'player-skeleton', 'player-overlay', 'offline-title',
        'offline-text', 'offline-retry', 'refresh-btn', 'copy-link-btn', 'stream-hint',
        'chat-container', 'chat-form', 'chat-messages', 'chat-input', 'send-btn',
        'emoji-btn', 'emoji-picker', 'emoji-suggestions', 'autocomplete-dropdown',
        'scroll-bottom', 'unread-badge', 'char-counter', 'ws-status', 'ws-status-text',
        'toast-stack', 'overlay-exit'
    ];
    ids.forEach((id) => { dom[id] = document.getElementById(id); });
}

/** Plain text -> escaped HTML. Used before anything touches innerHTML. */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

/** Never inject a colour the server would not accept. */
function safeColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : DEFAULT_COLOR;
}

function formatTime(ts) {
    const date = typeof ts === 'number' ? new Date(ts) : new Date();
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(d.getTime()) === dayKey(today.getTime())) return 'Today';
    if (dayKey(d.getTime()) === dayKey(yesterday.getTime())) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---------------------------------------------------------------- toasts */

function toast(message, kind) {
    const stack = dom['toast-stack'];
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'info' ? ' info' : '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
        el.classList.add('is-out');
        setTimeout(() => el.remove(), 220);
    }, 3200);
    // never let the stack grow without bound
    while (stack.children.length > 4) stack.firstElementChild.remove();
}

/* ============================================================== join screen */

function initColorPicker() {
    const picker = dom['color-picker'];
    if (!picker) return;
    picker.replaceChildren();

    COLORS.forEach((color, index) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'color-option';
        option.style.backgroundColor = color;
        option.style.color = color;
        option.setAttribute('role', 'radio');
        option.setAttribute('aria-checked', index === 0 ? 'true' : 'false');
        option.setAttribute('aria-label', 'Colour ' + color);
        option.dataset.color = color;
        option.addEventListener('click', () => {
            picker.querySelectorAll('.color-option').forEach((el) => el.setAttribute('aria-checked', 'false'));
            option.setAttribute('aria-checked', 'true');
            userColor = color;
        });
        picker.appendChild(option);
    });
}

function restoreSavedProfile() {
    const savedUsername = localStorage.getItem(LS.username);
    const savedRoom = localStorage.getItem(LS.room);
    const savedColor = localStorage.getItem(LS.color);

    if (dom['username-input'] && savedUsername) dom['username-input'].value = savedUsername;
    if (dom['stream-input'] && savedRoom) dom['stream-input'].value = savedRoom;

    if (savedColor && COLORS.includes(savedColor)) {
        userColor = savedColor;
        dom['color-picker'].querySelectorAll('.color-option').forEach((el) => {
            el.setAttribute('aria-checked', el.dataset.color === savedColor ? 'true' : 'false');
        });
    }

    if (savedUsername && dom['welcome-msg']) {
        dom['welcome-msg'].textContent = 'Welcome back, ' + savedUsername;
        dom['welcome-msg'].classList.remove('hidden');
    }

    if (localStorage.getItem(LS.overlay) === '1') setOverlayMode(true, false);

    // Escape hatch for anyone who got stuck in overlay mode earlier:
    // loading the page with ?overlay=0 clears the stored preference.
    const overlayParam = new URLSearchParams(window.location.search).get('overlay');
    if (overlayParam === '0' || overlayParam === 'off') {
        setOverlayMode(false, true);
    }
}

function fieldError(input, errorEl, message) {
    if (message) {
        input.setAttribute('aria-invalid', 'true');
        errorEl.textContent = message;
        input.focus();
        return false;
    }
    input.removeAttribute('aria-invalid');
    errorEl.textContent = '';
    return true;
}

function joinChat() {
    const rawName = (dom['username-input'].value || '').trim();
    const rawRoom = (dom['stream-input'].value || '').trim();

    if (!fieldError(dom['username-input'], dom['username-error'], rawName ? '' : 'Enter a username so people know who you are.')) return;
    if (!fieldError(dom['stream-input'], dom['room-error'], rawRoom ? '' : 'Enter the room you want to watch.')) return;

    // Say what we are about to do instead of silently rewriting their input.
    if (!STREAM_NAME_RE.test(rawRoom)) {
        fieldError(dom['stream-input'], dom['room-error'],
            'Rooms use letters, numbers, dot, dash and underscore only. "' + rawRoom + '" is not valid.');
        return;
    }

    username = rawName.slice(0, 20);
    streamName = rawRoom;

    localStorage.setItem(LS.username, username);
    localStorage.setItem(LS.room, streamName);
    localStorage.setItem(LS.color, userColor);

    dom['room-name'].textContent = streamName;
    dom['room-chip'].textContent = streamName;
    document.title = streamName + ' - Ember';

    dom['login-modal'].classList.add('hidden');
    dom['main-container'].classList.remove('hidden');

    // a room deep link, so a viewer can be sent straight to it
    const url = new URL(window.location.href);
    url.searchParams.set('room', streamName);
    window.history.replaceState({}, '', url);

    initWebSocket();
    initVideo();
    startLivePolling();
}

/** Back to the join screen without reloading the page. */
function leaveChat() {
    intentionalClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearInterval(userPollTimer);
    stopLivePolling();
    if (ws) { try { ws.close(); } catch (e) { /* already gone */ } ws = null; }
    wsReady = false;

    if (popoutWindow && !popoutWindow.closed) popoutWindow.close();
    popoutWindow = null;

    setConnectionState('', 'offline');
    setLiveState('checking');
    dom['main-container'].classList.add('hidden');
    dom['login-modal'].classList.remove('hidden');
    dom['chat-input'].value = '';
    setSendEnabled(false);
    resetMessages();
    document.title = 'Ember - Live Chat';

    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
}

/* ============================================================== websocket */

function setConnectionState(state, text) {
    const badge = dom['ws-status'];
    if (!badge) return;
    badge.dataset.state = state || '';
    if (dom['ws-status-text']) dom['ws-status-text'].textContent = text;
    setSendEnabled(state === 'online');
}

function setSendEnabled(on) {
    if (dom['chat-input']) dom['chat-input'].disabled = !on;
    if (dom['send-btn']) dom['send-btn'].disabled = !on || !(dom['chat-input'] && dom['chat-input'].value.trim());
}

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + window.location.host);

    ws.onopen = () => {
        intentionalClose = false;
        wsReady = true;
        reconnectAttempt = 0;
        setConnectionState('online', 'connected');
        dom['chat-input'].focus();
        ws.send(JSON.stringify({ type: 'join', stream: streamName, username, color: userColor }));

        clearInterval(userPollTimer);
        userPollTimer = setInterval(() => {
            if (wsReady) ws.send(JSON.stringify({ type: 'get-users' }));
        }, 15000);
    };

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        if (data.type === 'chat') addMessage(data);
        else if (data.type === 'history') loadHistory(data.messages);
        else if (data.type === 'users') updateOnlineUsers(data.users);
        else if (data.type === 'error') toast(data.message);
    };

    ws.onerror = () => setConnectionState('', 'error');

    ws.onclose = () => {
        wsReady = false;
        clearInterval(userPollTimer);
        setSendEnabled(false);
        if (!intentionalClose) scheduleReconnect();
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = RECONNECT_STEPS[Math.min(reconnectAttempt, RECONNECT_STEPS.length - 1)];
    reconnectAttempt++;
    setConnectionState('connecting', 'reconnecting in ' + Math.round(delay / 1000) + 's');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        initWebSocket();
    }, delay);
}

/* ============================================================== video */

function setLiveState(state, detail) {
    liveState = state;
    const pill = dom['live-pill'];
    if (pill) pill.dataset.state = state;
    const text = dom['live-pill-text'];
    if (text) text.textContent = state === 'live' ? 'Live' : state === 'offline' ? 'Offline' : 'Checking';

    const overlay = dom['player-overlay'];
    const skeleton = dom['player-skeleton'];
    const iframe = document.getElementById('stream-iframe');

    if (state === 'live') {
        if (overlay) overlay.classList.add('hidden');
        if (skeleton) skeleton.classList.add('hidden');
        // Mount the player once there is something to play, and remount it if
        // the stream moved. Checking `iframe &&` alone deadlocks: the iframe is
        // what mountPlayer creates, so it would never appear on first load.
        const current = document.getElementById('stream-iframe');
        if (!current || current.dataset.path !== detail) mountPlayer(detail);
        return;
    }

    if (state === 'checking') {
        if (skeleton) skeleton.classList.remove('hidden');
        if (overlay) overlay.classList.add('hidden');
        return;
    }

    // offline
    if (skeleton) skeleton.classList.add('hidden');
    if (overlay) overlay.classList.remove('hidden');
    if (dom['offline-title']) dom['offline-title'].textContent = 'Stream offline';
    if (dom['offline-text']) {
        dom['offline-text'].textContent = 'Nobody is publishing to "' + streamName + '" right now. This page will pick it up automatically.';
    }
}

function mountPlayer(path) {
    const container = dom['video-container'];
    if (!container) return;
    let frame = document.getElementById('stream-iframe');
    if (!frame) {
        frame = document.createElement('iframe');
        frame.id = 'stream-iframe';
        frame.allow = 'autoplay; fullscreen; picture-in-picture';
        frame.allowFullscreen = true;
        frame.title = 'Live stream player';
        container.appendChild(frame);
    }
    frame.dataset.path = path;
    frame.src = `${dom['stream-base'] || ''}/${path}/`;
}

/** Ask the server where the player lives, and whether anything is live. */
async function pollLive() {
    if (!streamName) return;
    try {
        const res = await fetch('/api/live?room=' + encodeURIComponent(streamName), { cache: 'no-store' });
        const data = await res.json();
        if (data.live) setLiveState('live', data.path);
        else setLiveState('offline', data.path);
    } catch (e) {
        setLiveState('offline');
    }
}

function startLivePolling() {
    stopLivePolling();
    pollLive();
    scheduleNextLivePoll();
}

function scheduleNextLivePoll() {
    const wait = liveState === 'live' ? LIVE_POLL_MS : LIVE_POLL_MS_OFFLINE;
    livePollTimer = setTimeout(() => {
        pollLive().finally(scheduleNextLivePoll);
    }, wait);
}

function stopLivePolling() {
    if (livePollTimer) { clearTimeout(livePollTimer); livePollTimer = null; }
}

async function resolveStreamBase() {
    try {
        const res = await fetch('/stream-url?name=' + encodeURIComponent(streamName), { cache: 'no-store' });
        const info = await res.json();
        if (info && info.page) {
            // player page URL -> origin, so the iframe can be rebuilt on refresh
            try {
                dom['stream-base'] = new URL(info.page).origin;
            } catch (e) {
                dom['stream-base'] = '';
            }
        }
    } catch (e) {
        dom['stream-base'] = '';
    }
}

async function initVideo() {
    await resolveStreamBase();
    setLiveState('checking');
    await pollLive();
    startLivePolling();
}

/* ============================================================== messages */

function nearBottom() {
    const box = dom['chat-messages'];
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 90;
}

function updateStick() {
    stickToBottom = nearBottom();
    if (stickToBottom) {
        unreadCount = 0;
        dom['unread-badge'].classList.add('hidden');
    }
    dom['scroll-bottom'].classList.toggle('hidden', stickToBottom || !hasAnyMessage());
}

function scrollToBottom(smooth) {
    const box = dom['chat-messages'];
    if (!box) return;
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    unreadCount = 0;
    dom['unread-badge'].classList.add('hidden');
    stickToBottom = true;
}

function hasAnyMessage() {
    return !!(dom['chat-messages'] && dom['chat-messages'].querySelector('.chat-message'));
}

function resetMessages() {
    const box = dom['chat-messages'];
    if (!box) return;
    box.replaceChildren();
    renderEmptyState();
    lastAuthor = '';
    lastDayKey = '';
    unreadCount = 0;
}

function renderEmptyState() {
    const box = dom['chat-messages'];
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.innerHTML = '<strong>No messages yet</strong>Say something and start the conversation.';
    box.appendChild(empty);
}

function appendDaySeparator(ts) {
    const key = dayKey(ts);
    if (key === lastDayKey) return;
    lastDayKey = key;
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = dayLabel(ts);
    dom['chat-messages'].appendChild(sep);
}

function createMessageElement(data, forceUngrouped) {
    const ts = typeof data.ts === 'number' ? data.ts : Date.now();
    const author = data.username || 'anon';
    const isSystem = data.system === true;

    // consecutive messages from one person collapse into a group
    const grouped = !forceUngrouped && !isSystem &&
        author === lastAuthor && (ts - lastAuthorAt) < GROUP_WINDOW_MS;

    if (!grouped) {
        lastAuthor = author;
        lastAuthorAt = ts;
    }

    const div = document.createElement('div');
    div.className = 'chat-message' + (grouped ? ' is-grouped' : '');

    const name = author.toLowerCase();
    if (!isSystem && username && name !== username.toLowerCase() &&
        String(data.message || '').toLowerCase().includes('@' + username.toLowerCase())) {
        div.classList.add('mentioned');
    }

    const color = safeColor(data.color);
    const body = escapeHtml(data.message)
        .replace(/(^|\s)@([\w.-]+)/g, '$1<span class="mention">@$2</span>');

    div.innerHTML =
        '<span class="username" style="color:' + color + '">' + escapeHtml(author) + '</span>' +
        '<span class="timestamp">' + escapeHtml(formatTime(ts)) + '</span>' +
        '<span class="text">' + body + '</span>';

    return div;
}

function loadHistory(messages) {
    const box = dom['chat-messages'];
    if (!box) return;
    box.replaceChildren();
    lastAuthor = '';
    lastDayKey = '';
    unreadCount = 0;

    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) {
        renderEmptyState();
    } else {
        const frag = document.createDocumentFragment();
        list.forEach((msg) => {
            appendDaySeparator(typeof msg.ts === 'number' ? msg.ts : Date.now());
            frag.appendChild(createMessageElement(msg, true));
        });
        box.appendChild(frag);
    }
    scrollToBottom(false);
}

function addMessage(data) {
    const box = dom['chat-messages'];
    if (!box) return;

    const empty = box.querySelector('.empty-msg');
    if (empty) empty.remove();

    if (data.system === true) {
        const line = document.createElement('div');
        line.className = 'system-msg';
        line.textContent = data.message || '';
        box.appendChild(line);
    } else {
        appendDaySeparator(typeof data.ts === 'number' ? data.ts : Date.now());
        const div = createMessageElement(data);
        if (data.username === username) div.classList.add('is-own');
        box.appendChild(div);
        pushToPopout(div.outerHTML);
    }

    if (stickToBottom) {
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    } else {
        unreadCount++;
        const badge = dom['unread-badge'];
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badge.classList.remove('hidden');
    }
    dom['scroll-bottom'].classList.toggle('hidden', stickToBottom);
}

function updateOnlineUsers(users) {
    onlineUsers = (Array.isArray(users) ? users : []).map((user) => ({
        id: user.id,
        name: user.username,
        color: safeColor(user.color)
    }));

    const count = onlineUsers.length;
    if (dom['user-count']) {
        dom['user-count'].textContent = count > 99 ? '99+' : String(count);
        dom['user-count'].classList.toggle('hidden', count === 0);
    }
    if (dom['users-total']) dom['users-total'].textContent = String(count);

    renderUsersList();

    if (dom['autocomplete-dropdown'] && dom['autocomplete-dropdown'].classList.contains('active')) {
        renderUserDropdown('');
    }
}

function renderUsersList() {
    const list = dom['users-list'];
    if (!list) return;
    list.replaceChildren(...onlineUsers.map((user) => {
        const li = document.createElement('li');
        const isYou = user.name.toLowerCase() === username.toLowerCase();
        if (isYou) li.className = 'is-you';

        const dot = document.createElement('span');
        dot.className = 'user-color';
        dot.style.background = user.color;

        const label = document.createElement('span');
        label.textContent = isYou ? user.name + ' (you)' : user.name;

        li.append(dot, label);
        return li;
    }));
}

function sendMessage() {
    const input = dom['chat-input'];
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;
    if (!ws || !wsReady) {
        toast('Not connected yet - your message was not sent');
        return;
    }

    try {
        ws.send(JSON.stringify({ type: 'chat', message }));
        addMessage({ username, color: userColor, message, ts: Date.now() });
        input.value = '';
        updateCharCounter();
        closeDropdowns();
        input.focus();
    } catch (e) {
        toast('Could not send that message');
    }
}

function updateCharCounter() {
    const input = dom['chat-input'];
    const counter = dom['char-counter'];
    if (!input || !counter) return;
    const len = input.value.length;
    if (len < 400) {
        counter.classList.add('hidden');
        return;
    }
    counter.classList.remove('hidden');
    counter.textContent = len + ' / 500';
    counter.classList.toggle('is-over', len > 500);
}

/* ============================================================== emoji */

function initEmojiPicker() {
    const picker = dom['emoji-picker'];
    if (!picker) return;
    picker.replaceChildren();

    Object.keys(EMOJI_CATEGORIES).forEach((category) => {
        const section = document.createElement('div');
        section.className = 'emoji-category';

        const title = document.createElement('div');
        title.className = 'emoji-category-title';
        title.textContent = category;
        section.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'emoji-grid';
        EMOJI_CATEGORIES[category].forEach((emoji) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'emoji-btn';
            button.textContent = emoji;
            button.setAttribute('aria-label', 'Insert ' + emoji);
            button.addEventListener('click', () => {
                insertAtCursor(emoji);
                toggleEmojiPicker(false);
                dom['chat-input'].focus();
            });
            grid.appendChild(button);
        });

        section.appendChild(grid);
        picker.appendChild(section);
    });
}

function toggleEmojiPicker(force) {
    const picker = dom['emoji-picker'];
    const btn = dom['emoji-btn'];
    if (!picker) return;
    const show = typeof force === 'boolean' ? force : picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !show);
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) closeDropdowns(true);
}

function insertAtCursor(text) {
    const input = dom['chat-input'];
    if (!input) return;
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? start : input.selectionEnd;
    input.value = input.value.substring(0, start) + text + input.value.substring(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + text.length;
    updateCharCounter();
}

function showEmojiSuggestions() {
    const box = dom['emoji-suggestions'];
    const input = dom['chat-input'];
    if (!box || !input) return;

    const cursor = input.selectionStart || 0;
    const text = input.value.substring(0, cursor);
    const colon = text.lastIndexOf(':');
    if (colon === -1 || /\s/.test(text.substring(colon + 1))) {
        box.classList.remove('active');
        return;
    }

    const keyword = text.substring(colon + 1).toLowerCase();
    if (!keyword || keyword.length > 16) {
        box.classList.remove('active');
        return;
    }

    const matches = Object.keys(EMOJI_MAP)
        .filter((key) => key.startsWith(keyword))
        .slice(0, 4)
        .map((key) => [key, EMOJI_MAP[key]]);

    if (matches.length === 0) {
        box.classList.remove('active');
        return;
    }

    box.replaceChildren(...matches.map((match, index) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item emoji-suggestion-item' + (index === 0 ? ' selected' : '');
        item.dataset.emoji = match[1];
        item.textContent = match[1];
        const label = document.createElement('span');
        label.className = 'item-label';
        label.textContent = ':' + match[0] + ':';
        item.appendChild(label);
        return item;
    }));

    selectedEmojiIndex = 0;
    box.classList.add('active');
}

function commitEmojiSuggestion() {
    const box = dom['emoji-suggestions'];
    const input = dom['chat-input'];
    const items = box.querySelectorAll('.emoji-suggestion-item');
    if (!items.length) return;

    const emoji = items[Math.min(selectedEmojiIndex, items.length - 1)].dataset.emoji;
    const cursor = input.selectionStart || 0;
    const colon = input.value.substring(0, cursor).lastIndexOf(':');
    if (colon !== -1) input.value = input.value.substring(0, colon) + emoji + input.value.substring(cursor);
    box.classList.remove('active');
    selectedEmojiIndex = 0;
    input.focus();
    updateCharCounter();
}

/* ============================================================== mentions */

function renderUserDropdown(search) {
    const box = dom['autocomplete-dropdown'];
    if (!box) return;

    const matches = (search
        ? onlineUsers.filter((user) => user.name.toLowerCase().includes(search))
        : onlineUsers
    ).slice(0, 8);

    if (matches.length === 0) {
        box.classList.remove('active');
        return;
    }

    box.replaceChildren(...matches.map((user, index) => {
        const item = document.createElement('div');
        item.className = 'dropdown-item autocomplete-item' + (index === 0 ? ' selected' : '');
        item.dataset.username = user.name;

        const dot = document.createElement('span');
        dot.className = 'user-color';
        dot.style.background = user.color;

        const label = document.createElement('span');
        label.textContent = user.name;

        item.append(dot, label);
        return item;
    }));

    selectedUserIndex = 0;
    box.classList.add('active');
}

function handleInput() {
    const input = dom['chat-input'];
    const cursor = input.selectionStart || 0;
    const before = input.value.substring(0, cursor);
    const at = before.lastIndexOf('@');

    if (at !== -1 && before.indexOf(' ', at) === -1 && !before.includes('@', at + 1)) {
        renderUserDropdown(before.substring(at + 1).toLowerCase());
    } else if (dom['autocomplete-dropdown']) {
        dom['autocomplete-dropdown'].classList.remove('active');
    }

    showEmojiSuggestions();
    updateCharCounter();
    setSendEnabled(wsReady);
}

function insertMention(name) {
    const input = dom['chat-input'];
    if (!input) return;
    const cursor = input.selectionStart || 0;
    const text = input.value;
    const at = text.lastIndexOf('@', Math.max(cursor - 1, 0));
    if (at === -1) return;
    input.value = text.substring(0, at) + '@' + name + ' ' + text.substring(cursor);
    dom['autocomplete-dropdown'].classList.remove('active');
    input.focus();
    updateCharCounter();
}

function commitUserSuggestion() {
    const box = dom['autocomplete-dropdown'];
    const items = box.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    insertMention(items[Math.min(selectedUserIndex, items.length - 1)].dataset.username);
    selectedUserIndex = 0;
}

function moveSelection(box, direction, step) {
    const items = box.querySelectorAll('.dropdown-item');
    if (!items.length) return step;
    items[step].classList.remove('selected');
    let next = (step + direction + items.length) % items.length;
    items[next].classList.add('selected');
    items[next].scrollIntoView({ block: 'nearest' });
    return next;
}

function closeDropdowns(keepPicker) {
    if (dom['emoji-suggestions']) dom['emoji-suggestions'].classList.remove('active');
    if (dom['autocomplete-dropdown']) dom['autocomplete-dropdown'].classList.remove('active');
    if (!keepPicker && dom['emoji-picker']) toggleEmojiPicker(false);
}

function initKeyboard() {
    const input = dom['chat-input'];
    const emojiBox = dom['emoji-suggestions'];
    const userBox = dom['autocomplete-dropdown'];

    input.addEventListener('input', () => {
        selectedEmojiIndex = 0;
        selectedUserIndex = 0;
        handleInput();
    });

    // One handler: Enter used to fire from both keydown and keypress.
    input.addEventListener('keydown', (event) => {
        const emojiOpen = emojiBox.classList.contains('active');
        const usersOpen = userBox.classList.contains('active');

        if (event.key === 'Enter') {
            event.preventDefault();
            if (usersOpen) commitUserSuggestion();
            else if (emojiOpen) commitEmojiSuggestion();
            else sendMessage();
            return;
        }

        if (event.key === 'Tab' && (emojiOpen || usersOpen)) {
            event.preventDefault();
            if (usersOpen) commitUserSuggestion();
            else commitEmojiSuggestion();
            return;
        }

        if (event.key === 'Escape') {
            closeDropdowns();
            return;
        }

        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (emojiOpen || usersOpen)) {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            if (usersOpen) selectedUserIndex = moveSelection(userBox, direction, selectedUserIndex);
            else selectedEmojiIndex = moveSelection(emojiBox, direction, selectedEmojiIndex);
        }
    });

    userBox.addEventListener('mousedown', (event) => {
        const item = event.target.closest('.autocomplete-item');
        if (item) {
            event.preventDefault();
            insertMention(item.dataset.username);
        }
    });

    emojiBox.addEventListener('mousedown', (event) => {
        const item = event.target.closest('.emoji-suggestion-item');
        if (item) {
            event.preventDefault();
            commitEmojiSuggestion();
        }
    });

    document.addEventListener('click', (event) => {
        if (!event.target.closest('#chat-input-wrapper') && !event.target.closest('#emoji-picker')) {
            closeDropdowns();
        }
        if (!event.target.closest('#users-popover') && !event.target.closest('#users-btn')) {
            dom['users-popover'].classList.add('hidden');
        }
    });
}

/* ============================================================== pop-out */

const POPOUT_STYLE = `
    :root { color-scheme: dark; }
    body {
        margin: 0; padding: 12px; height: 100vh; overflow-y: auto;
        background: #0a0705; color: #f6efe8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background-image: radial-gradient(600px 400px at 80% -10%, rgba(255,122,26,.10), transparent 60%);
    }
    .chat-message { margin-bottom: 2px; padding: 3px 6px; border-radius: 6px; word-break: break-word; }
    .chat-message.is-grouped { padding-top: 0; padding-bottom: 0; }
    .chat-message.is-grouped .username, .chat-message.is-grouped .timestamp { display: none; }
    .chat-message.is-own { background: rgba(255,122,26,.10); box-shadow: inset 2px 0 0 #ff7a1a; }
    .chat-message.mentioned { background: rgba(255,122,26,.13); box-shadow: inset 2px 0 0 #ff7a1a; }
    .chat-message .username { font-weight: 700; margin-right: 6px; }
    .chat-message .timestamp { color: #7d6e62; font-size: 10.5px; margin-right: 6px; }
    .chat-message .text .mention { color: #ffa23c; font-weight: 700; }
`;

function popoutChat() {
    if (popoutWindow && !popoutWindow.closed) {
        popoutWindow.focus();
        return;
    }

    const messages = Array.from(dom['chat-messages'].querySelectorAll('.chat-message'));
    if (messages.length === 0) {
        toast('Nothing to pop out yet');
        return;
    }

    const popup = window.open('', 'Chat - ' + streamName, 'width=380,height=620,scrollbars=yes');
    if (!popup) {
        toast('Pop-out blocked - allow popups for this site');
        return;
    }

    popoutWindow = popup;
    popup.document.write(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Chat - ' + escapeHtml(streamName) + '</title>' +
        '<style>' + POPOUT_STYLE + '</style></head><body>' +
        '<div id="messages">' + messages.map((m) => m.outerHTML).join('') + '</div>' +
        '</body></html>'
    );
    popup.document.close();
}

function pushToPopout(html) {
    if (!html || !popoutWindow || popoutWindow.closed) return;
    const target = popoutWindow.document.getElementById('messages');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);
    popoutWindow.scrollTo(0, popoutWindow.document.body.scrollHeight);
}

/* ============================================================== controls */

function setOverlayMode(on, persist) {
    document.body.classList.toggle('overlay-mode', on);
    const btn = dom['transparent-btn'];
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (btn) btn.title = on ? 'Overlay mode on - click to exit' : 'Overlay mode (for OBS)';
    // The top bar (and therefore the toggle) is hidden while the overlay is on,
    // so the floating exit control has to come with it or this is a one-way trip.
    if (dom['overlay-exit']) dom['overlay-exit'].classList.toggle('hidden', !on);
    if (persist !== false) localStorage.setItem(LS.overlay, on ? '1' : '0');
    if (on) toast('Overlay mode on - chat only, transparent background', 'info');
}

function initControls() {
    dom['join-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        joinChat();
    });

    dom['chat-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        sendMessage();
    });

    dom['chat-input'].addEventListener('blur', () => {
        // keep the value so the send button can be re-enabled
        setTimeout(() => setSendEnabled(wsReady), 0);
    });

    dom['emoji-btn'].addEventListener('click', (event) => {
        event.stopPropagation();
        toggleEmojiPicker();
    });

    dom['leave-btn'].addEventListener('click', leaveChat);

    dom['refresh-btn'].addEventListener('click', () => {
        const frame = document.getElementById('stream-iframe');
        if (frame) {
            frame.src = frame.src;
            toast('Player reloaded', 'info');
        } else {
            pollLive();
            toast('Checked for the stream', 'info');
        }
    });

    dom['offline-retry'].addEventListener('click', () => {
        setLiveState('checking');
        pollLive().then(scheduleNextLivePoll);
    });

    dom['copy-link-btn'].addEventListener('click', async () => {
        const url = new URL(window.location.href);
        url.searchParams.set('room', streamName);
        try {
            await navigator.clipboard.writeText(url.toString());
            toast('Stream link copied', 'info');
        } catch (e) {
            toast('Could not copy - the link is in the address bar', 'info');
        }
    });

    dom['fullscreen-btn'].addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else if (dom['video-container'].requestFullscreen) {
            dom['video-container'].requestFullscreen().catch(() => toast('Fullscreen not available here'));
        }
    });

    dom['popout-chat-btn'].addEventListener('click', popoutChat);

    dom['transparent-btn'].addEventListener('click', () => {
        setOverlayMode(!document.body.classList.contains('overlay-mode'), true);
    });

    dom['overlay-exit'].addEventListener('click', () => setOverlayMode(false, true));

    dom['users-btn'].addEventListener('click', (event) => {
        event.stopPropagation();
        const pop = dom['users-popover'];
        pop.classList.toggle('hidden');
        if (!pop.classList.contains('hidden')) renderUsersList();
    });

    dom['chat-messages'].addEventListener('scroll', updateStick, { passive: true });

    dom['scroll-bottom'].addEventListener('click', () => scrollToBottom(true));

    document.addEventListener('keydown', (event) => {
        // Overlay mode hides its own toggle, so Esc must always get you out.
        if (event.key === 'Escape' && document.body.classList.contains('overlay-mode')) {
            setOverlayMode(false, true);
            return;
        }
        const inChat = dom['login-modal'].classList.contains('hidden');
        if (!inChat) return;
        const tag = (event.target.tagName || '').toLowerCase();
        if (event.key === 'Escape') {
            closeDropdowns();
            dom['users-popover'].classList.add('hidden');
            return;
        }
        // "/" focuses the message box, the way every chat app does it
        if (event.key === '/' && tag !== 'input' && tag !== 'textarea') {
            event.preventDefault();
            if (wsReady) dom['chat-input'].focus();
        }
    });

    window.addEventListener('beforeunload', () => { intentionalClose = true; });
}

/* ============================================================== boot */

document.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    initColorPicker();
    restoreSavedProfile();
    initEmojiPicker();
    initKeyboard();
    initControls();

    dom['chat-messages'].appendChild(document.createElement('div'));
    resetMessages();
    setSendEnabled(false);
    setLiveState('checking');

    // deep link: /?room=Kivi prefills and joins straight away if we remember you
    const room = new URLSearchParams(window.location.search).get('room');
    if (room && STREAM_NAME_RE.test(room) && dom['username-input'].value) {
        dom['stream-input'].value = room;
        joinChat();
    } else {
        dom['username-input'].focus();
    }
});
