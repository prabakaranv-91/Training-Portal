# Linux Server Deployment

This setup serves Fit Squad at your domain with automatic HTTPS. Docker runs a
private, non-root FastAPI container behind Caddy. SQLite and TLS certificates
survive container replacement in named Docker volumes. No existing personal data
or credentials are included in the image.

## Requirements

- A Linux server with Docker Engine and Docker Compose v2 supporting `up --wait`.
  Install using https://docs.docker.com/engine/install/ for your distribution.
- A domain such as `fitness.example.com`, with an A record pointing at the server.
  Only add an AAAA record if the server also accepts IPv6 traffic.
- Inbound TCP ports 80 and 8443 allowed by the server and cloud firewall. Keep SSH
  restricted to administrator addresses. Do not expose port 8000.
- Outbound HTTPS access to certificate authorities, Garmin, Strava and AI providers.
- A practical starting size is 2 CPU cores and 2 GB RAM; monitor actual usage.

## Launch

Clone or upload the source to your server, then run from the repository root:

```sh
cp .env.example .env
chmod 600 .env
nano .env
sh deploy.sh up
```

Set `APP_DOMAIN` to your hostname only, without `https://`, a port or a path.
Set `ACME_EMAIL` to your real administrator email. Replace the example values.
Caddy obtains a certificate using HTTP validation on port 80 and redirects HTTP
to HTTPS on port 8443. Keep port 80 free for Caddy; this setup cannot share it
with an existing Nginx listener. Public port 443 is not used. HSTS is not enabled
because its automatic browser upgrades would send port-80 URLs to port 443.
Open `https://YOUR_DOMAIN:8443` and sign in with Garmin
or Strava; configure and verify your AI model in Settings to enable nutrition.

For Strava, register an API application at https://www.strava.com/settings/api.
Set its Authorization Callback Domain to your hostname and set both
`STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` in `.env`. The callback URL is
`https://YOUR_DOMAIN:8443/api/strava/callback`. Environment credentials override saved
SQLite credentials; setting only one disables Strava rather than mixing secrets.
Provider approval and athlete capacity limits may restrict who can sign in.

The backend trusts forwarded headers only because its port is not published and
Caddy is the sole ingress. Preserve this boundary. Frontend and API share one
origin; the proxy rejects cross-origin browser mutation requests. Do not use the
development launchers for a public server.

## Operations

```sh
sh deploy.sh status
sh deploy.sh logs
sh deploy.sh backup
git pull --ff-only
sh deploy.sh update
sh deploy.sh down
```

`update` first backs up a running application's SQLite database, then rebuilds and
recreates the entire stack. If the backup fails, it stops before changing services.
`down` retains all volumes. Never use `docker compose down --volumes` unless you
intend to permanently delete user data and certificates. Docker restarts services
after reboot when the Docker service is enabled. An unhealthy container is reported
but not automatically restarted unless its process exits; monitor health status.

Keep one backend replica with one worker. Pending Garmin MFA is process-local and
SQLite is single-server storage. This deployment makes the service internet
accessible, not horizontally scalable. Updates interrupt in-progress MFA logins.

## Backups And Restore

`backup` uses SQLite's online backup API, not a copy of a live WAL database. Files
are written under `backups/` with private permissions. They contain sensitive
provider tokens, integration keys and health records. Schedule backups, encrypt
them, copy them off-server, and test recovery. Do not commit them or serve them.

To restore a trusted backup, first make a current backup and stop the stack. Run
these commands from the repository root, replacing the example backup filename:

```sh
sh deploy.sh backup
sh deploy.sh down
docker compose run --rm --no-deps -T app python -c '
from contextlib import closing
import pathlib
import sqlite3
import sys

data = pathlib.Path("/app/data")
candidate = data / "restore.sqlite3"
candidate.write_bytes(sys.stdin.buffer.read())
candidate.chmod(0o600)
with closing(sqlite3.connect(candidate)) as database:
    if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SystemExit("Backup integrity check failed; current database unchanged")
for suffix in ("-wal", "-shm"):
    (data / ("app.sqlite3" + suffix)).unlink(missing_ok=True)
candidate.replace(data / "app.sqlite3")
' < backups/YOUR_BACKUP.sqlite3
sh deploy.sh up
```

For migration from an existing installation, stop the old application and create
a consistent SQLite backup there, transfer it securely, run `sh deploy.sh up` once
to initialize the volume, then follow the restore procedure. Never move a live
SQLite file alone while ignoring its WAL. Treat migrations as sensitive transfers.

## Before A Public Launch

- Verify HTTPS, login, MFA, Strava consent, account isolation and meal persistence
  on the actual domain; restart the stack and confirm saved data still works.
- Put a managed WAF or equivalent rate limiter in front of a broadly advertised
  service. This baseline does not add distributed abuse protection or login quotas.
- Review provider terms and approvals. Garmin uses an unofficial API; commercial
  use generally requires the official Garmin Health API and partner approval.
- Establish privacy, retention, deletion and incident-response policies for health
  data. SQLite file permissions are not encryption at rest; use encrypted server
  storage and encrypted backups. Server administrators can access stored secrets.
- Keep the OS, Docker, Caddy and Python dependencies patched. The Caddy image uses
  a maintained major-version tag; use tested digests for reproducible releases.

If HTTPS does not work, check DNS, ports 80/8443, conflicting web servers, and
`docker compose logs proxy`. If the app is unhealthy, check
`docker compose logs app`, disk space and volume permissions. Certificate issuance
can take longer than the launcher's wait window; inspect logs before retrying.