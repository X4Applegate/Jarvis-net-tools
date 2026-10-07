#!/bin/bash
# Set the Jarvis Net Tools app login password with hidden input (never echoed, not in history).
set -u
CFG=/etc/jarvis-nettools/config.json
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo nettools-set-password"; exit 1; }
[ -f "$CFG" ] || { echo "App config not found at $CFG"; exit 1; }
read -rs -p "New app password: " P1; echo
read -rs -p "Repeat it: " P2; echo
[ "$P1" = "$P2" ] || { echo "Passwords didn't match — nothing changed."; exit 1; }
[ ${#P1} -ge 8 ] || { echo "Use at least 8 characters — nothing changed."; exit 1; }
# the config stores only a salted scrypt hash (same helper the app uses), never the password itself
P1="$P1" python3 - "$CFG" <<'PY'
import json, os, sys
sys.path.insert(0, "/opt/jarvis-nettools")
import nt_auth
p = sys.argv[1]; d = json.load(open(p))
d.pop("password", None); d["password_hash"] = nt_auth.hash_password(os.environ["P1"])
json.dump(d, open(p, "w"))
PY
unset P1 P2
chown nettools:nettools "$CFG"; chmod 600 "$CFG"
systemctl restart jarvis-nettools
echo "Done. Use the new password next time you unlock the app (existing phone sessions stay logged in)."
