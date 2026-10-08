# 🏃 Fit Squad

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

Garmin and Strava are the only login identities. There is no pre-login setup or
local username/password account. Garmin generates its provider token during the
normal email/password/MFA login. Strava uses the existing server-managed OAuth
app: users approve consent without entering application client credentials.

After login, users must verify their own **Google sheet** and **LLM** settings
before using food logging, nutrition analysis, or the chat tracker. The two-step
wizard includes an explanation of the purpose and data involved, plus an
**Instructions** link for each step. Generate the private sheet token before the
personalized Apps Script download becomes available. Nutrition endpoints enforce
the same readiness requirement; hiding or bypassing the wizard does not unlock them.

Users who skip setup can use the training Dashboard only. Its nutrition panel and
food-chat controls remain hidden until both checks pass. Reopen **Settings** to
complete configuration, then select **Open FitMate**. Changing or disabling the
saved integrations invalidates readiness and blocks nutrition again.

Settings are saved in the verified user's private SQLite scope. Secrets are never
returned by the settings API; blank secret fields preserve existing values.
Garmin passwords are not stored and Garmin credential fields are not part of setup.

Models and API keys can be changed only in **Settings**. LiteLLM routes each user's
private provider/model choice to Gemini, OpenAI, Anthropic, Groq, Mistral,
OpenRouter, or another LiteLLM provider supporting a single API key. Providers
requiring additional credentials or custom deployment URLs are not configured by
this form. Verification sends a small completion request; provider charges may
apply. Meal descriptions and nutrition data are sent to the chosen provider, but
tracker login tokens and Sheets tokens are not. Model changes invalidate setup
readiness and cached daily reviews. Legacy Gemini settings remain compatible.

The existing Strava application credentials are held in SQLite's
`strava_app_config` setting and are never returned by user settings APIs.
Each Strava user's access/refresh tokens remain separate in SQLite. Strava itself
controls consent, application approval and athlete-capacity limits.

Garmin's authenticated email is normalized and uniquely associated with a tracker.
Strava's API does not return email, so the app does not guess an email or match on
display name. To combine an existing Garmin and Strava tracker, sign in with
Garmin, open **Settings**, select **Link Strava to this tracker**, and approve
Strava consent once. Both verified logins then resolve to the same profile.
Existing food histories are merged by entry ID without dropping either history;
the canonical tracker's existing settings take precedence. Profiles with different
verified email addresses are not silently combined.

Previously migrated Sheets/LLM configuration is assigned only to the existing
provider account, never inherited by new setups or users. Ambiguous legacy
configuration remains quarantined for manual recovery. Settings endpoints reject
unauthenticated requests without a valid provider session.

At first database initialization, the app imports `strava_config.json`,
`nutrition_config.json`, `nutrition_secrets.json`, legacy Garmin accounts and
sessions, nutrition logs, caches, and retry state. Existing credential environment
variables are accepted only as one-time migration inputs. Subsequent reads and
writes use SQLite exclusively. Superseded local configuration JSON files have
been removed after archiving their original values in a private SQLite record
and backing up the database under `backend/data/backups/`. Active settings are
not overwritten by archived values; keep the database and backups private.

Legacy nutrition logs can only be adopted by the verified migrated owner.
Existing encrypted Strava browser cookies require a one-time reconnect;
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
