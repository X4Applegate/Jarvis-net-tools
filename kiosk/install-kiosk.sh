#!/usr/bin/env bash
# Jarvis Net Tools - touch-screen kiosk for Raspberry Pi OS Lite (no desktop needed).   PRIVATE REPO ONLY.
#
# The Pi's own screen boots straight into the app: tty1 autologin (user "kiosk", no password, no sudo) -> labwc
# (small Wayland compositor) -> Chromium as a borderless maximised app window on http://127.0.0.1:8092 (loopback is
# trusted by the app, so no login on the screen) + squeekboard on-screen keyboard that pops up on text boxes.
# Screen sleeps after 10 min, a touch wakes it. SSH logins are untouched. Run as root after install-pi.sh. Idempotent.
#
#     sudo ./kiosk/install-kiosk.sh             install / update, then start the kiosk
#     sudo ./kiosk/install-kiosk.sh --uninstall stop it and remove the autologin (packages + kiosk user stay)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUSER=kiosk
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo $0"; exit 1; }

restart_kiosk() { /usr/local/sbin/jarvis-kiosk-restart; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -f /etc/systemd/system/getty@tty1.service.d/jarvis-kiosk.conf; systemctl daemon-reload
  [ -x /usr/local/sbin/jarvis-kiosk-restart ] && restart_kiosk || true        # tty1 is a normal login prompt again
  echo "kiosk autologin removed (user '$KUSER', packages and /usr/local files left in place)"; exit 0
fi

echo "== packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  labwc chromium swayidle wlopm squeekboard wlr-randr grim wtype wayland-utils dbus-user-session curl \
  fonts-dejavu-core fonts-noto-color-emoji libglib2.0-bin gsettings-desktop-schemas dconf-gsettings-backend librsvg2-common >/dev/null

echo "== kiosk user + autologin on the screen (tty1 only)"
id "$KUSER" >/dev/null 2>&1 || useradd -m -s /bin/bash -c "Jarvis touch-screen kiosk" "$KUSER"
usermod -aG video,render,input "$KUSER"; passwd -l "$KUSER" >/dev/null
KUID=$(id -u "$KUSER"); KHOME=$(getent passwd "$KUSER" | cut -d: -f6)
install -d /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/jarvis-kiosk.conf <<CONF
# Jarvis kiosk: log the kiosk user in on the touch screen (tty1) automatically
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KUSER --noclear --noissue %I \$TERM
CONF

echo "== browser launcher, restart helper, Chromium policy"
install -m 755 "$HERE/jarvis-kiosk-browser" /usr/local/bin/jarvis-kiosk-browser
cat > /usr/local/sbin/jarvis-kiosk-restart <<'SH'
#!/bin/bash
# Restart the touch-screen kiosk session (labwc + Chromium + keyboard) cleanly. Kiosk-user processes only.
systemctl stop getty@tty1; sleep 1
for p in $(pgrep -u kiosk -f "^/bin/bash /usr/local/bin/jarvis-kiosk-browser"); do kill "$p"; done
for p in $(pgrep -u kiosk -x labwc); do kill "$p"; done; sleep 3
for p in $(pgrep -u kiosk -f "^/usr/lib/chromium/chromium|^squeekboard|^swayidle"); do kill "$p" 2>/dev/null; done; sleep 1
systemctl start getty@tty1
SH
chmod 755 /usr/local/sbin/jarvis-kiosk-restart
install -d /etc/chromium/policies/managed
cat > /etc/chromium/policies/managed/jarvis-kiosk.json <<'JSON'
{ "PasswordManagerEnabled": false, "TranslateEnabled": false, "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false, "BrowserSignin": 0, "SyncDisabled": true,
  "DefaultBrowserSettingEnabled": false, "MetricsReportingEnabled": false, "PromotionsEnabled": false }
JSON

echo "== on-screen keyboard (squeekboard): on by default + the 3 key icons Raspberry Pi OS Lite lacks"
cat > /usr/share/glib-2.0/schemas/90_jarvis-kiosk.gschema.override <<'GS'
[org.gnome.desktop.a11y.applications]
screen-keyboard-enabled=true
GS
glib-compile-schemas /usr/share/glib-2.0/schemas
d=/usr/share/icons/hicolor/scalable/actions; install -d "$d"
cat > "$d/key-shift.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M12 3 3 12.5h5V20h8v-7.5h5z" fill="none" stroke="#e8eaed" stroke-width="2" stroke-linejoin="round"/></svg>
SVG
cat > "$d/key-enter.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 5v7H6.5m0 0 4-4m-4 4 4 4" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
SVG
cat > "$d/keyboard-mode-symbolic.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="3.5" width="14" height="9" rx="1.5" fill="none" stroke="#bebebe" stroke-width="1.2"/><path d="M3.5 6h1m2 0h1m2 0h1m2 0h1M3.5 8h1m2 0h1m2 0h1m2 0h1M5 10.2h6" stroke="#bebebe" stroke-width="1.2" stroke-linecap="round"/></svg>
SVG
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -f /usr/share/icons/hicolor || true

echo "== invisible mouse pointer (touch only)"
python3 "$HERE/blank-cursor.py" /usr/local/share/icons/jarvis-blank

echo "== labwc session"
install -d -o "$KUSER" -g "$KUSER" "$KHOME/.config" "$KHOME/.config/labwc" "$KHOME/.config/gtk-3.0"
cat > "$KHOME/.bash_profile" <<'BP'
# Jarvis kiosk: start the touch-screen session on the Pi's own screen only (tty1)
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(tty)" = "/dev/tty1" ]; then
  exec labwc > "$HOME/.labwc.log" 2>&1
fi
BP
cat > "$KHOME/.config/labwc/environment" <<ENVF
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$KUID/bus
XCURSOR_SIZE=24
XCURSOR_THEME=jarvis-blank
XCURSOR_PATH=/usr/local/share/icons:/usr/share/icons
GTK_THEME=Adwaita:dark
ENVF
cat > "$KHOME/.config/labwc/autostart" <<'AS'
# screen off after 30 minutes without a touch; a touch wakes it
swayidle -w timeout 1800 'wlopm --off "*"' resume 'wlopm --on "*"' >/dev/null 2>&1 &
# on-screen keyboard: pops up when a text box gets focus
squeekboard >/dev/null 2>&1 &
/usr/local/bin/jarvis-kiosk-browser >/dev/null 2>&1 &
AS
cat > "$KHOME/.config/labwc/rc.xml" <<'RC'
<?xml version="1.0"?>
<labwc_config>
  <core><gap>0</gap></core>
  <windowRules>
    <!-- maximised, not fullscreen: the on-screen keyboard (a layer surface) can overlay it and the page shrinks above it -->
    <windowRule identifier="*" serverDecoration="no">
      <action name="Maximize" />
    </windowRule>
  </windowRules>
</labwc_config>
RC
printf '[Settings]\ngtk-application-prefer-dark-theme=1\n' > "$KHOME/.config/gtk-3.0/settings.ini"
chown -R "$KUSER:$KUSER" "$KHOME/.bash_profile" "$KHOME/.config"
systemctl daemon-reload
echo "== starting the kiosk"; restart_kiosk
echo "done - the screen shows Jarvis Net Tools in a few seconds (restart it any time: sudo jarvis-kiosk-restart)"
