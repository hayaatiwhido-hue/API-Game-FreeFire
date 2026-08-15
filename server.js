const express = require("express");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;
const TARGET = "https://matchstats.us.ffesports.com/match";

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

let browser = null;
let context = null;
let page = null;
let busy = false;
let lastResult = null;
let livePollTimer = null;
let liveRefreshing = false;

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled"
      ]
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    });
    page = await context.newPage();
    page.setDefaultTimeout(9000);
  }
  return page;
}

function clean(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function norm(v) {
  return clean(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

async function visibleText(el) {
  try { return clean(await el.innerText()); } catch { return ""; }
}

async function clickSearch(page, input) {
  const candidates = [
    'button[type="submit"]',
    'button:has-text("Search")',
    'button[title*="Search" i]',
    '[aria-label*="Search" i]',
    '.fa-search',
    'i[class*="search" i]'
  ];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if (await loc.count()) {
        await loc.click({ timeout: 1200 });
        return true;
      }
    } catch {}
  }
  try {
    await input.press("Enter");
    return true;
  } catch {}
  return false;
}

async function searchMatch(page, matchId) {
  const id = String(matchId).trim();

  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

  // O MatchStats usa um campo de pesquisa dinâmico. Priorizamos o campo
  // identificado pelo placeholder/nome e usamos o primeiro input de texto como fallback.
  const selectors = [
    'input[placeholder*="Match ID" i]',
    'input[placeholder*="Match" i]',
    'input[name*="match" i]',
    'input[type="search"]',
    'input[type="text"]'
  ];

  let input = null;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const x = loc.nth(i);
        if (await x.isVisible()) {
          input = x;
          break;
        }
      }
      if (input) break;
    } catch {}
  }

  if (!input) throw new Error("Campo de pesquisa do MatchStats não foi localizado.");

  await input.click();
  await input.fill(id);
  await input.dispatchEvent("input").catch(() => {});
  await input.dispatchEvent("change").catch(() => {});

  // Primeiro tenta o comportamento nativo do formulário (Enter). Se a página
  // não responder, tenta o botão/ícone de pesquisa.
  await input.press("Enter").catch(() => {});
  await page.waitForTimeout(120);

  const searchSelectors = [
    'button[type="submit"]',
    'form button',
    'button[title*="Search" i]',
    '[aria-label*="Search" i]',
    'button:has(i[class*="search" i])',
    'i[class*="search" i]'
  ];

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    // Se a linha já apareceu, não fazemos nenhuma espera adicional.
    const row = page.locator("tr").filter({ hasText: id }).first();
    try {
      if (await row.count() && await row.isVisible()) break;
    } catch {}

    const body = await page.locator("body").innerText().catch(() => "");
    if (body.includes(id)) break;

    // Alguns builds precisam do clique no ícone depois do Enter.
    if (Date.now() + 1200 >= deadline) break;
    for (const sel of searchSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const b = loc.nth(i);
          if (await b.isVisible()) {
            await b.click({ timeout: 700 }).catch(() => {});
            break;
          }
        }
      } catch {}
    }

    await page.waitForTimeout(180);
  }

  // Localiza a linha exata da partida. Não usamos apenas "body contém ID",
  // porque isso pode encontrar o ID em outro lugar da página.
  const rows = page.locator("tr");
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    try {
      if (!(await row.isVisible())) continue;
      const txt = await row.innerText();
      if (!txt.includes(id)) continue;

      const controls = row.locator("a,button");
      for (let j = 0; j < await controls.count(); j++) {
        const b = controls.nth(j);
        const label = clean(
          (await b.innerText().catch(() => "")) + " " +
          (await b.getAttribute("title").catch(() => "")) + " " +
          (await b.getAttribute("aria-label").catch(() => ""))
        );
        if (/\bview\b/i.test(label)) {
          await b.click();
          return true;
        }
      }
    } catch {}
  }

  // Fallback para estruturas onde View não está diretamente dentro do <tr>.
  const views = page.getByText("View", { exact: true });
  for (let i = 0; i < await views.count(); i++) {
    try {
      const v = views.nth(i);
      if (!(await v.isVisible())) continue;
      const parent = v.locator("xpath=ancestor::tr[1]");
      if (await parent.count()) {
        const txt = await parent.innerText().catch(() => "");
        if (txt.includes(id)) {
          await v.click();
          return true;
        }
      }
    } catch {}
  }

  throw new Error(`O MatchID ${id} não apareceu nos resultados do MatchStats. Verifique se a partida está publicada e tente novamente.`);
}

