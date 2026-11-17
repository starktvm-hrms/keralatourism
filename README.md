# Kerala Tourism social dashboard

Live at https://kt.starkpeople.in (sign-in required).

Tracks follower counts for Kerala Tourism's social media accounts and for
domestic and international competitor tourism boards, on Instagram,
Facebook, YouTube and X. Counts are fetched from public profiles with
Apify on a schedule (weekly, daily or manual) and kept as history, so the
monthly and yearly charts fill in from the first fetch onwards.

- **Social media performance** — your own accounts: followers per platform, change over 30 days and 1 year, charts by day, month or year.
- **Domestic competitors / International competitors** — the same figures side by side with your account.
- **Accounts** — add, edit or remove accounts and their usernames; choose how often to fetch; see what the last fetch returned.

## Code

- `server/server.js` — web server: sign-in, API, scheduled fetches (Node 18+, no npm packages)
- `server/apify.js` — Apify actors used and how usernames are read
- `server/store.js` — JSON files in `DATA_DIR`
- `server/add-user.js` — add or remove a login from the command line
- `public/` — the page (`index.html`, `app.js`, `app.css`, d3 v7.9.0 under its ISC licence)

Run locally:

```bash
export DATA_DIR=./data SESSION_SECRET=$(openssl rand -hex 32) APIFY_TOKEN=<token>
node server/add-user.js you@example.com
node server/server.js   # http://localhost:3107
```

Deployment: see `deploy/README.md`.
