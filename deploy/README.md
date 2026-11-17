# Running the dashboard on the VPS (kt.starkpeople.in)

The dashboard is a small Node app (no npm packages) behind nginx on the
existing VPS. Every push to `main` copies `server/` and `public/` to
`/opt/kt-dashboard` and restarts it (`.github/workflows/vps.yml`).

| What | Where on the VPS |
|---|---|
| App code | `/opt/kt-dashboard` |
| Logins, accounts, follower history | `/var/lib/kt-dashboard/*.json` |
| Apify token, session secret | `/etc/kt-dashboard.env` (root only) |
| Service | `systemctl status kt-dashboard`, logs: `journalctl -u kt-dashboard` |
| nginx site | `/etc/nginx/sites-available/kt` |

## One-time setup (as root on the VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/starktvm-hrms/keralatourism/main/deploy/vps-setup.sh -o vps-setup.sh
sudo bash vps-setup.sh
```

It asks for your Apify API token and the email/password for your first
dashboard login. It is safe to run again.

## Logins

Add a login or change a password:

```bash
sudo -u deploy env DATA_DIR=/var/lib/kt-dashboard node /opt/kt-dashboard/server/add-user.js someone@example.com
```

Remove one: add `--remove` to that command.

## Changing the Apify token

Edit `APIFY_TOKEN=` in `/etc/kt-dashboard.env`, then `systemctl restart kt-dashboard`.

## Backups

Copy `/var/lib/kt-dashboard/` — it holds everything the dashboard saves.
