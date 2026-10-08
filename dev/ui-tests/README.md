# UI tests for `app/static`

A throwaway **mock of the Pi API** (`mock_server.py`: static files + canned JSON + streaming look-alikes of
`/api/ping|trace|portscan|speedtest/stream`) and **Playwright** suites that drive the phone UI at 390x844.
Nothing here touches a real Pi.

```bash
cd dev/ui-tests
npm install                                   # playwright-core
npx playwright-core install chromium          # or: export CHROME_PATH=/path/to/chrome
npm run mock &                                # serves ../../app/static + the mock API on 127.0.0.1:8099
npm test                                      # all suites; screenshots go to $SHOTS_DIR (default ./shots)
kill %1
```

| suite | covers |
|---|---|
| `e2e` | tab navigation, header actions, signal graph, tools, monitor, LAN, lock |
| `e2e-inline` | result cards (placement, titles, live updates, close, copy), console mode switch |
| `e2e-live` | live ping (incremental lines, Stop, monitor, gateway, takeover, timeouts, fallback, console mode) |
| `e2e-live2` | live route table and live port scan (incl. fallbacks and console mode) |
| `e2e-speed` | speedometer (needle/arc pixels, tiles, trace, result, stop, quick action, failure, fallback) |
| `e2e-home` | Info "Last Speed Test" mini gauge (sweep, tap, empty state) |
| `e2e-usb` | Info "USB Link" row: USB 3 green, USB 2 fallback amber + hint, USB 2-only adapter, no USB radio, live refresh, escaping, 800x480 touch screen |
| `e2e-power` | Info header ⏻ + Settings > Power: confirm dialog (Cancel/Esc/backdrop send nothing), shut down countdown + Pi 5 vs older-Pi wake hint, restart waits for the Pi to go down and come back then reloads, "didn't restart", refused action, 800x480 touch screen |
| `e2e-hotspot` | Settings > Setup Hotspot: Off / Auto / On (POST body, selection + aria), live status (network, fallback countdown, Turning on/off…, phones connected, service down, escaped errors), polling only while Settings is open, choice survives a reload, 800x480 touch screen |

`tests/live.mjs <url>` is a tiny smoke check of a *deployed* app (login screen renders, no JS errors).

Notes: tests run with `serviceWorkers: "block"` where they intercept requests (Playwright `page.route` cannot see
requests that go through the app's service worker). Gauge tests read canvas pixels, so they check that the needle and
arc really move, not just that text changed.
