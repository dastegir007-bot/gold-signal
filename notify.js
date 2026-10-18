// AURX AI notification sender + signal record.
// Runs in GitHub Actions (mt5-data repo): on every MT5 upload and every 10 minutes.
// Uses the SAME rules as the app (LOGIC block read from index.html).
//  - new BUY / SELL / EXIT signals for every symbol and timeframe
//  - follows each signal: DCA fills, TP1, SL (or time out) -> record in sts/state.json
//  - sends phone notifications filtered by the user's settings (prefs inside PUSH_SUB)

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "data";
const STATE_FILE = path.join(DATA_DIR, "sts", "state.json");
const NOW = Number(process.env.NOW_MS) || Date.now();
const DEFAULT_PREFS = { s: ["gold", "paxg", "btc", "eth", "sol", "bnb"], t: ["M15", "H1", "H4", "D1"] };
const CAL_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const SNAP_EVERY = 30 * 60000;

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const block = html.match(/\/\*LOGIC_START\*\/([\s\S]*?)\/\*LOGIC_END\*\//);
if (!block) throw new Error("Signal logic not found in index.html");
const STS = new Function(block[1] + "\nreturn STS;")();
const { fmt, SYMS, TFINFO, CFG } = STS;

// test hook: serve Binance / calendar from local files
let fetchImpl = global.fetch;
if (process.env.MOCK_FETCH) fetchImpl = require(path.resolve(process.env.MOCK_FETCH));

function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return dflt; } }