async function extractTable(page) {
  return await page.evaluate(() => {
    const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();

    const tables = [...document.querySelectorAll("table")].filter(t => {
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    let best = null;
    let bestScore = -1;

    for (const table of tables) {
      const rows = [...table.querySelectorAll("tr")];
      if (!rows.length) continue;

      const matrix = rows.map(r => [...r.querySelectorAll("th,td")].map(c => clean(c.innerText)));
      const header = (matrix[0] || []).join(" | ").toLowerCase();
      let score = matrix.length * 2;
      if (/match id|team id|team name/.test(header)) score += 30;
      if (/player|nickname|uid/.test(header)) score += 20;
      if (/kill|headshot|survival|revival|rescue/.test(header)) score += 10;

      if (score > bestScore) {
        bestScore = score;
        best = matrix;
      }
    }

    return best || [];
  });
}

async function clickTab(page, label) {
  const candidates = [
    page.getByText(label, { exact: true }),
    page.locator(`[role="tab"]`).filter({ hasText: label }),
    page.locator(`button`).filter({ hasText: label }),
    page.locator(`a`).filter({ hasText: label })
  ];

  for (const c of candidates) {
    try {
      const n = await c.count();
      for (let i = 0; i < n; i++) {
        const el = c.nth(i);
        if (await el.isVisible()) {
          await el.click({ timeout: 1500 });
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function extractSection(page, section) {
  await clickTab(page, section);

  const deadline = Date.now() + 3500;

  while (Date.now() < deadline) {
    const matrix = await page.evaluate((wantedSection) => {
      const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();

      function expandRows(rows) {
        const grid = [];
        for (let r = 0; r < rows.length; r++) {
          if (!grid[r]) grid[r] = [];
          let col = 0;

          for (const cell of rows[r].querySelectorAll(":scope > th, :scope > td")) {
            while (grid[r][col] !== undefined) col++;

            const text = clean(cell.innerText);
            const rs = Math.max(1, Number(cell.getAttribute("rowspan") || 1));
            const cs = Math.max(1, Number(cell.getAttribute("colspan") || 1));

            for (let rr = 0; rr < rs; rr++) {
              if (!grid[r + rr]) grid[r + rr] = [];
              for (let cc = 0; cc < cs; cc++) {
                grid[r + rr][col + cc] = text;
              }
            }
            col += cs;
          }
        }
        return grid;
      }

      function normalizeHeader(headerRows) {
        const expanded = expandRows(headerRows);
        const width = Math.max(0, ...expanded.map(r => r.length));
        const header = [];

        for (let c = 0; c < width; c++) {
          const parts = [];
          for (let r = 0; r < expanded.length; r++) {
            const value = clean(expanded[r]?.[c] || "");
            if (value && !parts.includes(value)) parts.push(value);
          }
          header[c] = parts.join(" / ");
        }
        return header;
      }

      const tables = [...document.querySelectorAll("table")].filter(t => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      let best = null;
      let bestScore = -1;

      for (const table of tables) {
        const theadRows = [...table.querySelectorAll("thead > tr")];
        const allRows = [...table.querySelectorAll("tr")];
        if (!allRows.length) continue;

        let header = [];
        let bodyRows = [];

        if (theadRows.length) {
          header = normalizeHeader(theadRows);
          const tbody = table.querySelector("tbody");
          bodyRows = tbody
            ? [...tbody.querySelectorAll(":scope > tr")]
            : allRows.slice(theadRows.length);
        } else {
          // Fallback for tables that do not use THEAD/TBODY.
          const headerCandidates = allRows.slice(0, Math.min(2, allRows.length));
          header = normalizeHeader(headerCandidates);
          bodyRows = allRows.slice(headerCandidates.length);
        }

        const body = bodyRows.map(tr => {
          const cells = [...tr.querySelectorAll(":scope > td, :scope > th")];
          return cells.map(c => clean(c.innerText));
        }).filter(row => row.length);

        if (!header.length || !body.length) continue;

        // Some tables expose duplicated/empty header cells. Keep the real
        // labels such as Rank, TeamName, UID, Kill, Headshot, etc.
        const h = header.join(" | ").toLowerCase();

        let score = body.length * 4 + header.length * 2;

        if (wantedSection === "Team Data") {
          if (/\brank\b/.test(h)) score += 25;
          if (/team ?name|teamname/.test(h)) score += 35;
          if (/team ?id|match ?id/.test(h)) score += 25;
          if (/score|survival|damage|kill|headshot/.test(h)) score += 30;
          if (/nickname|uid|player/.test(h)) score -= 15;
        } else {
          if (/\brank\b/.test(h)) score += 15;
          if (/nickname|player ?name|playername/.test(h)) score += 40;
          if (/\buid\b|player ?id/.test(h)) score += 30;
          if (/team ?name|teamname/.test(h)) score += 10;
          if (/kill|headshot|survival|revival|rescue|damage/.test(h)) score += 30;
        }

        if (header.length >= 5) score += 10;

        if (score > bestScore) {
          bestScore = score;
          best = [header, ...body];
        }
      }

      return best || [];
    }, section);

    if (matrix.length >= 2) return matrix;
    await page.waitForTimeout(60);
  }

  return [];
}

async function refreshCurrentMatch() {
  if (!page || !lastResult?.sourceUrl || liveRefreshing) return null;

  liveRefreshing = true;
  try {
    // The official MatchStats updates its displayed values after a page
    // reload. Reload the exact View URL instead of searching the MatchID again.
    await page.goto(lastResult.sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10000
    }).catch(() => {});

    await page.waitForTimeout(120);

    const team = await extractSection(page, "Team Data");
    const player = await extractSection(page, "Player Data");

    if (team.length >= 2 || player.length >= 2) {
      lastResult = {
        ...lastResult,
        sourceUrl: page.url() || lastResult.sourceUrl,
        capturedAt: new Date().toISOString(),
        teamData: team.length >= 2 ? team : lastResult.teamData,
        playerData: player.length >= 2 ? player : lastResult.playerData
      };
    }

    return lastResult;
  } finally {
    liveRefreshing = false;
  }
}

function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

function startLivePolling() {
  stopLivePolling();
  livePollTimer = setInterval(() => {
    refreshCurrentMatch().catch(() => {});
  }, 1000);
}

async function capture(matchId) {
  stopLivePolling();

  const p = await getPage();
  await p.bringToFront();

  await searchMatch(p, matchId);

  await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(80);

  const team = await extractSection(p, "Team Data");
  const player = await extractSection(p, "Player Data");

  if (!team.length && !player.length) {
    throw new Error("A página View abriu, mas nenhuma tabela Team Data/Player Data foi capturada.");
  }

  const result = {
    matchId: String(matchId),
    sourceUrl: p.url(),
    capturedAt: new Date().toISOString(),
    teamData: team,
    playerData: player
  };

  lastResult = result;
  startLivePolling();
  return result;
}


app.get("/api/refresh", async (req, res) => {
  const matchId = String(req.query?.matchId || "").trim();

  if (!/^\d+$/.test(matchId)) {
    return res.status(400).json({ ok: false, error: "O MatchID deve conter apenas números." });
  }

  if (!lastResult || String(lastResult.matchId) !== matchId) {
    return res.status(409).json({ ok: false, error: "Nenhuma captura ativa para este MatchID." });
  }

  try {
    // Return the latest server-side snapshot. The background poller is
    // already refreshing the official View every second.
    return res.json({ ok: true, result: lastResult });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Falha na atualização."
    });
  }
});


app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "1.0.11", busy, hasBrowser: !!browser });
});

app.post("/api/capture", async (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();

  if (!/^\d+$/.test(matchId)) {
    return res.status(400).json({ ok: false, error: "O MatchID deve conter apenas números." });
  }

  if (busy) {
    return res.status(409).json({ ok: false, error: "Já existe uma captura em andamento. Aguarde alguns segundos." });
  }

  busy = true;
  const started = Date.now();

  try {
    const result = await capture(matchId);
    result.elapsedMs = Date.now() - started;
    lastResult = result;
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "Falha na captura.",
      elapsedMs: Date.now() - started
    });
  } finally {
    busy = false;
  }
});

app.get("/api/last", (req, res) => {
  res.json({ ok: true, result: lastResult });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stats Engine 1.0.10 running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  stopLivePolling();
  try { await browser?.close(); } catch {}
  process.exit(0);
});
