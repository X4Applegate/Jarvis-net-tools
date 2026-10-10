import { chromium } from "playwright-core";
const exe = process.env.CHROME_PATH || undefined;
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const errors = [];
const watch = (page) => {
  page.on("console", m => { if (/Content Security Policy|Refused to (load|apply|execute|connect|frame)/.test(m.text())) errors.push("CSP: " + m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
};
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const SHOTS = process.env.SHOTS_DIR || "./shots";
const settle = (page, ms = 500) => page.waitForTimeout(ms);
const tvOpen = (page) => page.locator("#tv").evaluate(d => d.open);
const body = (page) => page.locator("#tv-body").textContent();
const title = (page) => page.locator("#tv-title").textContent();
const inked = (page, id) => page.evaluate((id) => { const c = document.getElementById(id), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }, id);
const tapBtn = async (page, id) => { await page.locator("#" + id).scrollIntoViewIfNeeded(); await page.locator("#" + id).tap(); };

const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
await page.goto("http://127.0.0.1:8099/?kiosk=1#monitor"); await settle(page, 900);

// --- Public IP & ISP ---
await tapBtn(page, "btn-pubip"); await settle(page, 700);
ok(await tvOpen(page) && await title(page) === "Public IP & ISP", "Public IP opens its own page");
ok(await page.locator("#pip-ip").textContent() === "203.0.113.45", "big public IP");
const pb = await body(page);
ok(/Example ISP/.test(pb) && /AS64500/.test(pb) && /Metro/.test(pb) && /2001:db8:1::45/.test(pb), "ISP, ASN, location, IPv6 shown");
await page.screenshot({ path: `${SHOTS}/p2-pubip.png` });
await page.locator("#tv-close").tap(); await settle(page, 200);

// --- DNS Check ---
await tapBtn(page, "btn-dnscheck"); await settle(page, 900);
let b = await body(page);
ok(/DNS is healthy · 16 ms/.test(b) && /Your DNS/.test(b), "healthy verdict with your DNS time: " + b.slice(0, 80));
ok(await page.locator("#tv-body .svc-tile").count() === 4 && await page.locator("#tv-body .svc-tile.mine").count() === 1, "4 servers side by side, yours marked");
ok(await page.locator("#tv-body table.dnsc tbody tr").count() === 4 && /no hijacking/.test(b), "per-answer table + typo protection");
await page.screenshot({ path: `${SHOTS}/p2-dnscheck.png` });
await page.route("**/api/dnscheck", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ resolvers: ["192.168.88.1"], names: ["google.com"], hijack: true, nx_status: "NOERROR",
  rows: [{ label: "This network", server: "192.168.88.1", mine: true, avg: 240, min: 200, max: 280, ok: 1, fail: 0, results: [{ name: "google.com", status: "NOERROR", ms: 240 }] },
         { label: "Cloudflare", server: "1.1.1.1", mine: false, avg: 12, min: 12, max: 12, ok: 1, fail: 0, results: [{ name: "google.com", status: "NOERROR", ms: 12 }] }] }) }));
