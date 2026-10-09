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
Then open <http://127.0.0.1:8000> and sign in with a connected provider.

### Manual start

```powershell
cd c:\Work\garmin
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
python -m backend.main
```

Open <http://127.0.0.1:8000>.

---

## How login works

1. Enter your **Garmin Connect email and password** in the web UI.
2. If your account has **multi-factor authentication (MFA)** enabled, you'll be
   prompted for the code from your authenticator app / email.
3. Strava sign-in uses its consent-based authorization flow.
4. Sign out from the application to end the active session.

Authentication, integration credentials, and provider usage counters use SQLite
under the root `data/` directory. Nutrition data uses only the configured Google Sheet.

## Application settings and migration

Garmin and Strava are the only login identities. There is no pre-login setup or
local username/password account. Strava sign-in uses its consent-based flow.

After login, the app checks saved **Google sheet** and **AI model** settings
automatically. If a saved connection is missing or cannot be verified, **Settings**
guides the required change. Generate the sheet token before the personalized Apps
Script download becomes available. Nutrition endpoints enforce the same readiness
requirement; hiding or bypassing the wizard does not unlock them.

Users who skip setup can use the training Dashboard only. Its nutrition panel and
food-chat controls remain hidden until both checks pass. Reopen **Settings** to
complete configuration, then select **Open Fit Squad**. Changing or disabling the
saved integrations invalidates readiness and blocks nutrition again.

Models and API keys can be changed only in **Settings**. LiteLLM routes the selected
provider and model. Supported providers must work with a single API key. Providers
requiring additional credentials or custom deployment URLs are not configured by
this form. Verification sends a small completion request; provider charges may
apply. Model changes invalidate setup readiness and cached daily reviews.

Garmin's authenticated email is normalized and uniquely associated with a tracker.
Strava's API does not return email, so the app does not guess an email or match on
display name. To combine an existing Garmin and Strava tracker, sign in with
Garmin, open **Settings**, select **Link Strava to this tracker**, and approve
Strava consent once. Both verified logins then resolve to the same profile.
The linked tracker uses its canonical Google Sheet and user tabs;
the canonical tracker's existing integration settings take precedence. Profiles with different
verified email addresses are not silently combined.

Previously migrated settings remain scoped to their existing account. Ambiguous
legacy configuration remains quarantined for manual recovery. Settings endpoints
require an authenticated provider session.

Initial setup migrates existing configuration into SQLite, but does not import
nutrition files or caches. Historical local nutrition files are not read, migrated,
or synchronized back into the sheet.
Use Settings to change integrations.

### Google Sheets is the nutrition source of truth

Food entries, portions, nutrition values, removed-item history, day summaries,
programs, weights, and reviews are read from and written directly to the configured
Google Sheet. There is no local nutrition database, disk cache, browser storage,
or offline write queue. A successful mutation requires the sheet to acknowledge
the write. Sheet failures return an error rather than an empty day or local fallback.
Changing sheet cells is reflected by the next request or page refresh.

Apps Script **version 8 or later** is required. Existing sheet rows remain readable; new
metadata columns preserve complete entry and day information in the sheet.
The latest download is **version 9**, which batches entry updates, avoids per-row
deletions, and preserves unrelated rows and extra columns. Redeploy it to enable
these Google-side performance improvements. Restarting the local app does not
update an existing Apps Script deployment.

Chat confirms a meal once Google Sheets acknowledges the entry write. Tracker
refreshes and daily-total updates happen afterward without delaying confirmation.
A failed sheet write is never reported as saved. Chat entries are displayed in
chronological order, irrespective of their sheet row order.

To upgrade an existing deployment:

1. Open Settings after signing in and download the personalized Apps Script.
2. In the existing spreadsheet, open Extensions > Apps Script and replace the code.
3. Select Deploy > Manage deployments > Edit > New version > Deploy. Keep the same URL.
4. Return to Settings and select Save and check for Google Sheets.

Old sheet verifications are invalidated by this upgrade. Nutrition remains blocked
until a version 8-or-later deployment verifies successfully. Existing local databases and
backups are historical only and are not used as a fallback; they are not deleted
automatically before the live sheet data can be verified.

Run the test suite from the repository root with
`.venv\Scripts\python.exe -m unittest discover -s tests -v`.

---

## Project structure

```
garmin/
├── backend/
│   ├── main.py
│   ├── services/
│   ├── utils/
│   └── requirements.txt
├── frontend/
├── tests/
├── data/
├── start.ps1
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
