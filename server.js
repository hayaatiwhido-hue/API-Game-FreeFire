const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
const MATCHSTATS_URL = "https://matchstats.us.ffesports.com/";

let activeJob = null;

function cleanText(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

async function textOf(locator) {
  try { return cleanText(await locator.innerText()); } catch { return ""; }
}

async function clickIfPossible(locator) {
  try {
    if (await locator.count()) {
      const el = locator.first();
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 5000 });
      return true;
    }
  } catch {}
  return false;
}

async function findSearchInput(page) {
  const selectors = [
    'input[type="search"]',
    'input[placeholder*="search" i]',
    'input[placeholder*="match" i]',
    'input[name*="search" i]',
    'input[name*="match" i]',
    'input.form-control'
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector).filter({ visible: true });
    if (await loc.count()) return loc.first();
  }
  const inputs = page.locator("input:visible");
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    const type = (await el.getAttribute("type")) || "";
    if (!["hidden", "button", "submit", "checkbox", "radio"].includes(type)) return el;
  }
  return null;
}

async function clickSearch(page) {
  const candidates = [
    'button:has-text("Search")',
    'a:has-text("Search")',
    'button[aria-label*="search" i]',
    'button[title*="search" i]',
    'i[class*="search" i]',
    'svg[class*="search" i]'
  ];
  for (const s of candidates) {
    if (await clickIfPossible(page.locator(s))) return true;
  }
  return false;
}

async function waitForResults(page, matchId) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (body.includes(String(matchId))) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function searchMatch(page, matchId) {
  const input = await findSearchInput(page);
  if (!input) throw new Error("Campo de pesquisa do MatchStats não foi encontrado.");

  await input.fill(String(matchId));
  await clickSearch(page).catch(() => {});
  await input.press("Enter").catch(() => {});
  await waitForResults(page, matchId);
  await page.waitForTimeout(1200);

  const viewCandidates = [
    'button:has-text("View")',
    'a:has-text("View")',
    'input[type="button"][value*="View" i]',
    '[title*="View" i]',
    '[aria-label*="View" i]'
  ];

  for (const selector of viewCandidates) {
    const loc = page.locator(selector).filter({ visible: true });
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      const txt = cleanText(await el.innerText().catch(() => ""));
      const title = cleanText(await el.getAttribute("title").catch(() => ""));
      const aria = cleanText(await el.getAttribute("aria-label").catch(() => ""));
      if (/view/i.test(`${txt} ${title} ${aria}`)) {
        await el.click({ timeout: 7000 });
        await page.waitForTimeout(1000);
        return;
      }
    }
  }

  // Fallback: find the row containing the Match ID and click its first View-like control.
  const rows = page.locator("tr:visible");
  const rowCount = await rows.count();
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const text = await row.innerText().catch(() => "");
    if (text.includes(String(matchId))) {
      const controls = row.locator("button,a,input[type=button],input[type=submit]").filter({ visible: true });
      const cc = await controls.count();
      for (let j = 0; j < cc; j++) {
        const c = controls.nth(j);
        const label = cleanText(
          (await c.innerText().catch(() => "")) + " " +
          (await c.getAttribute("title").catch(() => "")) + " " +
          (await c.getAttribute("aria-label").catch(() => "")) + " " +
          (await c.getAttribute("value").catch(() => ""))
        );
        if (/view/i.test(label) || j === 0) {
          await c.click({ timeout: 7000 });
          await page.waitForTimeout(1000);
          return;
        }
      }
    }
  }

  throw new Error(`A partida ${matchId} foi localizada, mas o botão View não foi encontrado.`);
}

async function extractTables(page) {
  return await page.locator("table:visible").evaluateAll(tables => {
    const norm = v => String(v ?? "").replace(/\s+/g, " ").trim();
    return tables.map((table, index) => {
      const rows = [...table.querySelectorAll("tr")].map(tr =>
        [...tr.querySelectorAll("th,td")].map(td => norm(td.innerText))
      ).filter(r => r.some(Boolean));
      if (!rows.length) return null;
      let headers = rows[0];
      let data = rows.slice(1);
      const first = table.querySelector("thead tr");
      if (first) {
        headers = [...first.querySelectorAll("th,td")].map(td => norm(td.innerText));
        const bodyRows = [...table.querySelectorAll("tbody tr")];
        data = bodyRows.length
          ? bodyRows.map(tr => [...tr.querySelectorAll("th,td")].map(td => norm(td.innerText)))
          : rows.slice(1);
      }
      return { index, headers, rows: data };
    }).filter(Boolean);
  });
}

