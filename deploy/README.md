# Hosting the dashboard at kt.starkpeople.in

Every push to `main` builds `dist/index.html` and copies it to the VPS
(`.github/workflows/vps.yml`), the same way ktgame is deployed.

## One-time setup

1. **DNS** — done: `kt.starkpeople.in` has an A record to the VPS (76.13.241.150).
2. **VPS** — as root on the VPS (hPanel → VPS → Browser terminal):
   `sudo bash vps-setup.sh you@example.com`
   It reuses the existing `deploy` user, creates `/var/www/kt`, adds an
   nginx site for this subdomain only and gets the HTTPS certificate.
3. **GitHub secrets** — in this repository: Settings → Secrets and variables
   → Actions. Add the same values used in the ktgame repository:
   `VPS_HOST`, `VPS_USER` (`deploy`), `VPS_SSH_KEY`, and `VPS_PORT` if set there.
4. **Deploy** — Actions → "Deploy dashboard to the VPS" → Run workflow, or push.
