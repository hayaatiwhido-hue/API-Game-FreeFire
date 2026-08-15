const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;
const MATCHSTATS_URL =
  process.env.MATCHSTATS_URL || "https://matchstats.us.ffesports.com/";
const POLL_MS = 1000;

app.use(express.json());
app.use(express.static("."));

let browser = null;
let context = null;
let page = null;
let pollTimer = null;
let polling = false;
let operationId = 0;

const state = {
  running: false,
  matchId: "",
  status: "PARADO",
  phase: "idle",
  lastUpdate: null,
  polls: 0,
  changes: 0,
  error: null,
  currentUrl: "",
  title: "",
  data: null,
  diagnostics: {
    inputFound: false,
    searchTriggered: false,
    pageReady: false
  }
};

function resetState(matchId) {
  state.running = true;
  state.matchId = matchId;
  state.status = "INICIANDO";
  state.phase = "starting";
  state.lastUpdate = null;
  state.polls = 0;
  state.changes = 0;
  state.error = null;
  state.currentUrl = "";
  state.title = "";
  state.data = null;
  state.diagnostics = {
    inputFound: false,
    searchTriggered: false,
    pageReady: false
  };
}

function setError(message, phase = state.phase) {
  state.status = "ERRO";
  state.phase = phase;
  state.error = String(message || "Erro desconhecido");
}

function comparable(snapshot) {
  if (!snapshot) return "";
  return JSON.stringify({
    tables: snapshot.tables,
    text: snapshot.bodyText
  });
}

async function ensureBrowser() {
  if (browser && context && page && !page.isClosed()) return;

  state.phase = "browser";

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
  });

  page = await context.newPage();

  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(30000);

  page.on("console", msg => {
    if (process.env.DEBUG_BROWSER === "1") {
      console.log("[browser]", msg.type(), msg.text());
    }
  });
}

async function openMatchStats() {
  state.phase = "opening";
  await page.goto(MATCHSTATS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  // A aplicação é JavaScript; damos tempo para montar a interface.
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1200);

  state.currentUrl = page.url();
  state.title = await page.title();
  state.diagnostics.pageReady = true;
}

async function clickMatchTabIfPresent() {
  const candidates = [
    page.getByRole("button", { name: /^Match$/i }).first(),
    page.getByText("Match", { exact: true }).first(),
    page.locator("button").filter({ hasText: /^Match$/i }).first()
  ];

  for (const locator of candidates) {
    try {
      if (await locator.count() && await locator.isVisible()) {
        await locator.click();
        await page.waitForTimeout(300);
        return true;
      }
    } catch {}
  }

  return false;
}

async function findMatchInput() {
  const selectors = [
    'input[placeholder="Match ID/ Name"]',
    'input[placeholder*="Match ID" i]',
    'input[placeholder*="Match" i]',
    'input[type="search"]'
  ];

  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      if (await loc.count() && await loc.isVisible()) return loc;
    } catch {}
  }

  // Último recurso: somente inputs visíveis, ignorando campos de login/outros.
  const inputs = page.locator("input:visible");
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const loc = inputs.nth(i);
    const placeholder = await loc.getAttribute("placeholder").catch(() => "");
    const type = await loc.getAttribute("type").catch(() => "text");
    const text = `${placeholder || ""} ${type || ""}`.toLowerCase();

    if (text.includes("match") || type === "search") return loc;
  }

  return null;
}

async function triggerSearch(input) {
  state.phase = "searching";
  state.diagnostics.inputFound = true;

  await input.fill(state.matchId);

  // Primeiro usa o comportamento natural do campo.
  await input.press("Enter").catch(() => {});

  // Se houver botão explícito de busca, tentamos somente se ele estiver visível.
  const buttonNames = [/^search$/i, /^go$/i, /^submit$/i];
  for (const re of buttonNames) {
    const button = page.getByRole("button", { name: re }).first();
    try {
      if (await button.count() && await button.isVisible()) {
        await button.click();
        break;
      }
    } catch {}
  }

  state.diagnostics.searchTriggered = true;

  await page.waitForTimeout(1500);
}

