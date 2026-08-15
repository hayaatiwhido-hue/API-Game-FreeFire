const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MATCHSTATS = "https://matchstats.us.ffesports.com/";
const INTERVAL = 1000;

let browser = null;
let page = null;
let state = {
  status: "IDLE",
  phase: "idle",
  matchId: null,
  currentUrl: null,
  title: null,
  consultations: 0,
  changes: 0,
  lastUpdate: null,
  data: null,
  error: null
};
let timer = null;
let lastSignature = "";

async function ensurePage() {
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(10000);
  }
  return page;
}

async function loadHome(p) {
  state.phase = "opening";
  // Important: one navigation only. Do not call goto twice while the site redirects.
  await p.goto(MATCHSTATS, { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(1000);
}

async function findSearchInput(p) {
  const selectors = [
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="Match" i]',
    'input[name*="search" i]',
    'input[id*="search" i]',
    'input'
  ];
  for (const selector of selectors) {
    const loc = p.locator(selector).first();
    if (await loc.count()) {
      try {
        if (await loc.isVisible()) return loc;
      } catch {}
    }
  }
  return null;
}

async function clickSearch(p, input) {
  const candidates = [
    'button:has-text("Search")',
    'button:has-text("Pesquisar")',
    'input[type="submit"]',
    'button[type="submit"]'
  ];
  for (const selector of candidates) {
    const b = p.locator(selector).first();
    if (await b.count()) {
      try {
        if (await b.isVisible()) {
          await b.click();
          return true;
        }
      } catch {}
    }
  }
  await input.press("Enter");
  return true;
}

async function extractTables(p) {
  return await p.evaluate(() => {
    const tables = [...document.querySelectorAll("table")].map((table, index) => ({
      index,
      rows: [...table.querySelectorAll("tr")].map(tr =>
        [...tr.querySelectorAll("th,td")].map(td => (td.innerText || "").trim())
      ).filter(row => row.length)
    })).filter(t => t.rows.length);
    return {
      url: location.href,
      title: document.title,
      tables,
      bodyText: (document.body?.innerText || "").slice(0, 50000)
    };
  });
}

async function searchAndOpenMatch(matchId) {
  const p = await ensurePage();
  state.error = null;
  state.status = "SEARCHING";
  state.phase = "opening";
  state.currentUrl = p.url();

  await loadHome(p);
  state.currentUrl = p.url();
  state.title = await p.title().catch(() => "");

  state.phase = "search";
  const input = await findSearchInput(p);
  if (!input) {
    throw new Error("Campo de pesquisa do MatchStats não foi localizado.");
  }

  state.phase = "searching";
  await input.fill(String(matchId));
  await clickSearch(p, input);
  await p.waitForTimeout(1200);

  state.currentUrl = p.url();
  const result = await extractTables(p);

  // Locate a row containing the requested Match ID.
  const rows = result.tables.flatMap(t => t.rows);
  const matchText = String(matchId);
  const row = rows.find(r => r.some(cell => cell.trim() === matchText));
  if (!row) {
    // Keep real page data for diagnosis, but do not pretend it is the match.
    return { found: false, result };
  }

  state.phase = "match-found";

  // Try to locate a View link/button associated with the row.
  const opened = await p.evaluate((matchText) => {
    const allRows = [...document.querySelectorAll("tr")];
    const target = allRows.find(tr =>
      [...tr.querySelectorAll("th,td")].some(td => (td.innerText || "").trim() === matchText)
    );
    if (!target) return false;
    const clickable = target.querySelector('a[href], button');
    if (!clickable) return false;
    const text = (clickable.innerText || clickable.textContent || "").trim().toLowerCase();
    if (text.includes("view") || text.includes("ver") || clickable.tagName === "A") {
      clickable.click();
      return true;
    }
    return false;
  }, matchText);

  if (opened) {
    await p.waitForTimeout(1200);
  }

  const finalData = await extractTables(p);
  return { found: true, result: finalData, opened };
}

async function poll() {
  if (!state.matchId) return;
  try {
    const data = await searchAndOpenMatch(state.matchId);
    state.consultations++;
    state.lastUpdate = new Date().toISOString();
    if (!data.found) {
      state.status = "WAITING";
      state.phase = "result-not-found";
      state.data = data.result;
      const sig = JSON.stringify(data.result.tables);
      if (sig !== lastSignature) { state.changes++; lastSignature = sig; }
      return;
    }
    state.status = "CONNECTED";
    state.phase = "captured";
    state.data = data.result;
    const sig = JSON.stringify(data.result.tables);
    if (sig !== lastSignature) { state.changes++; lastSignature = sig; }
  } catch (err) {
    state.status = "ERROR";
    state.error = err.message;
    state.lastUpdate = new Date().toISOString();
  }
}

app.get("/", (req,res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/api/status", (req,res) => res.json(state));

app.post("/api/start", async (req,res) => {
  const id = String(req.body.matchId || "").trim();
  if (!id) return res.status(400).json({ error: "Informe o Match ID." });
  if (timer) clearInterval(timer);
  state = { status:"STARTING", phase:"opening", matchId:id, currentUrl:null, title:null, consultations:0, changes:0, lastUpdate:null, data:null, error:null };
  lastSignature = "";
  poll();
  timer = setInterval(poll, INTERVAL);
  res.json(state);
});

app.post("/api/stop", (req,res) => {
  if (timer) clearInterval(timer);
  timer = null;
  state.status = "STOPPED";
  state.phase = "idle";
  res.json(state);
});

app.get("/api/match/:id", async (req,res) => {
  try {
    const result = await searchAndOpenMatch(String(req.params.id));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error:e.message });
  }
});

app.get("/api/health", (req,res) => res.json({ ok:true, version:"1.0.1" }));

const path = require("path");
app.listen(PORT, "0.0.0.0", () => console.log(`Stats Engine 1.0.1 running on ${PORT}`));

process.on("SIGTERM", async () => {
  if (timer) clearInterval(timer);
  if (browser) await browser.close().catch(()=>{});
  process.exit(0);
});
