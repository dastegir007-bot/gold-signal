// Gold Signal push sender.
// Runs in GitHub Actions (mt5-data repo) every time MarketExport uploads new data.
// Uses the SAME signal rules as the app: the logic block is read from index.html.
// Sends a phone notification only when a NEW BUY/SELL appears (one per M15 candle).

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DATA_DIR = process.env.DATA_DIR || "data";
const DATA_FILE = "xauusd_live.txt";

// ---- load the app's signal logic (single source of truth) ----
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const block = html.match(/\/\*LOGIC_START\*\/([\s\S]*?)\/\*LOGIC_END\*\//);
if (!block) throw new Error("Signal logic not found in index.html");
const L = new Function(block[1] + "\nreturn { CFG, parseExport, computeSignal, serverToDate };")();

// ---- current + previous snapshot ----
const curText = fs.readFileSync(path.join(DATA_DIR, DATA_FILE), "utf8");
let prevText = null;
try {
  prevText = execSync('git -C "' + DATA_DIR + '" show HEAD~1:' + DATA_FILE,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (e) { /* first commit or shallow history - treat as no previous signal */ }

const m15Bar = d => { const r = d.tf.M15; return r && r.length >= 2 ? r[r.length - 2].time : ""; };
const snapMs = d => { const g = L.serverToDate(d.info.gmt_time || d.info.server_time); return g ? g.getTime() : 0; };

const cur = L.parseExport(curText);
const nowMs = Number(process.env.NOW_MS) || Date.now();
const sig = L.computeSignal(cur, nowMs);

let prevSide = "WAIT", prevBar = "";
if (prevText) {
  const p = L.parseExport(prevText);
  prevSide = L.computeSignal(p, snapMs(p)).side;
  prevBar = m15Bar(p);
}

const isTest = process.env.FORCE_TEST === "1";
const isNew = sig.side !== "WAIT" && !(prevSide === sig.side && prevBar === m15Bar(cur));
console.log("Now:", sig.side, "-", sig.reason, "| prev:", prevSide, prevBar, "| new:", isNew, "| test:", isTest);
if (!isNew && !isTest) process.exit(0);

// ---- message ----
const f2 = v => Number(v).toFixed(2);
const lot = Math.max(0.01, Number(process.env.LOT) || 0.01);
const g = L.serverToDate(cur.info.gmt_time || cur.info.server_time);
const pkt = g ? new Date(g.getTime() + 5 * 3600000).toISOString().slice(11, 16) + " PKT" : "";
let title, body;
if (isNew) {
  const lv = sig.levels;
  const risk = lv.dist * lot * 100;
  title = (sig.side === "BUY" ? "\u{1F7E2} BUY" : "\u{1F534} SELL") + " XAUUSD " + f2(lv.entry);
  body = "SL " + f2(lv.sl) + " | TP1 " + f2(lv.tp1) + " | TP2 " + f2(lv.tp2) + "\n" +
         lot.toFixed(2) + " lot: SL -$" + risk.toFixed(2) + ", TP1 +$" + (risk * L.CFG.tp1R).toFixed(2) + "\n" +
         pkt + " · 15 min valid";
} else {
  title = "Gold Signal: test ✅";
  body = "Notifications kaam kar rahi hain.\nAbhi: " + sig.side + " - " + sig.reason;
}
const payload = JSON.stringify({ title, body, tag: "gold-signal", url: "./" });

// ---- send ----
if (!process.env.VAPID_PRIVATE || !process.env.PUSH_SUB) {
  console.log("DRY RUN (secrets missing). Payload:", payload);
  process.exit(0);
}

function readSubs(raw) {
  const t = raw.trim();
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch (e) { /* one per line */ }
  return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
}

(async () => {
  const webpush = require("web-push");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "https://dastegir007-bot.github.io/gold-signal/",
    process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE.trim());
  const subs = readSubs(process.env.PUSH_SUB);
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s, payload, { TTL: 900, urgency: "high" });
      ok++;
    } catch (e) {
      console.log("Push failed:", e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410)
        console.log("Phone ka code expire ho gaya: app mein 'Notifications ON' dobara dabayen aur naya code PUSH_SUB secret mein dalen.");
    }
  }
  console.log("Sent to", ok, "of", subs.length, "device(s):", title);
  if (ok === 0) process.exitCode = 1;
})();
