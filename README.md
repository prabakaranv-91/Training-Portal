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
   `~/.training_lab/garmin_auth.json`. Set `GARMIN_AUTH_FILE` to override this path.
   Users are separated by normalized email, and the browser session references
   only its own account. Passwords and MFA codes are never saved in this file.
4. The browser holds an opaque HTTP-only session cookie. A hashed session lookup
   and its seven-day expiry are stored in the JSON file, allowing login recovery
   after a backend restart. Refreshed Garmin tokens update the same user's record.
5. Sign-out invalidates only that session and clears its cookie. Saved account
   tokens remain for the localhost-only **Use saved Garmin login** action: enter
   the account's email before selecting it. No account is picked automatically.
6. Garmin authentication does not use Google Sheets or require Apps Script.
   File writes are atomic; failed writes report an error rather than pretending
   login was saved. This local store supports a single backend worker.

> Treat the JSON file as sensitive credentials: Garmin's serialized token string
> is not encryption. Keep it private, outside version control, and protect it with
> the operating system's user-directory permissions. The old shared
> `.garmin_portal_tokens` cache is no longer used. Existing remote login rows are
> not deleted automatically; the repository's v7 Apps Script removes login-storage
> actions while retaining nutrition sync. Nutrition storage and Strava are unchanged.

Strava continues to use its official consent-based OAuth flow. Access and refresh
tokens are kept in encrypted HTTP-only browser cookies, not in a token file or
the Google Sheet. OAuth callbacks verify a browser-specific state, and activity
and weight caches are isolated by session. Start authorization from the local
app in the same browser, not from a bookmarked Strava login/authorization link.

Supply a stable Fernet key through `AUTH_COOKIE_KEY` in the deployment environment
to preserve Strava cookie validity after restarts and across workers. Without it,
the key lives only in process memory and Strava requires authorization again after
a backend restart. Production cookies require HTTPS (`Secure`, `HttpOnly`,
`SameSite=Lax`); localhost HTTP is supported. Cookies expire after seven days.
Sign-out clears the cookies; a stolen cookie remains a bearer credential until
expiry or provider revocation. The former `.strava_portal_tokens.json` file is
ignored, not automatically deleted. Cross-origin clients must be listed explicitly
in `AUTH_ALLOWED_ORIGINS` (comma-separated).

Run the isolated authentication checks from `backend` with
`..\.venv\Scripts\python.exe -m unittest test_local_auth test_browser_auth -v`.

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