await page.locator("#tv-refresh").tap(); await settle(page, 700);
b = await body(page);
ok(/DNS is slow · 240 ms/.test(b) && /answers names that don't exist/.test(b), "slow DNS + hijack warning");
await page.unroute("**/api/dnscheck");
await page.locator("#tv-close").tap(); await settle(page, 200);

// --- History ---
await tapBtn(page, "btn-history"); await settle(page, 700);
ok(await title(page) === "History" && await page.locator("#hist-list details.hist").count() === 5, "History lists today's 5 runs");
ok(await page.locator("#hist-f button").count() === 5, "filter chips: All, Ping, Whois, DNS lookup, Rogue DHCP check");
await page.locator("#hist-f button", { hasText: "Ping" }).tap(); await settle(page, 150);
ok(await page.locator("#hist-list details.hist").count() === 2, "filter by Ping");
await page.locator("#hist-q").fill("10% packet"); await settle(page, 150);
ok(await page.locator("#hist-list details.hist").count() === 1, "search inside the results");
await page.locator("#hist-list details.hist summary").first().tap(); await settle(page, 150);
ok(await page.locator("#hist-list details.hist").first().evaluate(d => d.open) && /9 received/.test(await page.locator("#hist-list details.hist pre").first().textContent()), "tap opens the full result");
await page.locator("#hist-q").fill(""); await page.locator("#hist-f button", { hasText: "All" }).tap(); await settle(page, 150);
await page.screenshot({ path: `${SHOTS}/p2-history.png` });
await page.locator("#tv-close").tap(); await settle(page, 200);

// --- Tools page: Open Ports + Bandwidth ---
await page.locator('#tabs button[data-page=tools]').tap(); await settle(page, 400);
await tapBtn(page, "btn-ports"); await settle(page, 700);
b = await body(page);
ok(/4 services reachable from the network/.test(b), "ports verdict: " + b.slice(0, 60));
ok(/SSH/.test(b) && /iPerf3 speed server/.test(b) && /only on 203\.0\.113\.15/.test(b) && /this Pi only/.test(b), "named ports, scopes");
ok(await page.locator("#tv-body details.hist").count() === 1, "temporary UDP ports folded away");
await page.screenshot({ path: `${SHOTS}/p2-ports.png` });
await page.locator("#tv-close").tap(); await settle(page, 200);

await tapBtn(page, "btn-bw"); await settle(page, 3600);
ok(await title(page) === "Bandwidth Now", "Bandwidth opens its own page");
const cards = await page.$$eval("#bw-cards .tv-card", cs => cs.map(c => c.querySelector(".k").textContent + "=" + c.querySelector(".v").textContent));
ok(/Download=\d+(\.\d+)? Mbps/.test(cards[0]) && /Upload=\d/.test(cards[1]) && /Interface=Wi-Fi/.test(cards[3]), "live Mbps cards: " + cards.join(" | "));
ok(+cards[0].match(/=([\d.]+)/)[1] > 10, "download rate computed from the counters");
ok(await page.locator("#bw-ifs button").count() === 2 && /★/.test(await page.locator("#bw-ifs button.on").textContent()), "interfaces with traffic, internet one first (★): VPN listed, idle Ethernet hidden");
ok((await inked(page, "bw-graph")) > 300, "graph drawn");
await page.screenshot({ path: `${SHOTS}/p2-bw.png` });
await page.locator("#bw-ifs button", { hasText: "VPN" }).tap(); await settle(page, 1300);
ok(/Interface=VPN/.test((await page.$$eval("#bw-cards .tv-card", cs => cs.map(c => c.querySelector(".k").textContent + "=" + c.querySelector(".v").textContent)))[3]), "switch interface");
await page.locator("#tv-close").tap();
await settle(page, 300);
ok(!(await tvOpen(page)), "closed");

// --- LAN page: Rogue DHCP + Jack Test ---
await page.locator('#tabs button[data-page=network]').tap(); await settle(page, 600);
await tapBtn(page, "btn-dhcp"); await settle(page, 800);
b = await body(page);
ok(/Rogue DHCP suspected · 2 servers answered/.test(b), "rogue verdict");
ok(/matches your gateway/.test(b) && /NOT your gateway — likely the rogue/.test(b), "points at the rogue one");
await page.screenshot({ path: `${SHOTS}/p2-dhcp.png` });
await page.locator("#tv-close").tap(); await settle(page, 200);

let links = 0;
await page.route("**/api/jack/link", r => { links++; r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(links < 3 ? { iface: "eth0", link: false } : { iface: "eth0", link: true, speed: "1000", duplex: "full" }) }); });
await tapBtn(page, "btn-jack"); await settle(page, 700);
ok(/Plug the Pi's Ethernet port into the wall jack/.test(await body(page)), "waits for a cable");
await page.screenshot({ path: `${SHOTS}/p2-jack-wait.png` });
await settle(page, 4800);
b = await body(page);
ok(links >= 3 && /This jack is good/.test(b), "starts by itself when the link comes up (" + links + " polls)");
ok(await page.locator("#tv-body .chk-row.ok").count() === 5 && /Core-SW/.test(b), "5 green checks incl. switch port");
await page.screenshot({ path: `${SHOTS}/p2-jack.png` });
const l0 = links; await page.locator("#tv-close").tap(); await settle(page, 2500);
ok(links === l0, "Close stops polling");
await page.unroute("**/api/jack/link");

// --- Signal page: APs for this SSID ---
await page.locator('#tabs button[data-page=wifi]').tap(); await settle(page, 600);
await tapBtn(page, "btn-aps"); await settle(page, 800);
b = await body(page);
ok(await title(page) === "APs for this SSID" && /3 access points broadcast “Example WiFi”/.test(b), "APs verdict");
ok(await page.locator("#tv-body .ap-row").count() === 3 && await page.locator("#tv-body .ap-row.cur").count() === 1 && /Back Room/.test(b), "3 AP rows, current marked, names shown");
ok(/5 \+ 2\.4 GHz|2\.4 GHz \+ 5 GHz/.test(b), "bands summary");
await page.screenshot({ path: `${SHOTS}/p2-aps.png` });
await page.route("**/api/aps", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ssid: "Example WiFi", aps: [
  { bssid: "02:00:5E:00:00:02", signal: 80, band: "5", ch: 36, current: false, name: "Back Room" }, { bssid: "02:00:5E:00:00:01", signal: 40, band: "5", ch: 149, current: true, name: "Office AP" }] }) }));
await page.locator("#tv-refresh").tap(); await settle(page, 300); await page.locator("#tv-refresh").tap(); await settle(page, 700);
ok(/A stronger AP is right here/.test(await body(page)), "sticky-client warning");
await page.locator("#tv-close").tap();
await ctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