function classifyTables(tables) {
  const team = [];
  const player = [];
  const other = [];

  for (const table of tables) {
    const h = table.headers.join(" | ").toLowerCase();
    if (
      /team id|team name|number of team|survival score|rescue members/.test(h)
    ) team.push(table);
    else if (
      /player|uid|nickname|headshot|revival|damage|kill|headshot accuracy/.test(h)
    ) player.push(table);
    else other.push(table);
  }
  return { team, player, other };
}

async function clickPlayerData(page) {
  const selectors = [
    'a:has-text("Player Data")',
    'button:has-text("Player Data")',
    '[title*="Player Data" i]',
    '[aria-label*="Player Data" i]',
    '[data-original-title*="Player Data" i]',
    'a:has-text("Player")',
    'button:has-text("Player")'
  ];
  for (const s of selectors) {
    const loc = page.locator(s).filter({ visible: true });
    if (await loc.count()) {
      for (let i = 0; i < await loc.count(); i++) {
        const el = loc.nth(i);
        const label = cleanText(
          (await el.innerText().catch(() => "")) + " " +
          (await el.getAttribute("title").catch(() => "")) + " " +
          (await el.getAttribute("aria-label").catch(() => "")) + " " +
          (await el.getAttribute("data-original-title").catch(() => ""))
        );
        if (/player/i.test(label)) {
          await el.click({ timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(800);
          return true;
        }
      }
    }
  }
  return false;
}

async function scrapeMatch(matchId) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(10000);

  const result = {
    version: "1.0.2",
    matchId: String(matchId),
    source: MATCHSTATS_URL,
    capturedAt: new Date().toISOString(),
    match: {},
    teamData: [],
    playerData: [],
    tables: [],
    diagnostics: {}
  };

  try {
    // O MatchStats pode iniciar uma segunda navegação para a mesma URL.
    // "commit" + tratamento do erro evita o problema de page.goto interrompido
    // que apareceu nas versões anteriores.
    try {
      await page.goto(MATCHSTATS_URL, { waitUntil: "commit", timeout: 30000 });
    } catch (navError) {
      const current = page.url();
      if (!current.includes("matchstats.us.ffesports.com")) throw navError;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1600);

    await searchMatch(page, matchId);

    result.diagnostics.viewUrl = page.url();
    result.diagnostics.viewTitle = await page.title().catch(() => "");

    let tables = await extractTables(page);
    let classified = classifyTables(tables);

    // Some MatchStats builds expose Player Data through an operation icon/tab.
    if (!classified.player.length) {
      await clickPlayerData(page);
      const after = await extractTables(page);
      const afterClassified = classifyTables(after);
      if (afterClassified.player.length) {
        classified.player = afterClassified.player;
        tables = after;
      }
    }

    result.tables = tables;
    result.teamData = classified.team;
    result.playerData = classified.player;

    // Capture visible metadata around the match page.
    const bodyText = await page.locator("body").innerText().catch(() => "");
    result.match = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      textPreview: bodyText.slice(0, 5000)
    };

    result.diagnostics = {
      ...result.diagnostics,
      tablesFound: tables.length,
      teamTables: classified.team.length,
      playerTables: classified.player.length,
      otherTables: classified.other.length,
      pageReady: true
    };

    if (!classified.team.length && !classified.player.length) {
      throw new Error("A página da partida abriu, mas nenhum TeamData/PlayerData foi encontrado.");
    }

    return result;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: "1.0.2",
    engine: "Playwright",
    playwright: require("playwright/package.json").version
  });
});

app.post("/api/match", async (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();

  if (!/^\d{5,30}$/.test(matchId)) {
    return res.status(400).json({ ok: false, error: "Informe um MatchID numérico válido." });
  }

  if (activeJob) {
    return res.status(429).json({
      ok: false,
      error: "O Engine já está processando uma partida. Aguarde a captura terminar."
    });
  }

  activeJob = matchId;
  try {
    const data = await scrapeMatch(matchId);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(502).json({
      ok: false,
      version: "1.0.2",
      matchId,
      error: String(error?.message || error),
      hint: "O Engine usa o navegador do servidor para abrir o MatchStats, pesquisar o MatchID e entrar em View."
    });
  } finally {
    activeJob = null;
  }
});

app.listen(PORT, () => {
  console.log(`Stats Engine 1.0.2 running on port ${PORT}`);
});
