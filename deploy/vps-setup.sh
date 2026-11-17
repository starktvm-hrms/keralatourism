#!/bin/bash
# One-time setup on the VPS (run as root) to serve the dashboard at
# https://kt.starkpeople.in with nginx and a Let's Encrypt certificate.
#   sudo bash vps-setup.sh you@example.com   # e-mail for certificate notices
# The DNS A record kt.starkpeople.in -> this VPS must already resolve.
# The files are copied in by .github/workflows/vps.yml.
set -euo pipefail
DOMAIN=${DOMAIN:-kt.starkpeople.in}
ROOT=/var/www/kt
EMAIL=${1:-}
DEPLOY_USER=${DEPLOY_USER:-deploy}

command -v nginx >/dev/null && command -v certbot >/dev/null && command -v rsync >/dev/null || {
  apt-get update || echo "apt-get update reported errors; continuing"
  apt-get install -y nginx rsync certbot python3-certbot-nginx
}

# the same "deploy" user GitHub uses for ktgame; it owns only the site folders
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  mkdir -p "/home/$DEPLOY_USER/.ssh"; touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chmod 700 "/home/$DEPLOY_USER/.ssh"; chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
fi
mkdir -p "$ROOT"
[ -f "$ROOT/index.html" ] || echo '<!doctype html><title>Kerala Tourism</title><p>Deploying soon.</p>' > "$ROOT/index.html"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$ROOT"

if [ ! -f /etc/nginx/sites-available/kt ]; then
cat > /etc/nginx/sites-available/kt <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    root $ROOT;
    index index.html;
    gzip on;
    gzip_types application/javascript application/json;
    add_header X-Robots-Tag "noindex, nofollow" always;
    location = /index.html { add_header Cache-Control "no-cache"; add_header X-Robots-Tag "noindex, nofollow" always; }
    location / { try_files \$uri \$uri/ /index.html; }
}
NGX
ln -sf /etc/nginx/sites-available/kt /etc/nginx/sites-enabled/kt
fi
nginx -t
systemctl reload nginx

if [ -n "$EMAIL" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
else
  certbot --nginx -d "$DOMAIN" --redirect
fi
echo "Done. Push to main (or run the 'Deploy dashboard to the VPS' workflow) to publish."
