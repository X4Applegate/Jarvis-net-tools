#!/usr/bin/env bash
# SunFounder Pironman 5 Pro Max case software (0.96" OLED status screen, RGB fans/LEDs, power button) for a
# Jarvis Net Tools Pi with the touch-screen kiosk.
# Runs SunFounder's own installer non-interactively with three changes:
#   * skips its HDMI EDID plugin (it forces a phantom HDMI-A-1 output = a second, invisible screen for the kiosk)
#   * answers "no" to "auto-launch the dashboard on the 4.3\" screen" (the screen runs Jarvis Net Tools)
#   * does not reboot at the end
# then keeps the case's web dashboard (:34001, no login) and its InfluxDB (:8086/:8088) off every network except
# loopback and the VPN (wg1).  Reboot afterwards to load the case's device-tree overlay.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo $0"; exit 1; }
VARIANT="${1:-pro-max}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL https://raw.githubusercontent.com/sunfounder/pironman5/v1/install.sh -o "$tmp/install.sh"
sed -i 's|^    _hdmi_url=.*|    : # Jarvis: HDMI EDID plugin skipped|; s|^    RUN "curl -fsSL \\"$_hdmi_url\\" \| bash" "Install HDMI EDID plugin"|    : # (skipped)|' "$tmp/install.sh"
sed -i 's|^    read -p "Auto-launch dashboard on 4.3.*install_browser < /dev/tty|    install_browser=n|' "$tmp/install.sh"
sed -i 's|^    installer_prompt_reboot$|    echo "(reboot skipped)"|' "$tmp/install.sh"
grep -q 'HDMI EDID plugin skipped' "$tmp/install.sh" && grep -q 'install_browser=n' "$tmp/install.sh" && grep -q '(reboot skipped)' "$tmp/install.sh" \
  || { echo "SunFounder's installer changed - the three patches no longer apply; review $tmp/install.sh by hand"; trap - EXIT; exit 1; }
bash "$tmp/install.sh" --variant "$VARIANT" --no-autologin --plain-text </dev/null
install -m 644 "$HERE/jarvis-local-guard.nft" /etc/jarvis-local-guard.nft
install -m 644 "$HERE/jarvis-local-guard.service" /etc/systemd/system/jarvis-local-guard.service
systemctl daemon-reload; systemctl enable --now jarvis-local-guard.service
echo "done - reboot to load the case overlay (sudo reboot). Dashboard: http://<vpn-address>:34001 (VPN only)"
