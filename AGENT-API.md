# Jarvis Pi — agent API

Lets other agents / automations look at the Pi, and optionally trigger a speed test, **without SSH or root**.
Reachable only over the VPN: `http://<pi-vpn-ip>:8092` (the app binds the wg1 address + loopback).

## Tokens
Managed on the Pi (as root) with `nettools-agent-token` (`scripts/nettools-agent-token`):

```
nettools-agent-token add <id> <read|act|control>   # token is written to /root/agent-tokens/<id>.token (0600), never printed
nettools-agent-token list
nettools-agent-token revoke <id>           # effective immediately
nettools-agent-token log [N]               # who called what
```
Only a SHA-256 hash is kept on the Pi (`/var/lib/jarvis-nettools/agent-tokens.json`). Send the token as
`Authorization: Bearer <token>`. Hand tokens over out-of-band (read the file in your own terminal); never paste them into chat.

| scope | can do |
|---|---|
| `read` | the GET endpoints below, plus `POST /api/aps` and `POST /api/scanall` (rescans: they briefly disturb WiFi) |
| `act`  | everything in `read`, plus `POST /api/speedtest` |
| `control` | everything in `act`, plus `POST /api/agent/ap` (temporarily pin an AP or band, see below) |

Everything else (settings, passwords, joining networks, ...) returns **403** for any token. Limits: 60 requests/min per token;
minimum gap per call: `/api/report` 20 s, `/api/aps` 10 s, `/api/scanall` 20 s, `/api/speedtest` 60 s, `/api/agent/ap` 30 s (otherwise **429** with `Retry-After`).
Every call is logged to `/var/lib/jarvis-nettools/agent-access.log`.

## Endpoints
| call | returns |
|---|---|
| `GET /api/agent/summary` | **start here**: how the Pi is connected (WiFi/Ethernet), SSID, AP (BSSID + saved name), band, signal, link rate, adapter USB speed (480 = USB 2 problem), last speed test + bufferbloat grade, APs in range, monitor state |
| `GET /api/status`, `GET /api/signal` | raw `iw link` text |
| `GET /api/netmon/status?hours=24`, `/timeline`, `/speed?hours=168` | outage monitor + speed test history |
| `GET /api/wifi/saved`, `GET /api/apnames` | saved networks, AP names |
| `GET /api/report?site=<name>[&format=md]` | full site report (HTML or Markdown). Slow (about a minute): it rescans |
| `POST /api/aps` `{"ssid": "...", "rescan": false}` | access points broadcasting that SSID |
| `POST /api/scanall` | every network in range (about 11 s) |
| `POST /api/agent/ap` *(control)* | pin the Pi to one AP/band on the network it is already on (see below) |
| `POST /api/speedtest` *(act)* | runs a speed test (about 30-60 s): down/up/ping, loaded latency, bufferbloat grade |

Example: `curl -s -H "Authorization: Bearer $TOKEN" http://<pi-vpn-ip>:8092/api/agent/summary`

## Reading the numbers
- Bufferbloat grade is the *rise* in latency under load: A+ <5 ms, A <30, B <60, C <200, D <400, F above.
- A pinned or "stuck" AP shows as a weak `signal_dbm` (-70 or worse) with low `rx_mbps`; compare `aps_in_range`.
- `adapter_usb_mbps` = 480 means the Alfa fell back to USB 2 (about 150-250 Mbps max); 5000 is correct.

## Changing the access point (`control` scope)
`POST /api/agent/ap` with JSON `{"bssid": "02:00:5e:00:00:01", "band": "auto", "hold_minutes": 15}`
- `bssid` pins one AP (empty = no AP pin); `band` is `auto|2.4|5|6` (ignored when `bssid` is set); `hold_minutes` 1-60, default 15.
- Only on the network the Pi is **already connected to** (an optional `ssid` must match). No passwords, no new networks.
- The pin is **temporary**: after `hold_minutes` it reverts to Auto by itself (it survives an app restart). Sending
  `{"bssid": "", "band": "auto"}` releases it right away. If the AP can't be joined the Pi falls back to Auto.
- The Pi's WiFi (and therefore the VPN path to it) drops for roughly 5-30 s while it switches. The call returns when the switch
  finishes; poll `GET /api/agent/summary` and wait for `wifi.bssid` to be the one you asked for before running a speed test.
- Response: `ok`, `now_on` (bssid, ap_name, band), `pinned`, `reverts_to_auto_at`.
- Leaving Auto does not move the Pi back to the strongest AP: it stays on the AP it is on until its normal roaming decides otherwise.
  To go home, pin the home AP and then release.
