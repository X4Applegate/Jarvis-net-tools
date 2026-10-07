#!/bin/bash
# Jarvis Pi WiFi onboarding portal.
# Raises the device's OWN clearly-named setup access point ONLY when the Pi
# has no internet, so the owner can pick/enter an upstream WiFi from a phone.
# It does not impersonate any other network and does not touch other devices'
# traffic. When online (ethernet or a known WiFi), it stays dormant.
set -u

ENV_FILE=/etc/jarvis-wifi-portal.env
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
PORTAL_SSID="${PORTAL_SSID:-JarvisPi-Setup}"
PORTAL_PASS="${PORTAL_PASS:-}"
IFACE="${PORTAL_IFACE:-wlan0}"
UI_DIR=/usr/local/share/wifi-connect/ui

online() {
  [ "$(nmcli -t -f CONNECTIVITY general 2>/dev/null)" = "full" ]
}

while true; do
  if online; then
    sleep 30
    continue
  fi
  # Give NetworkManager's normal auto-connect a grace period first.
  sleep 45
  if online; then
    continue
  fi
  # Still offline -> raise the setup portal. Blocks until the user finishes a
  # connection or 10 min of inactivity, then the loop re-evaluates.
  ARGS=(--portal-ssid "$PORTAL_SSID" \
        --portal-interface "$IFACE" \
        --ui-directory "$UI_DIR" \
        --activity-timeout 600)
  [ -n "$PORTAL_PASS" ] && ARGS+=(--portal-passphrase "$PORTAL_PASS")
  /usr/local/sbin/wifi-connect "${ARGS[@]}" || true
  sleep 10
done
