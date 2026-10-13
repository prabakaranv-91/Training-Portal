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

## Quick start (macOS / Linux)

```sh
cd /path/to/garmin
sh ./start.sh
```

The launcher creates `.venv` if needed, installs backend dependencies, and starts
the server on the configured port or the next available port. Python 3.10 or newer
is required.

## Public Linux Server

Use the Docker Compose deployment for public access with automatic HTTPS,
persistent storage, and a private backend:

```sh
cp .env.example .env
# Set APP_DOMAIN and ACME_EMAIL in .env, then:
sh deploy.sh up
```

A domain pointing to the server, Docker Engine with Compose v2, and open TCP ports
18080/18443 are required by default. Set `HTTP_PORT` and `HTTPS_PORT` in `.env`
to choose other available ports. Automatic certificates also require public port
80 certificate-validation requests to be forwarded to the configured HTTP port
by an existing reverse proxy. Open `https://YOUR_DOMAIN:18443` after deployment,
or use your configured HTTPS port.
See [the deployment guide](deploy/README.md) for Strava
configuration, updates, backups, restore, and public-launch security requirements.
The development launchers above remain local-only.

---

## How login works

1. Enter your **Garmin Connect email and password** in the web UI.
2. If your account has **multi-factor authentication (MFA)** enabled, you'll be
   prompted for the code from your authenticator app / email.
3. Strava sign-in uses its consent-based authorization flow.
4. Sign out from the application to end the active session.

Authentication, integration credentials, and provider usage counters use SQLite
under the root `data/` directory. Nutrition data is stored in the same SQLite database,
with every record isolated by the authenticated profile scope.

## Application settings and migration

Garmin and Strava are the only login identities. There is no pre-login setup or
local username/password account. Strava sign-in uses its consent-based flow.

After login, the app checks the saved **AI model** settings automatically. If the
model is missing or cannot be verified, **Settings** guides the required change.
Nutrition endpoints enforce the same readiness requirement; hiding or bypassing the
wizard does not unlock them.

Users who skip setup can use the training Dashboard only. Its nutrition panel and
food-chat controls remain hidden until the model check passes. Reopen **Settings** to
complete configuration, then select **Open Fit Squad**. Changing or disabling the
saved model invalidates readiness and blocks nutrition again.

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
The linked tracker uses its canonical nutrition records and integration settings.
Profiles with different
verified email addresses are not silently combined.

Previously migrated settings remain scoped to their existing account. Ambiguous
legacy configuration remains quarantined for manual recovery. Settings endpoints
require an authenticated provider session.

Nutrition records are stored in normalized SQLite tables: entry metadata, individual
food items, day snapshots, program changes, weights, and day reviews. The database
uses the authenticated profile scope as part of every record key, so linked providers
share their profile's history while other users remain isolated. Existing nutrition
records were imported into SQLite once; the app no longer contacts a spreadsheet.
A pre-import database backup is retained under `data/backups/`.

Chat confirms a meal after the SQLite transaction commits. A failed database write
is never reported as saved. Chat entries are displayed in chronological order.

To correct a logged food, click its calorie value or open its food details and
select **Edit nutrition**. Calories, protein, carbs, fat, fibre, sugar, and sodium
can be edited for the currently logged portion. **Save nutrition** persists the
correction and refreshes daily totals; **Cancel** discards unsaved changes. Foods
grouped across meals retain separate editable portions. Quantity changes scale
the corrected values. Removed foods cannot be edited, and reanalysis can replace
manual corrections with newly calculated values.

For named restaurant meals, the configured LLM identifies the restaurant, exact
dish, and a candidate nutrition-page URL without a fixed restaurant list. The app
fetches a public HTTPS page and asks the same model to extract published values.
Restaurant identity, dish variant, serving basis, nutrient labels, units, and
supporting quotes must match the fetched document before values override estimates.
Explicit nutrition values supplied in your message take priority. Unpublished
nutrients retain their estimates; unknown sources, inaccessible pages, or ambiguous
matches keep the existing calculation. The source URL is retained in the food's
source metadata. A suggested URL is not itself proof that a site is authoritative.

Lookup supports readable HTML, JSON, and text. Image-only menus, PDFs, and
JavaScript-only calculator results are not extracted. Model suggestions are not
a live web-search service and may miss newer menus. Matching pages can require
one additional model completion, with provider charges and extra latency. Existing
saved meals are not automatically recalculated.

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
