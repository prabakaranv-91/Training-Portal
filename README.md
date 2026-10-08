# 🏃 Garmin Training Portal

A personal web portal that connects to your **Garmin Connect** account and shows
your training and wellness statistics on a single dashboard:

- 👟 Steps, distance, floors, intensity minutes
- 🔥 Calories (total + active)
- ❤️ Resting / max heart rate, stress, body battery, sleep
- 🫁 Running & cycling **VO₂ max** and training status
- 🏅 Recent activities with distance, time, pace and average HR
- 📊 7-day steps chart

Built with **FastAPI** (backend) + a lightweight **HTML/JS** dashboard. Data comes
from the [`garminconnect`](https://github.com/cyberjunky/python-garminconnect)
library, which logs in to Garmin Connect with your email + password (MFA supported).

---

## Quick start (Windows / PowerShell)

```powershell
cd c:\Work\garmin
./start.ps1
```

This creates a virtual environment, installs dependencies, and starts the server.
Then open <http://127.0.0.1:8000> and sign in with your Garmin credentials.

### Manual start

```powershell
cd c:\Work\garmin
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
cd backend
python main.py
```

Open <http://127.0.0.1:8000>.

---

## How login works

1. Enter your **Garmin Connect email and password** in the web UI.
2. If your account has **multi-factor authentication (MFA)** enabled, you'll be
   prompted for the code from your authenticator app / email.
3. Successful Garmin login stores that user's tokens, email and display name in
   `backend/data/app.sqlite3`.
   Users are separated by normalized email, and the browser session references
   only its own account. Passwords and MFA codes are never saved.
4. The browser holds an opaque HTTP-only session cookie. A hashed session lookup
   and its seven-day expiry are stored in SQLite, allowing login recovery
   after a backend restart. Refreshed Garmin tokens update the same user's record.
5. Sign-out invalidates only that session and clears its cookie. Saved account
   tokens remain for the localhost-only **Use saved Garmin login** action: enter
   the account's email before selecting it. No account is picked automatically.
6. Garmin authentication does not use Google Sheets or require Apps Script.
   Database writes are transactional; failed writes report an error rather than
   pretending login was saved. SQLite serializes concurrent writers.

> Treat `backend/data/` as sensitive credentials. The SQLite database contains
> provider tokens and API secrets; it is not encrypted at rest. Keep the directory
> private and out of version control. Use SQLite's backup API for live backups,
> or stop the application before copying the database and its journal files.

Strava continues to use its official consent-based OAuth flow. Access and refresh
tokens are kept in SQLite, not in browser storage or the Google Sheet. HTTP-only
cookies contain only random session identifiers. OAuth callbacks verify a browser-specific state, and activity
and weight caches are isolated by session. Start authorization from the local
app in the same browser, not from a bookmarked Strava login/authorization link.

No encryption-key environment variable is needed to preserve database-backed
sessions after restarts. Production cookies require HTTPS (`Secure`, `HttpOnly`,
`SameSite=Lax`); localhost HTTP is supported. Cookies expire after seven days.
Sign-out revokes the SQLite session and clears its cookie. Startup port and
allowed origins are held in the database's `app_config` settings.

## Application settings and migration

Open **Integration settings** on the local sign-in page, or **Integrations** on
the dashboard, to save Strava application credentials, a Google Sheets Apps Script
deployment URL and token, Gemini configuration, and the optional USDA key.
An authenticated user saves into their own account scope. Initial shared setup is
restricted to localhost. Stored secrets are never returned by the settings API;
leaving a configured secret field blank preserves it.

At first database initialization, the app imports `strava_config.json`,
`nutrition_config.json`, `nutrition_secrets.json`, legacy Garmin accounts and
sessions, nutrition logs, caches, and retry state. Existing credential environment
variables are accepted only as one-time migration inputs. Subsequent reads and
writes use SQLite exclusively. Original files remain untouched as migration
backups; keep those backups private too.

Legacy nutrition logs are adopted once by the first matching authenticated
account. Existing encrypted Strava browser cookies require a one-time reconnect;
new sessions persist in SQLite and survive restarts. Do not delete the database
to edit configuration; use the application settings form instead.

Run the isolated authentication checks from `backend` with
`..\.venv\Scripts\python.exe -m unittest test_local_auth test_browser_auth test_sqlite_store -v`.

---

## Project structure

```
garmin/
├── backend/
│   ├── main.py            # FastAPI app + routes, serves the frontend
│   ├── garmin_service.py  # Wrapper around the garminconnect library
│   └── requirements.txt
├── frontend/
│   ├── index.html         # Login + dashboard
│   ├── styles.css
│   └── app.js
├── start.ps1              # One-command launcher
└── .gitignore
```

## API endpoints

| Method | Path                       | Description                          |
| ------ | -------------------------- | ------------------------------------ |
| POST   | `/api/login`               | Email/password login                 |
| POST   | `/api/mfa`                 | Submit MFA code                      |
| POST   | `/api/logout`              | End the session                      |
| GET    | `/api/session`             | Check if authenticated               |
| GET    | `/api/profile`             | User profile                         |
| GET    | `/api/dashboard`           | Daily stats, VO₂ max, 7-day history  |
| GET    | `/api/activities?limit=25` | Recent activities                    |
| GET    | `/api/activities/{id}`     | Single activity detail               |

---

## Notes & troubleshooting

- **Unofficial API**: `garminconnect` uses the same private endpoints as the
  Garmin Connect website. Garmin may change them; if something stops working,
  update the library: `pip install -U garminconnect`.
- **Rate limits / "Too many requests"**: wait a few minutes before retrying.
- **No VO₂ max / training status**: these only appear if your device records
  them and there's data for the selected day.
- For commercial/production use you'd instead apply for the official
  [Garmin Health API](https://developer.garmin.com/), which needs partner
  approval.
