# Kerala Tourism social dashboard

Follower counts and growth (monthly and yearly) for Kerala Tourism's social
media and for competitor state tourism boards. Live at https://kt.starkpeople.in.

- `src/page.html` — the dashboard (tabs, charts, sign-in)
- `src/shell.html` — page shell, theme and the small runtime the dashboard uses
- `src/followers_monthly.json` — **sample data** (illustrative, not real figures)
- `vendor/d3.min.js` — d3 v7.9.0 (ISC licence, `vendor/d3.LICENSE`)
- `build.py` — builds the single-file `dist/index.html`

Build locally: `python3 build.py`, then open `dist/index.html`.

The sign-in screen is a check inside the page, not a security boundary:
anyone who loads the page can read its source and data.
Deployment: see `deploy/README.md`.
