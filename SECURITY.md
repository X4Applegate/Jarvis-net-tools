# Security

## Reporting a problem

Please report security problems **privately**: use GitHub's *Report a vulnerability* button on the
repository's Security tab (private vulnerability reporting), or contact the maintainer through the
GitHub profile X4Applegate. Please do not open a public issue for a vulnerability. This is a personal
project, so replies are best-effort, but reports are appreciated.

## Security model in one page

Jarvis Net Tools runs on a Raspberry Pi that travels between networks and is meant to be reached
**only over a private VPN**; it is not designed to be exposed to the internet.

- **Login**: one app password, stored only as a salted **scrypt** hash. Wrong passwords are throttled
  (5 free tries, then lock-outs doubling from 30 s to 15 min per client). When the app sits behind a
  reverse proxy, the proxy's address must be listed in `trusted_proxies` so the real client is used.
- **No hidden doors**: unauthenticated access exists only for loopback (the Cockpit page) and,
  optionally, a configured monitoring hub for read-only `GET`s (**off unless configured**).
- **Least privilege**: the web app runs as an unprivileged user. Its sudo rights are four entries:
  a small validating helper (`scripts/jarvis-priv`), `nmcli`, `wifi-clear` and `shutdown`. The helper
  allows a fixed set of operations and checks every argument (no scripts except one fixed discovery
  script, no output files, interface/target syntax). Raw `nmap`, `tcpdump`, `timeout`, `ip` and
  similar - which can run arbitrary commands as root - are deliberately not in sudoers.
- **Web hardening**: session cookie `HttpOnly` + `SameSite=Lax`, request bodies capped at 256 KB,
  `Cache-Control: no-store` on the API, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  and a strict **Content-Security-Policy** on the app page (own scripts only, no inline script, no framing).
- **Agent access** (optional): bearer tokens stored only as hashes, scoped (`read` / `act` / `control`),
  rate-limited and logged; anything outside a token's scope returns 403.
- **Secrets** (password hash, session key, API tokens) live only in `/etc/jarvis-nettools/config.json`
  (mode 600) and are never part of this repository.

## Known limits (worth knowing if you review the code)

- `nmcli` is allowed as root so the app can manage Wi-Fi; it can reconfigure networking on the Pi.
- Anything running as a local user on the Pi can call the API through loopback without a login (by design,
  for Cockpit).
- Login lock-out state is kept in memory, so a service restart clears it.
- The optional captive "setup" hotspot is for first-time Wi-Fi setup; treat its network as untrusted.

## Checklist for anyone running something similar

Reach it only through a VPN, bind it to that address, keep `config.json` at mode 600, set
`trusted_proxies` only to your real proxy, set `NETTOOLS_COOKIE_SECURE=1` when you only use https,
and keep sudoers to the four entries above.
