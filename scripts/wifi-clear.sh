#!/bin/bash
# wifi-clear: remove saved WiFi profiles for sites you've visited, so client
# WiFi passwords don't linger on this portable device.
# Always KEEPS: your own networks (patterns in /etc/jarvis-nettools/keep-networks, one per line;
# JarvisPi* management/setup APs; any Hotspot) AND whatever WiFi is active right now (so it never cuts
# your current connection). Everything else saved is deleted.
set -u

KEEP='JarvisPi|Hotspot'
if [ -r /etc/jarvis-nettools/keep-networks ]; then
  EXTRA=$(grep -vE '^[[:space:]]*(#|$)' /etc/jarvis-nettools/keep-networks | paste -sd'|' -)
  [ -n "$EXTRA" ] && KEEP="$KEEP|$EXTRA"
fi
# Every currently-active WiFi connection (any radio) — never deleted.
ACTIVE=$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: '$2 ~ /^wlan/ {print $1}')

echo "Protected: your own networks + anything currently connected"
[ -n "$ACTIVE" ] && echo "Currently connected (kept): $ACTIVE"
echo "Clearing visited-site WiFi..."
nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print $1}' | sort -u | while read -r name; do
  if echo "$name" | grep -qiE "$KEEP"; then continue; fi
  if printf '%s\n' "$ACTIVE" | grep -qxF "$name"; then echo "  kept (in use): $name"; continue; fi
  echo "  deleted: $name"
  sudo nmcli connection delete "$name" >/dev/null 2>&1
done

echo
echo "Remaining saved WiFi:"
nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print "  "$1}' | sort -u
