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
3. On success, tokens are cached locally in `~/.garmin_portal_tokens` so you stay
   signed in across restarts. Delete that folder to fully sign out.

> Your credentials are sent only to your own local backend and are **not stored**
> anywhere — only the resulting Garmin session token is cached on your machine.

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