let calInfo = null;
async function loadEvents(old) {
  try {
    const r = await fetchImpl(CAL_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    // small summary of the feed for the health check (helps when no events are found)
    const usd = (Array.isArray(j) ? j : []).filter(x => String(x.country).toUpperCase() === "USD");
    const imp = {};
    usd.forEach(x => { imp[x.impact] = (imp[x.impact] || 0) + 1; });
    calInfo = { all: Array.isArray(j) ? j.length : -1, usd: usd.length, impact: imp,
      first: Array.isArray(j) && j.length ? j[0].date : null, last: Array.isArray(j) && j.length ? j[j.length - 1].date : null };
    const ev = j.filter(x => x.country === "USD" && x.impact === "High")
      .map(x => ({ t: Date.parse(x.date), title: String(x.title || "").slice(0, 60) }))
      .filter(x => isFinite(x.t));
    console.log("Calendar:", ev.length, "high-impact USD events");
    return { list: ev, ok: true };
  } catch (e) {
    console.log("Calendar not available:", e.message);
    return { list: old || [], ok: false };
  }
}

function label(sym) { return SYMS[sym].label; }
function px(sym, v) { return fmt(v, SYMS[sym].dp); }

// result of a closed trade in R (risk = distance from average entry to SL)
function closeTrade(t, status, exit, now) {
  const filled = t.steps.filter(s => s.filled);
  const w = filled.reduce((a, s) => a + s.w, 0) || 1;
  const avg = filled.reduce((a, s) => a + s.p * s.w, 0) / w;
  const risk = Math.abs(avg - t.sl) || 1;
  t.status = status; t.exit = exit; t.closeT = now; t.avg = avg;
  t.r = Math.round(((t.side === "SELL" ? avg - exit : exit - avg) / risk) * 100) / 100;
  t.pct = Math.round(((t.side === "SELL" ? avg - exit : exit - avg) / avg) * 10000) / 100;
}

// follow open trades on 15-minute candles since the last check
function track(state, ctx, msgs) {
  for (const t of state.trades) {
    if (t.status !== "open") continue;
    const bars = (ctx.bars[t.sym] || {}).M15;
    if (!bars || !bars.length) continue;
    const from = t.lastCheck || t.sent;
    for (const b of bars) {
      if (b.t + 9e5 <= from || b.t > NOW) continue;
      if (b.t + 9e5 <= t.sent) continue;
      const buy = t.side === "BUY";
      t.steps.forEach((s, i) => {
        if (i === 0 || s.filled) return;
        if (buy ? b.l <= s.p : b.h >= s.p) {
          s.filled = true; s.t = b.t;
          const f = t.steps.filter(x => x.filled), w = f.reduce((a, x) => a + x.w, 0);
          const avg = f.reduce((a, x) => a + x.p * x.w, 0) / w;
          msgs.push({ sym: t.sym, tf: t.tf, title: "🔵 DCA " + (i + 1) + " laga · " + label(t.sym) + " " + t.tf,
            body: "Price " + px(t.sym, s.p) + ". Avg ab " + px(t.sym, avg) + " · SL wahi " + px(t.sym, t.sl) + "\nOCO ki quantity barha dein." });
        }
      });
      const hitSl = buy ? b.l <= t.sl : b.h >= t.sl;
      const hitTp = buy ? b.h >= t.tp1 : b.l <= t.tp1;
      if (hitSl) {
        closeTrade(t, "sl", t.sl, NOW);
        msgs.push({ sym: t.sym, tf: t.tf, title: "❌ SL laga · " + label(t.sym) + " " + t.tf, body: px(t.sym, t.sl) + " · " + t.r + "R" });
        break;
      }
      if (hitTp) {
        closeTrade(t, "tp1", t.tp1, NOW);
        msgs.push({ sym: t.sym, tf: t.tf, title: "✅ TP1 laga · " + label(t.sym) + " " + t.tf, body: px(t.sym, t.tp1) + " · +" + t.r + "R" });
        break;
      }
    }
    if (t.status === "open") {
      t.lastCheck = NOW;
      const maxAge = TFINFO[t.tf].expiry * TFINFO[t.tf].ms;
      if (NOW - t.sent > maxAge && isFinite(ctx.price[t.sym])) closeTrade(t, "expired", ctx.price[t.sym], NOW);
    }
  }
}

function newSignals(state, ctx, res, msgs) {
  let changed = false;
  const openSpot = () => state.trades.filter(t => t.status === "open" && SYMS[t.sym].spot && !t.skip).length;
  for (const sym of STS.ORDER) {
    for (const tf of STS.TFS) {
      const r = res[sym][tf];
      if (!r || r.noData) continue;
      const S = SYMS[sym];
      if (r.side === "EXIT") {
        const key = [sym, tf, "EXIT", r.exitT].join("|");
        if (state.sent[key]) continue;
        state.sent[key] = NOW; changed = true;
        // EXIT is only sent when one of our BUY signals on this coin + timeframe is still open
        let had = false;
        for (const t of state.trades) if (t.status === "open" && t.sym === sym && t.tf === tf) { closeTrade(t, "exit", ctx.price[sym], NOW); had = true; }
        if (had) msgs.push({ sym, tf, title: "🔴 EXIT " + label(sym) + " · " + tf + " " + px(sym, ctx.price[sym]),
          body: "Trend palat gaya. " + S.sym + " ki BUY band kar dein (bech dein)." });
        continue;
      }
      if (r.side !== "BUY" && r.side !== "SELL") continue;
      const key = [sym, tf, r.side, r.barT].join("|");
      if (state.sent[key]) continue;
      state.sent[key] = NOW; changed = true;
      const L = r.levels, I = TFINFO[tf];
      const trade = { id: key, sym, tf, side: r.side, sent: NOW, barT: r.barT, entry: L.entry, tp1: L.tp1, tp2: L.tp2, status: "open", lastCheck: NOW };
      if (S.spot) {
        const p = STS.spotSteps(L.entry, r.atr, L.sl, true);
        trade.steps = p.steps.map((s, i) => ({ p: s.p, w: s.w, filled: i === 0 }));
        trade.sl = p.sl;
        const n = openSpot();
        if (n >= CFG.maxOpenSpot) trade.skip = true;
        const sc = STS.spotScenarios(p.steps, p.sl, L.tp1, 100);
        const all = sc[sc.length - 1];
        msgs.push({ sym, tf, title: "🟢 BUY " + label(sym) + " · " + tf + " " + px(sym, L.entry),
          body: (trade.skip ? "⚠️ " + n + " positions pehle se khuli: skip karein\n" : "") +
            "DCA: " + px(sym, p.steps[1].p) + " · " + px(sym, p.steps[2].p) + "\n" +
            "SL " + px(sym, p.sl) + " · TP1 " + px(sym, L.tp1) + " · TP2 " + px(sym, L.tp2) + "\n" +
            "$100 par: SL −$" + fmt(all.sl, 2) + " · TP1 +$" + fmt(all.tp, 2) });
      } else {
        trade.steps = [{ p: L.entry, w: 1, filled: true }];
        trade.sl = L.sl;
        msgs.push({ sym, tf, title: (r.side === "BUY" ? "🟢 BUY" : "🔴 SELL") + " Gold · " + tf + " " + px(sym, L.entry),
          body: "SL " + px(sym, L.sl) + " · TP1 " + px(sym, L.tp1) + " · TP2 " + px(sym, L.tp2) + "\n" + I.valid + " valid · DCA nahi" });
      }
      state.trades.push(trade);
    }
  }
  return changed;
}

function readSubs(raw) {
  const t = String(raw || "").trim();
  if (!t) return [];
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch (e) { /* one per line */ }
  return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
}

async function send(msgs) {
  const isTest = process.env.FORCE_TEST === "1";
  if (!msgs.length && !isTest) return null;
  if (!process.env.VAPID_PRIVATE || !process.env.PUSH_SUB) {
    console.log("DRY RUN (secrets missing). Messages:");
    msgs.forEach(m => console.log(" -", m.sym, m.tf, "|", m.title, "|", m.body.replace(/\n/g, " / ")));
    return { at: NOW, dry: true, n: msgs.length };
  }
  const webpush = require("web-push");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "https://dastegir007-bot.github.io/gold-signal/",
    process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE.trim());
  let ok = 0, tried = 0, subs = 0;
  const fails = [];
  for (const sub of readSubs(process.env.PUSH_SUB)) {
    subs++;
    const prefs = sub.prefs || DEFAULT_PREFS;
    let list = msgs.filter(m => prefs.s.indexOf(m.sym) >= 0 && prefs.t.indexOf(m.tf) >= 0);
    if (isTest) list = [{ sym: "test", tf: "", title: "AURX AI: test ✅", body: "Notifications kaam kar rahi hain.\nSymbols: " + prefs.s.join(", ") + " · TF: " + prefs.t.join(", ") }].concat(list);
    if (list.length > 6) {
      const rest = list.slice(5);
      list = list.slice(0, 5).concat([{ sym: "more", tf: "", title: "AURX AI: " + rest.length + " aur signal", body: rest.map(m => m.title).join("\n").slice(0, 300) }]);
    }
    const target = { endpoint: sub.endpoint, keys: sub.keys };
    for (const m of list) {
      tried++;
      const payload = JSON.stringify({ title: m.title, body: m.body, tag: "aurx-" + m.sym + "-" + m.tf + "-" + (m.title.split(" ")[1] || ""), url: "./" });
      try {
        await webpush.sendNotification(target, payload, { TTL: m.tf === "M15" ? 900 : 3600, urgency: "high" });
        ok++;
      } catch (e) {
        console.log("Push failed:", e.statusCode, e.body || e.message);
        fails.push(e.statusCode || String(e.message || "error").slice(0, 40));
        if (e.statusCode === 404 || e.statusCode === 410)
          console.log("Phone ka code expire ho gaya: app mein Notifications ON dobara dabayen aur naya code PUSH_SUB mein dalen.");
      }
    }
  }
  console.log("Sent", ok, "of", tried, "notification(s)");
  if (tried && !ok) process.exitCode = 1;
  return { at: NOW, subs, tried, ok, fails: fails.slice(0, 5), test: isTest };
}

