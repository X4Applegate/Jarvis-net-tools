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

const ctx = await browser.newContext({ viewport: { width: 800, height: 480 }, hasTouch: true, serviceWorkers: "block" });
const page = await ctx.newPage(); watch(page);
const bodies = {};
page.on("request", r => { if (r.method() === "POST" && /\/api\/(ping|trace|portscan)\/stream|\/api\/dns\/query|\/api\/whois/.test(r.url())) bodies[new URL(r.url()).pathname] = r.postDataJSON(); });
const seg = (t) => page.locator("#tool-seg button[data-tool='" + t + "']").tap();
const pill = (k, text) => page.locator("#tool-opts .pills button[data-k='" + k + "']", { hasText: text }).first().tap();
const hint = () => page.locator("#tool-hint").textContent();
const card = () => page.locator("#res-tools");

await page.goto("http://127.0.0.1:8099/?kiosk=1#tools"); await settle(page, 900);
ok(await page.locator("#tool-seg button[data-tool=whois]").count() === 1, "Whois tool in the tool bar");
ok(await page.locator("#tool-opts .topt").count() === 4, "Ping shows 4 options (count, every, size, don't fragment)");
await page.locator("#target").fill("1.1.1.1");

// --- Ping options go to the Pi and the hint follows ---
await pill("count", "5"); await pill("interval", "0.2 s"); await pill("size", "1472 B"); await pill("df", "On");
ok(/5 probes every 0\.2 s, 1472-byte packets, don't fragment/.test(await hint()), "ping hint follows the options: " + await hint());
await page.screenshot({ path: `${SHOTS}/toolopts-ping.png` });
await page.locator("#tool-start").tap(); await settle(page, 2200);
const pb = bodies["/api/ping/stream"] || {};
ok(pb.count === 5 && pb.interval === 0.2 && pb.size === 1472 && pb.df === true, "ping body carries the options: " + JSON.stringify(pb));
ok(/5 sent/.test(await card().locator(".res-status").textContent()), "5 probes then done: " + await card().locator(".res-status").textContent());

// --- remembered after a reload ---
await page.reload(); await settle(page, 900);
ok(await page.locator("#tool-opts .pills button.on[data-k=count]").textContent() === "5" && await page.locator("#tool-opts .pills button.on[data-k=size]").textContent() === "1472 B", "options are remembered on this device");

// --- Route: passes, protocol, max hops ---
await page.locator("#target").fill("1.1.1.1");
await seg("trace"); await pill("passes", "5"); await pill("proto", "TCP 443"); await pill("max_hops", "15");
ok(/5 passes over TCP port 443.*15 hops/.test(await hint()), "route hint: " + await hint());
await page.locator("#tool-start").tap(); await settle(page, 2600);
const tb = bodies["/api/trace/stream"] || {};
ok(tb.count === 5 && tb.proto === "tcp" && tb.max_hops === 15, "route body: " + JSON.stringify(tb));

// --- Ports: range ---
await seg("ports"); await pill("mode", "Range"); await settle(page, 200);
ok(await page.locator("#topt-start").count() === 1, "Range shows from / to boxes");
await page.locator("#topt-start").fill("20"); await page.locator("#topt-end").fill("450");
ok(/ports 20–450/.test(await hint()), "ports hint: " + await hint());
await page.locator("#tool-start").tap(); await settle(page, 2800);
const ob = bodies["/api/portscan/stream"] || {};
ok(ob.mode === "range" && ob.start === 20 && ob.end === 450, "ports body: " + JSON.stringify(ob));
ok(/ports 20–450|open port/.test(await card().locator(".res-status").textContent()), "ports status: " + await card().locator(".res-status").textContent());
await page.locator("#topt-end").fill("10"); await page.locator("#tool-start").tap(); await settle(page, 400);
ok(/start first/.test(await card().locator(".res-out").textContent()), "a backwards range is refused before asking the Pi");
await pill("mode", "Common 100");

// --- DNS: types + server, table result ---
await page.locator("#target").fill("example.com");
await seg("dns");
ok(await page.locator("#tool-opts .pills button[data-k=type]").count() === 11, "11 record-type choices");
await pill("server", "Cloudflare");
await page.locator("#tool-start").tap(); await settle(page, 900);
const db = bodies["/api/dns/query"] || {};
ok(db.type === "ALL" && db.server === "1.1.1.1" && db.target === "example.com", "dns body: " + JSON.stringify(db));
ok(await card().locator("table.dns tbody tr").count() === 7, "7 records in the table");
ok(await card().locator(".dchip.ok").count() === 6 && await card().locator(".dchip.none").count() === 2, "type chips: 6 found, 2 none");
ok(/7 records · via 1\.1\.1\.1/.test(await card().locator(".res-status").textContent()), "dns status: " + await card().locator(".res-status").textContent());
await page.screenshot({ path: `${SHOTS}/toolopts-dns.png`, fullPage: true });
await pill("type", "MX"); await page.locator("#tool-start").tap(); await settle(page, 700);
ok(bodies["/api/dns/query"].type === "MX" && await card().locator("table.dns tbody tr").count() === 1, "one type at a time");
await pill("server", "Other…"); await settle(page, 200);
ok(await page.locator("#topt-custom").count() === 1, "Other… asks for a server");
await page.locator("#tool-start").tap(); await settle(page, 300);
ok(/DNS server's IP/.test(await card().locator(".res-out").textContent()), "an empty custom server is caught");
await page.locator("#topt-custom").fill("192.0.2.53"); await page.locator("#tool-start").tap(); await settle(page, 700);
ok(bodies["/api/dns/query"].server === "192.0.2.53", "custom server is used");
await page.locator("#target").fill("nope.invalid"); await page.locator("#tool-start").tap(); await settle(page, 700);
ok(/does not exist/.test(await card().locator(".res-status").textContent()), "NXDOMAIN said plainly");
await page.locator("#target").fill("8.8.8.8"); await pill("type", "ALL"); await page.locator("#tool-start").tap(); await settle(page, 700);
ok(/dns\.example\./.test(await card().locator("table.dns").textContent()), "an IP gives its PTR name");

// --- Whois ---
await seg("whois");
ok(await page.locator("#tool-opts").isHidden(), "Whois has no options");
await page.locator("#target").fill("example.com"); await page.locator("#tool-start").tap(); await settle(page, 700);
const wt = await card().locator(".kv").textContent();
ok(/Example Registrar/.test(wt) && /2027-08-13/.test(wt) && /a\.iana-servers\.net/.test(wt) && /signed/.test(wt), "domain whois card: " + wt.slice(0, 200));
ok(/expires 2027-08-13/.test(await card().locator(".res-status").textContent()), "whois status: " + await card().locator(".res-status").textContent());
await page.screenshot({ path: `${SHOTS}/toolopts-whois.png`, fullPage: true });
const copy = await card().evaluate(el => el.dataset.copy);
ok(/Name servers\s+a\.iana-servers\.net, b\.iana-servers\.net/.test(copy), "Copy text is plain: " + copy);
await page.locator("#target").fill("198.51.100.7"); await page.locator("#tool-start").tap(); await settle(page, 700);
ok(/Example Networks LLC/.test(await card().locator(".kv").textContent()) && /198\.51\.100\.0 - 198\.51\.100\.255/.test(await card().locator(".kv").textContent()), "IP whois: org + range");
await page.locator("#target").fill("nope.invalid"); await page.locator("#tool-start").tap(); await settle(page, 700);
ok(/not found/.test(await card().locator(".res-out").textContent()), "whois error shown");

// --- the older callers still work with defaults (Device Details > Ping uses goTool) ---
await page.evaluate(() => localStorage.removeItem("nt-topts")); await page.reload(); await settle(page, 900);
await page.locator("#target").fill("1.1.1.1"); await seg("ping"); await page.locator("#tool-start").tap(); await settle(page, 600);
const pd = bodies["/api/ping/stream"];
ok(pd.count === 10 && pd.interval === 1 && pd.size === 56 && pd.df === false, "defaults: " + JSON.stringify(pd));
await page.locator("#tool-start").tap();
await ctx.close();

ok(!errors.length, "no page errors / CSP violations: " + errors.join(" | "));
console.log(JSON.stringify({ pass, fail, errors }, null, 1));
await browser.close();
process.exit(fail ? 1 : 0);
