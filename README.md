# Iran-Offline

Offline-first projects for machines with no internet access. The target
platform is Ubuntu 24.04.

## Quick start

From a machine with internet access, clone the repository and install the
project in one command:

```bash
git clone https://github.com/ThisIsDara/Iran-Offline.git && sudo ./Iran-Offline/rtmp-chat-offline/rtmp-chat.sh setup
```

`setup` verifies the bundled dependencies, installs the bundled Node.js and
MediaMTX runtimes, creates the config and admin credentials, installs the
systemd services, and starts them. It never runs `apt`, `npm`, `curl` or `wget`.

### Air-gapped installation

If the target host has no internet access, clone the repository on a connected
machine and copy the resulting `Iran-Offline` folder across, then run:

```bash
sudo ./Iran-Offline/rtmp-chat-offline/rtmp-chat.sh setup
```

The complete offline dependency bundle is committed under
`rtmp-chat-offline/deps/`, so no network access is needed on the target host.

## Projects

### rtmp-chat-offline

Self-hosted RTMP streaming with a chat overlay and a stream-key admin panel.
Everything the runtime needs — Node.js, MediaMTX and the npm dependencies —
travels in `rtmp-chat-offline/deps/`.

See [`rtmp-chat-offline/README.md`](rtmp-chat-offline/README.md) for the full
manual, configuration options, management commands and troubleshooting.

## Repository layout

```text
Iran-Offline/
├── README.md
├── .gitattributes
├── .gitignore
└── rtmp-chat-offline/
    ├── README.md
    ├── rtmp-chat.sh
    ├── server.js
    ├── admin/
    ├── public/
    ├── lib/
    ├── tools/
    └── deps/                # bundled Node.js, MediaMTX and node_modules
```

The project generates `config/`, `data/`, `.runtime/`, `logs/` and `backups/`
inside `rtmp-chat-offline/` when it is installed. Those runtime directories are
not tracked in Git.
