# DEV — run & playtest

## One-time prerequisites (laptop)
1. **Node.js** LTS (v20+). Includes npm. Required for this project.
2. **Git** (recommended).
3. **VS Code** (run Claude Code in its terminal).
4. **Claude Code** — native installer (no Node needed for Claude Code itself):
   - Windows (PowerShell): `irm https://claude.ai/install.ps1 | iex`
   - macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash`
   - Then run `claude` in this folder and sign in with your Claude Max account.
   - Docs: https://code.claude.com/docs/en/setup

## Install & run
```bash
npm install                 # once, at the repo root

npm run dev:server          # world + economy API  -> http://localhost:2567/world
npm run dev:client          # the map              -> http://localhost:5173
```
Run them in two terminals. Edit + save = the browser hot-reloads.

## Tests (run after touching the economy / money paths)
```bash
cd packages/server && npm test
```

## Playtest on your phone (same Wi-Fi)
1. Find your laptop's LAN IP (Windows: `ipconfig` → IPv4; macOS: `ipconfig getifaddr en0`). e.g. `192.168.1.50`.
2. Copy `packages/client/.env.example` to `packages/client/.env` and set
   `VITE_SERVER=http://192.168.1.50:2567`.
3. The client already starts with `--host`, so on your phone's browser open
   `http://192.168.1.50:5173`. In Chrome/Safari, "Add to Home Screen" for the app feel.

## Playtest anywhere
- Quick tunnel: run `cloudflared tunnel --url http://localhost:5173` (or ngrok) for a temporary public URL.
- Permanent: deploy server + client to Railway and open the URL on any device.

## Databases (only when we wire persistence)
```bash
docker compose up -d        # postgres:5432, redis:6379
npm run migrate
```
The map demo and economy tests run fine without databases.
