# stream.ldslive.ir - portless setup

Goal: the chat and the video live at `https://stream.ldslive.ir/` with no port
numbers in the URL.

## The one thing that cannot change

**RTMP stays on port 1935.** Streamers must use:

```
rtmp://stream.ldslive.ir:1935/live
```

RTMP is not an HTTP protocol, so no web server can serve it on 80/443 and no
CDN can proxy it. Everything *else* can be portless.

---

## What is already done on this server

| | |
|---|---|
| nginx config for `:80` | live and reloaded |
| ACME challenge | answering on port 80 for this hostname |
| nginx config for `:443` | written, **not yet enabled** (no certificate yet) |
| existing `ldslive.ir` site | untouched, verified HTTP 200 |

Files:

```
/etc/nginx/sites-available/stream.ldslive.ir        :80 only  (ENABLED)
/etc/nginx/sites-available/stream.ldslive.ir-tls    :443       (NOT enabled)
/etc/nginx/conf.d/websocket-upgrade.conf            Upgrade header map
```

Routing once TLS is live, because two apps share the hostname:

```
/live/*, /webrtc/*  ->  127.0.0.1:8888   MediaMTX
everything else      ->  127.0.0.1:8080   chat + admin panel
```

---

## Step 1 - add the DNS record (you must do this)

Cloudflare -> DNS -> Records -> Add record:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `stream` |
| IPv4 address | `128.140.66.63` |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

Confirm it landed:

```bash
dig +short stream.ldslive.ir
# must print 128.140.66.63
```

**It must be grey cloud.** If it is orange, Cloudflare answers for port 443
but streamers silently fail on 1935, which is the single most confusing failure
mode in this setup.

## Step 2 - issue the certificate

Only after step 1 resolves:

```bash
certbot certonly --webroot -w /var/www/html -d stream.ldslive.ir
```

## Step 3 - enable HTTPS

```bash
ln -sf /etc/nginx/sites-available/stream.ldslive.ir-tls \
       /etc/nginx/sites-enabled/stream.ldslive.ir-tls
nginx -t && nginx -s reload
```

Do not skip `nginx -t`. If the certificate is missing nginx refuses to reload
and every other site on this box goes down with it - that is exactly what
happened the first time this config was enabled, which is why the TLS block is
kept in a separate file.

## Step 4 - tell the app the portless URLs

The server builds viewer URLs from the hostname, so this mostly happens on its
own. Set these explicitly so the player never carries a port:

```bash
cd /path/to/Iran-Offline/rtmp-chat-offline
sudo ./rtmp-chat.sh install --systemd \
  --stream-base https://stream.ldslive.ir \
  --rtmp-base rtmp://stream.ldslive.ir:1935/live
```

Re-running `install` is safe: it keeps `data/` (stream keys, admin URL and
password) unless you pass `--force` or `--data-dir` points somewhere new.

## Step 5 - verify

```bash
# chat is on 443, no port
curl -sI https://stream.ldslive.ir/ | head -1

# a live room's player page
curl -s https://stream.ldslive.ir/stream-url?name=Kivi

# the admin panel (secret path)
curl -sI https://stream.ldslive.ir/admin-1f205WkBf2e7/ | head -1

# real publish through the gate
ffmpeg -re -f lavfi -i testsrc=size=320x240:rate=10 -c:v libx264 \
  -preset ultrafast -t 5 -f flv "rtmp://stream.ldslive.ir:1935/live/Kivi?key=<KEY>"
```

---

## Firewall

`ufw` is currently inactive, so nothing blocks you. If you enable it:

```bash
ufw allow 80/tcp      # TLS + ACME
ufw allow 443/tcp     # chat + video
ufw allow 1935/tcp    # RTMP ingest (streamers only, cannot be proxied)
```

Port 8888 no longer needs to be public: nginx reaches MediaMTX over loopback.
Leave it closed once this is working.

## Things that will bite you

- **Orange cloud on the DNS record** is the big one. RTMP dies, no error.
- **Caching.** The `:443` block sends `Cache-Control: no-store`, and `/live/*`
  is proxied with buffering off. Without that, stale playlists get served and
  playback stalls a few minutes in.
- **WebRTC** (`:8889`) needs UDP and is not proxied by the `:443` block. The
  player defaults to HLS, so leave WebRTC off in `config/mediamtx.yml`.
- **Grey cloud exposes your origin IP** for the `stream` name. `ldslive.ir`
  stays hidden if it is still orange.
