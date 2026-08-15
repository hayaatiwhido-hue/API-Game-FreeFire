const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;
const MATCHSTATS_URL =
  process.env.MATCHSTATS_URL || "https://matchstats.us.ffesports.com/";
const INTERVAL_MS = 1000;

app.use(express.json());
app.use(express.static("public"));

let browser = null;
let page = null;
let timer = null;
let polling = false;

let state = {
  running: false,
  matchId: "",
  status: "PARADO",
  lastUpdate: null,
  polls: 0,
  changes: 0,
  error: null,
  data: null
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function comparable(snapshot) {
  return snapshot
    ? JSON.stringify(snapshot.tables) + "\n" + snapshot.bodyText
    : "";
}

async function ensureBrowser() {
  if (browser && page) return;

  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
  });
}

async function snapshot() {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")].map((table, index) => ({
      index,
      rows: [...table.querySelectorAll("tr")]
        .map((tr) =>
          [...tr.querySelectorAll("th,td")].map((td) => td.innerText.trim())
        )
        .filter((row) => row.length)
    }));

    return {
      capturedAt: new Date().toISOString(),
      title: document.title,
      url: location.href,
      tables,
      bodyText: document.body.innerText
    };
  });
}

async function locateMatchInput() {
  const selectors = [
    'input[placeholder*="Match ID" i]',
    'input[placeholder*="Match" i]',
    'input[type="search"]',
    'input'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) return locator;
  }

  throw new Error("Campo de MatchID não encontrado no MatchStats.");
}

async function searchMatch(matchId) {
  await page.goto(MATCHSTATS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  await page.waitForTimeout(1500);

  const input = await locateMatchInput();
  await input.fill(matchId);
  await input.press("Enter");

  await page.waitForTimeout(2000);

  return snapshot();
}

async function pollOnce() {
  if (!state.running || polling) return;

  polling = true;

  try {
    state.polls++;

    await page.reload({
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(500);

    const current = await snapshot();

    if (state.data && comparable(state.data) !== comparable(current)) {
      state.changes++;
    }

    state.data = current;
    state.lastUpdate = new Date().toISOString();
    state.status = "CONECTADO";
    state.error = null;
  } catch (error) {
    state.status = "ERRO";
    state.error = cleanText(error.message);
  } finally {
    polling = false;
  }
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function start(matchId) {
  stopTimer();

  state = {
    running: true,
    matchId,
    status: "PESQUISANDO",
    lastUpdate: null,
    polls: 0,
    changes: 0,
    error: null,
    data: null
  };

  try {
    await ensureBrowser();

    const first = await searchMatch(matchId);

    state.data = first;
    state.lastUpdate = new Date().toISOString();
    state.status = "CONECTADO";

    timer = setInterval(pollOnce, INTERVAL_MS);
  } catch (error) {
    state.status = "ERRO";
    state.error = cleanText(error.message);
  }
}

app.post("/api/start", async (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();

  if (!matchId) {
    return res.status(400).json({ error: "Informe um MatchID." });
  }

  await start(matchId);
  res.json(state);
});

app.post("/api/stop", async (_req, res) => {
  stopTimer();
  state.running = false;
  state.status = "PARADO";
  res.json(state);
});

app.get("/api/state", (_req, res) => {
  res.json(state);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "stats-engine", intervalMs: INTERVAL_MS });
});

app.listen(PORT, () => {
  console.log(`Stats Engine rodando na porta ${PORT}`);
  console.log(`MatchStats: ${MATCHSTATS_URL}`);
});

process.on("SIGINT", async () => {
  stopTimer();
  if (browser) await browser.close();
  process.exit(0);
});
