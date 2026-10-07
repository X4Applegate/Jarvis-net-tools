#!/bin/bash
# Securely store the ipinfo API token in the Net Tools app config.
# The token is read with hidden input and passed to python via the environment
# (not the command line), so it never appears on screen, in shell history, or in
# the process argument list. Run with sudo.
set -u
CFG=/etc/jarvis-nettools/config.json

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo nettools-set-ipinfo"; exit 1; }
[ -f "$CFG" ] || { echo "App config not found at $CFG — is the app installed?"; exit 1; }

read -rs -p "Paste your ipinfo token, then press Enter: " TOK; echo
[ -n "$TOK" ] || { echo "No token entered — nothing changed."; exit 1; }

TOK="$TOK" python3 - "$CFG" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p))
d["ipinfo_token"] = os.environ["TOK"]
json.dump(d, open(p, "w"))
PY
unset TOK

chown nettools:nettools "$CFG" 2>/dev/null || true
chmod 600 "$CFG"
systemctl restart jarvis-nettools
echo "Saved. Public IP & ISP will now use your ipinfo token."
