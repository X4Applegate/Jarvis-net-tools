#!/bin/bash
# Installs the standalone Jarvis Net Tools app (VPN-only). Run with sudo on the Pi.
set -e
SRC=/tmp/nettools-app
DEST=/opt/jarvis-nettools
CFGDIR=/etc/jarvis-nettools

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

echo "== Installing dependencies =="
apt-get install -y python3-flask avahi-utils nbtscan lldpd iperf3 ethtool tcpdump >/dev/null
systemctl enable --now iperf3 >/dev/null 2>&1 || true

echo "== Creating service user 'nettools' =="
id nettools >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin nettools

echo "== Copying app files =="
mkdir -p "$DEST"
cp -r "$SRC/app.py" "$SRC/nt_auth.py" "$SRC/netmon.py" "$SRC/static" "$DEST/"
mkdir -p /var/lib/jarvis-nettools && chown nettools:nettools /var/lib/jarvis-nettools
chown -R nettools:nettools "$DEST"

echo "== root helper + sudo allowlist =="
# The app user may NOT run nmap / tcpdump / timeout / arp-scan / ip ... directly: those can execute arbitrary commands as root.
# It may run only: the validating helper below, nmcli (WiFi control), wifi-clear and shutdown.
install -o root -g root -m 755 "$SRC/jarvis-priv" /usr/local/bin/jarvis-priv     # stage scripts/jarvis-priv next to app.py
NMCLI=$(command -v nmcli || echo /usr/bin/nmcli)
SHUTDOWN=$(command -v shutdown || echo /usr/sbin/shutdown)
cat > /etc/sudoers.d/jarvis-nettools <<EOF
nettools ALL=(root) NOPASSWD: /usr/local/bin/jarvis-priv, $NMCLI, /usr/local/bin/wifi-clear, $SHUTDOWN
EOF
chmod 440 /etc/sudoers.d/jarvis-nettools
visudo -cf /etc/sudoers.d/jarvis-nettools >/dev/null

echo "== App config (login password) =="
mkdir -p "$CFGDIR"
if [ ! -f "$CFGDIR/config.json" ]; then
  printf "Set the app login password: "
  read -rs PW1; echo
  printf "Confirm password: "
  read -rs PW2; echo
  [ "$PW1" = "$PW2" ] || { echo "Passwords didn't match."; exit 1; }
  [ ${#PW1} -ge 8 ] || { echo "Use at least 8 characters."; exit 1; }
  # password goes in through the environment (never on a command line), and only its salted hash is stored
  PW1="$PW1" SECRET="$(python3 -c "import secrets;print(secrets.token_hex(32))")" python3 - <<'PY'
import json, os, sys
sys.path.insert(0, "/opt/jarvis-nettools")
import nt_auth
json.dump({"password_hash": nt_auth.hash_password(os.environ["PW1"]), "secret_key": os.environ["SECRET"]}, open("/etc/jarvis-nettools/config.json", "w"))
PY
  echo "Config written."
else
  echo "Config already exists — keeping current password."
fi
chown -R nettools:nettools "$CFGDIR"
chmod 700 "$CFGDIR"; chmod 600 "$CFGDIR/config.json"

echo "== systemd service =="
cp "$SRC/jarvis-nettools.service" /etc/systemd/system/jarvis-nettools.service
cp "$SRC/jarvis-netmon.service" /etc/systemd/system/jarvis-netmon.service
systemctl daemon-reload
systemctl enable --now jarvis-nettools.service jarvis-netmon.service
sleep 2
systemctl is-active jarvis-nettools.service && echo "Service active." || { journalctl -u jarvis-nettools -n 20 --no-pager; exit 1; }

echo "== Local check =="
BIND=$(sed -n 's/^Environment=NETTOOLS_BIND=//p' /etc/systemd/system/jarvis-nettools.service | head -1); BIND=${BIND:-127.0.0.1}
curl -s -o /dev/null -w "app responds: HTTP %{http_code}\n" "http://$BIND:8092/api/me" || true
echo "DONE. App listening on $BIND:8092."
