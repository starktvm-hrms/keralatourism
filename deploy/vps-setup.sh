#!/bin/bash
# One-time setup on the existing VPS (run as root) for https://kt.starkpeople.in:
#   curl -fsSL https://raw.githubusercontent.com/starktvm-hrms/keralatourism/main/deploy/vps-setup.sh -o vps-setup.sh
#   sudo bash vps-setup.sh
# It is safe to run again: existing settings, logins and data are kept.
#
# What it does:
#  - checks Node.js 18+ (installs it with apt only if missing)
#  - puts the app in /opt/kt-dashboard (owned by the "deploy" user GitHub uses)
#  - keeps data (logins, accounts, follower history) in /var/lib/kt-dashboard
#  - stores the Apify token and a session secret in /etc/kt-dashboard.env (root only)
#  - runs the app as a systemd service "kt-dashboard" on 127.0.0.1:3107
#  - lets "deploy" restart only that service (for GitHub Actions)
#  - points nginx for kt.starkpeople.in at the app, keeping the HTTPS certificate
#  - creates your first dashboard login
set -euo pipefail
DOMAIN=kt.starkpeople.in
APP=/opt/kt-dashboard
DATA=/var/lib/kt-dashboard
ENVF=/etc/kt-dashboard.env
PORT=${PORT:-3107}
DEPLOY_USER=${DEPLOY_USER:-deploy}
REPO_TAR=https://codeload.github.com/starktvm-hrms/keralatourism/tar.gz/refs/heads/main

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo bash vps-setup.sh)"; exit 1; }

# --- Node.js ---
NODE=$(command -v node || true)
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  apt-get update || true
  apt-get install -y nodejs
  NODE=$(command -v node)
fi
echo "Node $("$NODE" -v) at $NODE"

# --- user and folders ---
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  mkdir -p "/home/$DEPLOY_USER/.ssh"; touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chmod 700 "/home/$DEPLOY_USER/.ssh"; chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
fi
mkdir -p "$APP" "$DATA"
if [ ! -f "$APP/server/server.js" ]; then
  echo "Downloading the app from GitHub..."
  curl -fsSL "$REPO_TAR" | tar -xz -C "$APP" --strip-components=1 --wildcards '*/server' '*/public'
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP" "$DATA"
chmod 700 "$DATA"

# --- secrets ---
if [ ! -f "$ENVF" ]; then
  read -rsp "Apify API token (Apify Console > Settings > API & Integrations): " APIFY_TOKEN; echo
  [ -n "$APIFY_TOKEN" ] || { echo "An Apify token is needed."; exit 1; }
  umask 077
  cat > "$ENVF" <<EOF
PORT=$PORT
DATA_DIR=$DATA
SESSION_SECRET=$(openssl rand -hex 32)
APIFY_TOKEN=$APIFY_TOKEN
EOF
  unset APIFY_TOKEN
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"
PORT=$(grep -E '^PORT=' "$ENVF" | cut -d= -f2)

# --- port check ---
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet kt-dashboard; then
  echo "Port $PORT is already used by another program. Re-run with PORT=<free port> after deleting $ENVF."; exit 1
fi

# --- service ---
cat > /etc/systemd/system/kt-dashboard.service <<EOF
[Unit]
Description=Kerala Tourism social dashboard
After=network-online.target
Wants=network-online.target

[Service]
User=$DEPLOY_USER
EnvironmentFile=$ENVF
ExecStart=$NODE $APP/server/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kt-dashboard
systemctl restart kt-dashboard

# GitHub Actions (as deploy) may restart this one service, nothing else
SUDOERS=/etc/sudoers.d/kt-dashboard
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart kt-dashboard, /bin/systemctl restart kt-dashboard" > "$SUDOERS.tmp"
chmod 440 "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null && mv "$SUDOERS.tmp" "$SUDOERS"

# --- nginx ---
SITE=/etc/nginx/sites-available/kt
[ -f "$SITE" ] && cp "$SITE" "$SITE.bak.$(date +%Y%m%d%H%M%S)"
PROXY="    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }"
CERT=/etc/letsencrypt/live/$DOMAIN
if [ -f "$CERT/fullchain.pem" ]; then
  cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    ssl_certificate $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
$PROXY
}
EOF
else
  cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
$PROXY
}
EOF
fi
ln -sf "$SITE" /etc/nginx/sites-enabled/kt
nginx -t
systemctl reload nginx
[ -f "$CERT/fullchain.pem" ] || certbot --nginx -d "$DOMAIN" --redirect

# --- first login ---
sleep 1
if ! sudo -u "$DEPLOY_USER" test -s "$DATA/users.json"; then
  read -rp "Email for your dashboard login: " EMAIL
  sudo -u "$DEPLOY_USER" env DATA_DIR="$DATA" "$NODE" "$APP/server/add-user.js" "$EMAIL"
fi

systemctl is-active --quiet kt-dashboard && echo "kt-dashboard is running."
echo "Done: https://$DOMAIN"
echo "Add another login or change a password later with:"
echo "  sudo -u $DEPLOY_USER env DATA_DIR=$DATA $NODE $APP/server/add-user.js someone@example.com"