async function captureSnapshot() {
  const snapshot = await page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")].map((table, index) => ({
      index,
      rows: [...table.querySelectorAll("tr")]
        .map(tr =>
          [...tr.querySelectorAll("th,td")].map(td => td.innerText.trim())
        )
        .filter(row => row.length)
    }));

    const visibleInputs = [...document.querySelectorAll("input")]
      .filter(el => {
        const s = getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden";
      })
      .map(el => ({
        placeholder: el.getAttribute("placeholder"),
        value: el.value,
        type: el.getAttribute("type")
      }));

    const buttons = [...document.querySelectorAll("button")]
      .filter(el => {
        const s = getComputedStyle(el);
        return s.display !== "none" && s.visibility !== "hidden";
      })
      .map(el => (el.innerText || "").trim())
      .filter(Boolean);

    return {
      capturedAt: new Date().toISOString(),
      title: document.title,
      url: location.href,
      tables,
      visibleInputs,
      buttons,
      bodyText: document.body.innerText
    };
  });

  state.currentUrl = snapshot.url;
  state.title = snapshot.title;

  return snapshot;
}

async function startMonitor(matchId, myOperation) {
  try {
    await ensureBrowser();
    if (myOperation !== operationId) return;

    await openMatchStats();
    if (myOperation !== operationId) return;

    await clickMatchTabIfPresent();

    const input = await findMatchInput();
    if (!input) {
      const snap = await captureSnapshot();
      throw new Error(
        `Campo de MatchID não encontrado. A página carregou, mas a interface de pesquisa não foi localizada. URL atual: ${snap.url}`
      );
    }

    await triggerSearch(input);
    if (myOperation !== operationId) return;

    const first = await captureSnapshot();

    state.data = first;
    state.lastUpdate = first.capturedAt;
    state.status = "CONECTADO";
    state.phase = "monitoring";
    state.error = null;

    // Página fica aberta. Não fazemos reload.
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => pollOnce(myOperation), POLL_MS);
  } catch (error) {
    setError(error.message, state.phase);
  }
}

async function pollOnce(myOperation) {
  if (!state.running || polling || myOperation !== operationId || !page) return;

  polling = true;

  try {
    const current = await captureSnapshot();

    if (state.data && comparable(state.data) !== comparable(current)) {
      state.changes++;
    }

    state.data = current;
    state.polls++;
    state.lastUpdate = current.capturedAt;
    state.currentUrl = current.url;
    state.title = current.title;
    state.status = "CONECTADO";
    state.phase = "monitoring";
    state.error = null;
  } catch (error) {
    state.status = "ERRO";
    state.error = String(error.message || error);
  } finally {
    polling = false;
  }
}

app.post("/api/start", (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();

  if (!matchId) {
    return res.status(400).json({ error: "Informe um MatchID." });
  }

  operationId++;
  const myOperation = operationId;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;

  resetState(matchId);

  // Não bloqueia a resposta HTTP enquanto o Chromium abre e pesquisa.
  startMonitor(matchId, myOperation);

  res.json({
    ok: true,
    message: "Monitoramento iniciado.",
    state
  });
});

app.post("/api/stop", async (_req, res) => {
  operationId++;

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;

  state.running = false;
  state.status = "PARADO";
  state.phase = "idle";

  res.json({ ok: true, state });
});

app.get("/api/state", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(state);
});

app.get("/api/diagnostics", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    ...state.diagnostics,
    phase: state.phase,
    status: state.status,
    currentUrl: state.currentUrl,
    title: state.title,
    error: state.error
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "stats-engine-v2",
    intervalMs: POLL_MS
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stats Engine V2 ativo na porta ${PORT}`);
  console.log(`MatchStats: ${MATCHSTATS_URL}`);
});

process.on("SIGTERM", async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (browser) await browser.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (browser) await browser.close();
  process.exit(0);
});