(async () => {
  const state = readJson(STATE_FILE, null) || { v: 1, sent: {}, trades: [], events: [] };
  state.sent = state.sent || {}; state.trades = state.trades || [];
  const goldFile = path.join(DATA_DIR, "xauusd_live.txt");
  const goldText = fs.existsSync(goldFile) ? fs.readFileSync(goldFile, "utf8") : null;

  const [spot, cal] = await Promise.all([STS.loadSpot(fetchImpl, NOW), loadEvents(state.events)]);
  console.log("Binance host:", spot.host || "none", "| errors:", spot.errors.length ? spot.errors.slice(0, 3).join("; ") : "none");
  const events = cal.list.filter(e => e.t > NOW - 3 * 3600000 && e.t < NOW + 8 * 864e5);
  const eventsChanged = JSON.stringify(events) !== JSON.stringify(state.events || []);
  state.events = events;

  const ctx = STS.buildCtx({ goldText, spot, now: NOW, events: cal.ok || events.length ? events : null, trades: state.trades });
  const res = STS.evaluateAll(ctx);

  const msgs = [];
  const before = JSON.stringify(state.trades);
  track(state, ctx, msgs);
  const sigChanged = newSignals(state, ctx, res, msgs);
  const tradesChanged = JSON.stringify(state.trades) !== before;

  for (const s of STS.ORDER) for (const tf of STS.TFS) {
    const r = res[s][tf];
    console.log(s.padEnd(5), tf.padEnd(4), r.noData ? "no data" : r.side.padEnd(5), "|", String(r.reason).slice(0, 80));
  }

  // keep the file small
  for (const k of Object.keys(state.sent)) if (NOW - state.sent[k] > 90 * 864e5) delete state.sent[k];
  const open = state.trades.filter(t => t.status === "open"), done = state.trades.filter(t => t.status !== "open");
  state.trades = done.slice(-400).concat(open);

  const pushRes = await send(msgs);

  const snapOld = !state.snap || NOW - state.snap.at >= SNAP_EVERY;
  const dirty = sigChanged || tradesChanged || eventsChanged || msgs.length > 0 || process.env.FORCE_TEST === "1";
  if (dirty || snapOld) {
    const rows = {};
    STS.ORDER.forEach(s => { rows[s] = STS.tfRows(ctx, s); });
    state.snap = { at: NOW, res, rows, price: ctx.price, change: ctx.change };
    state.updated = NOW; state.host = spot.host; state.errors = spot.errors.slice(0, 10);
    // health check of this run: calendar reachable, push result (kept for the record, no secrets)
    state.check = { at: NOW, cal: cal.ok, calEvents: cal.list.length, calInfo, gold: !!goldText,
      push: pushRes || (state.check && state.check.push) || null };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    console.log("State saved (" + (dirty ? "changes" : "snapshot") + "), trades:", state.trades.length, "open:", open.length);
  } else console.log("No changes");
})().catch(e => { console.error(e); process.exitCode = 1; });
