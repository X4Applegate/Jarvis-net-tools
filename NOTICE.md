# Third-party notices

Jarvis Net Tools itself is covered by the view-only license in `LICENSE`. The items below are not
covered by it and keep their own licenses.

## Included in this repository

- **Icons** in `app/static/index.html` (the inline SVG paths for info, Wi-Fi, LAN, tools, speed,
  settings, refresh, lock and chevron) are taken from the **Material Design icons** by Google,
  licensed under the **Apache License, Version 2.0** - <https://www.apache.org/licenses/LICENSE-2.0> (full text: `licenses/Apache-2.0.txt`).
  Source: <https://github.com/google/material-design-icons>.

## Not included (used as separate programs or libraries at run time)

- **Flask / Werkzeug** (BSD-3-Clause) - the web backend.
- **Ookla Speedtest CLI** - proprietary; not included or redistributed here. It has its own license and
  terms that you must accept yourself.
- **nmap** (Nmap Public Source License), **mtr** (GPL), **arp-scan** (GPL), **lldpd** (ISC),
  **iperf3** (BSD), **tcpdump** (BSD), **NetworkManager / nmcli** (GPL) - called as external programs.
- **Cockpit** (LGPL) - the optional "Net Tools" page is a Cockpit plug-in that uses Cockpit's own JavaScript API.
- **Playwright** (Apache-2.0) - only in the developer test suites under `dev/ui-tests/`.
