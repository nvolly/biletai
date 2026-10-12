ai-task/1012-1313-let-the-biletai-server-url-environment-v
# Deploying the desktop app

`npm run desktop:dist` builds the Windows installer into `desktop/dist/`. The installer
embeds `desktop/config.json`, whose `serverUrl` is where the app talks to the BiletAI
server. The default is `http://127.0.0.1:8787` (a local server, for development).

## Pointing an installer at the real server

Set the `BILETAI_SERVER_URL` environment variable before building; it overrides
`config.json`'s `serverUrl` for that build only (the file on disk is written with the
override, so build on a clean checkout or restore it afterwards):

```
BILETAI_SERVER_URL=https://biletai.example.com npm run desktop:dist
```

Without the variable, the build uses whatever `desktop/config.json` says, unchanged.

Remember to set up the server first (EU VPS, HTTPS) before shipping the installer.
# Deploying the BiletAI server

Production stack, all in Docker:

```
Internet ──443──► Caddy (Let's Encrypt, auto-HTTPS) ──► biletai server (8787, 127.0.0.1)
                                                           │
                                              volumes: data/  logs/  backups/  .env
```

- **biletai** — the Node server (`Dockerfile`), listens on 8787, is published on
  `127.0.0.1:8787` only; Caddy is the only thing on 80/443.
- **caddy** — reverse proxy, automatic Let's Encrypt certificates, auto http→https
  redirect (`deploy/caddy/Caddyfile`).
- `.env` is passed from outside: `docker-compose.yml` lists it with `env_file`, so its
  variables reach the container as environment. **It is never copied into the image**
  (the `Dockerfile` copies only `src/`, `client/`, `config/` and the npm files).

## 1. Hetzner VPS

Rent a small EU server (Robot or Cloud, e.g. CX22/CPX21, ~€5–8/month, Ubuntu 24.04).

1. Connect: `ssh root@<vps-ip>`
2. Point the domain at it **before anything else**: an `A` record
   `{biletai.example.ro} → <vps-ip>` at the registrar (and an `AAAA` if you give IPv6).
   Wait until `dig +short A biletai.example.ro` shows the VPS's IP — Caddy can't get a
   certificate until DNS resolves.
3. Docker (Hetzner images have it; if not):
   ```bash
   apt update && apt -y install docker.io docker-compose-v2
   ```

The firewall: Hetzner's robot console firewall already allows only 22, 80, 443, 53, 7777
and 3389 — exactly what we need (SSH, Caddy, DNS, SMTP-ish ports; 8787 stays closed).

## 2. The repository on the VPS

```bash
apt -y install git nodejs npm
git clone <repo> /opt/biletai
cd /opt/biletai
```

(Alternative: keep a checkout on the development machine and
`rsync -av --exclude node_modules --exclude .env --exclude data --exclude logs --exclude backups /path/to/biletai/ /opt/biletai/`
after every release, then `docker compose up -d`.)

## 3. The .env on the server

```bash
cd /opt/biletai
cp .env.example .env
nano .env     # put DEEPSEEK_API_KEY, TYPESAFE_API_KEY, ADMIN_TOKEN in it
chmod 600 .env
```

`.env` is read on the host by docker-compose (via `env_file`) and never goes into the
image or the apps. The server's `dotenv.config()` also reads a `.env` from its working
directory, so the same file works either way; here we pass it through explicitly.

## 4. Caddy's domain

Edit `deploy/caddy/Caddyfile`: replace `biletai.example.ro` (every occurrence) with
Vali's real domain. It must resolve (step 1.2) first.

## 5. Start

```bash
cd /opt/biletai
docker compose up -d --build
docker compose logs -f biletai        # wait for "BiletAI server on http://127.0.0.1:8787"
```

First start takes a while: the model bank is built (fixtures download + training) and
Caddy obtains its certificate. Watch `docker compose logs -f caddy` for
*"obtained certificate"*.

Check from the VPS:

```bash
curl -s http://127.0.0.1:8787/v1/health
curl -sI https://biletai.example.ro/        # expect 200, TLS
```

Restart after a code change:

```bash
docker compose build biletai && docker compose up -d
```

## 6. Daily backup

The server writes `data/` (users, generations, track record) to the host volume
`/opt/biletai/data/`. A backup is a copy to `backups/<YYYY-MM-DD>/`, keeping 14 days
(`npm run backup`, `utils/backup.ts`). Run it every day at 03:30:

```bash
ssh root@<vps-ip> 'crontab -l > /tmp/cron'
echo '30 3 * * * cd /opt/biletai && /usr/bin/docker run --rm --volume /opt/biletai:/app -w /app biletai-server:latest npm run backup >/opt/biletai/logs/backup.log 2>&1' >> /tmp/cron
crontab /tmp/cron && crontab -l
```

`docker run --rm` uses the built image's Node without touching the running container:
`data/` is mounted read-only at `/app/data` only for that invocation (it is re-mounted at
the same path from the host by the compose service, and the one-off backup container just
reads it). Verify once: `ls /opt/biletai/backups/` shows a `YYYY-MM-DD` folder after 03:30.

Backups stay on the VPS. Copy them off (e.g. nightly `restic`/`rclone` to object
storage) so a dead disk is not the end of the accounts — that's a later step, not before
payment.

## 7. Point the desktop app at the server

`desktop/config.json`:

```json
{ "serverUrl": "https://biletai.example.ro" }
```

`https` is required: the app's `/v1` calls use `Authorization: Bearer`, which browsers
(and Electron) refuse to send over plain HTTP to other origins. The domain must be the
same one as in `Caddyfile`. `serverUrl` is baked into the installer at build time, so:
edit the file, then `npm run desktop:dist` and reinstall the new `.exe`.

Until the installer's code-signing certificate is bought, Windows SmartScreen will warn
once — expected while we're private.

## 8. Users on the production server

Until the app has email sign-in (roadmap item 3), keys are issued server-side:

```bash
docker exec -it biletai npm run user -- add email@ex.com 20   # prints the access key ONCE
```

Or `POST /admin/users` with `X-Admin-Token: <ADMIN_TOKEN from .env>`.

The `owner-access-key.txt` on the development machine is not on the VPS; issue a fresh
owner key there.

## 9. Health and trouble-shooting

| Symptom | Where to look |
|---|---|
| `curl https://domain/v1/health` fails | DNS resolves to the VPS? `sudo caddy list-sites`, `docker compose logs caddy` (certificate errors) |
| Local HTTP ok, HTTPS fails | Caddy→`biletai:8787` in the Caddyfile; both containers on the same compose network |
| Slow first generation | Model bank still building; the log shows progress, retries work |
| Container restarts in a loop | `docker compose logs biletai` — usually a missing key in `.env` (it starts, but AI stages fail loud); fix the `.env`, restart |
| Out of memory | Bump `deploy.resources.limits.memory` in `docker-compose.yml` and recreate |
| Generation queue growing | One generation at a time, ~15 s each; worker-thread move is on the to-do list, not a server bug |

## 10. What must NOT happen on a VPS

- `.env` must never be committed, copied into the image, or exposed over the API.
- `data/` holds access-key hashes and users' generations — the volume, not the image.
- Nothing that touches a bookmaker in any form (CLAUDE.md rule): the VPS is a
  plain Node server + proxy.
- No payments before the ONJN answer + the lawyer's review (CLAUDE.md).
