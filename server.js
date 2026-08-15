const express = require("express");
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
let liveWatchTask = null;
const sseClients = new Set();

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
    page.setDefaultTimeout(7000);
  }
  return page;
}

function clean(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function sameData(a, b) {
  return JSON.stringify({
    teamData: a?.teamData || [],
    playerData: a?.playerData || []
  }) === JSON.stringify({
    teamData: b?.teamData || [],
    playerData: b?.playerData || []
  });
}

function broadcast(result) {
  const payload = `data: ${JSON.stringify({ ok: true, result })}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function normalizeMatrix(matrix, kind) {
  if (!Array.isArray(matrix) || matrix.length < 2) return [];

  let header = (matrix[0] || []).map((v, i) => clean(v) || `Coluna ${i + 1}`);
  const body = matrix.slice(1).map(row => header.map((_, i) => clean(row?.[i] ?? "")));

  const norm = v => clean(v).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");

  const find = (...terms) => {
    for (let i = 0; i < header.length; i++) {
      const h = norm(header[i]);
      if (terms.some(t => h.includes(t))) return i;
    }
    return -1;
  };

  // The MatchStats header can contain grouped cells. Never allow values from
  // the first two ranked records (for example "1 / 2" or "UID1 / UID2") to
  // become column names. Those records must remain normal body rows.
  const looksLikeData = value => {
    const v = clean(value);
    if (!v) return true;
    if (/^\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?$/.test(v)) return true;
    if (/^\d+\s*\/\s*\d+$/.test(v)) return true;
    return false;
  };

  const labelAliases = kind === "team"
    ? /rank|team|equipe|score|survival|kill|damage|headshot|assist|position|uid|id|point/i
    : /rank|player|nickname|nick|team|equipe|uid|id|score|survival|kill|damage|headshot|assist|knock|rescue|revive|position/i;

  if (header.some(looksLikeData) || header.some(v => !labelAliases.test(v))) {
    // Keep only a clean label for columns that were accidentally merged with
    // the top records. For normal labels this is a no-op.
    header = header.map((v, i) => {
      const parts = clean(v).split(/\s+\/\s+/).map(clean).filter(Boolean);
      const good = parts.find(x => !looksLikeData(x) && labelAliases.test(x));
      return good || (parts.length === 1 && !looksLikeData(parts[0]) ? parts[0] : `Coluna ${i + 1}`);
    });
  }

  const rankIdx = find("rank", "posicao", "position");
  if (rankIdx >= 0) header[rankIdx] = "Rank";
  else {
    header.unshift("Rank");
    body.forEach((row, i) => row.unshift(String(i + 1)));
  }

  if (kind === "team") {
    const teamIdx = find("teamname", "team", "equipe");
    const survivalIdx = find("survivalscore", "survivalpoints", "survivalpoint", "survivals");
    const killIdx = find("kills", "kill", "eliminacoes", "eliminacao");
    const totalIdx = find("totalscore", "totalpoints", "totalpoint", "points", "score");

    if (teamIdx >= 0) header[teamIdx] = "Team Name";
    if (survivalIdx >= 0) header[survivalIdx] = "Survival Score";
    if (killIdx >= 0) header[killIdx] = "Kill";
    if (totalIdx >= 0) header[totalIdx] = "Total Score";
  } else {
    const playerIdx = find("playername", "nickname", "player", "nick");
    const teamIdx = find("teamname", "team", "equipe");
    const uidIdx = find("uid", "playerid", "accountid");
    const survivalIdx = find("survivalscore", "survivalpoints", "survivalpoint", "survivals");
    const killIdx = find("kills", "kill", "eliminacoes", "eliminacao");
    const totalIdx = find("totalscore", "totalpoints", "totalpoint", "points", "score");

    if (playerIdx >= 0) header[playerIdx] = "Player Name";
    if (teamIdx >= 0) header[teamIdx] = "Team Name";
    if (uidIdx >= 0) header[uidIdx] = "UID";
    if (survivalIdx >= 0) header[survivalIdx] = "Survival Score";
    if (killIdx >= 0) header[killIdx] = "Kill";
    if (totalIdx >= 0) header[totalIdx] = "Total Score";
  }

  const finalRankIdx = header.findIndex(h => norm(h) === "rank");
  if (finalRankIdx >= 0) body.forEach((row, i) => row[finalRankIdx] = String(i + 1));

  return [header, ...body];
}
async function searchMatch(page, matchId) {
  const id = String(matchId).trim();

  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 18000 });

  const selectors = [
    'input[placeholder*="Match ID" i]',
    'input[placeholder*="Match" i]',
    'input[name*="match" i]',
    'input[type="search"]',
    'input[type="text"]'
  ];

  let input = null;
  for (const sel of selectors) {
    const loc = page.locator(sel);
    for (let i = 0; i < await loc.count(); i++) {
      const x = loc.nth(i);
      if (await x.isVisible().catch(() => false)) { input = x; break; }
    }
    if (input) break;
  }
  if (!input) throw new Error("Campo de pesquisa do MatchStats não foi localizado.");

  await input.fill(id);
  await input.press("Enter").catch(() => {});

  // Give the site's own search code a short head start. No network-idle wait:
  // MatchStats can keep background connections open and that used to make the
  // old engine unnecessarily slow.
  await page.waitForTimeout(80);

  const searchButtons = [
    'button[type="submit"]',
    'button[title*="Search" i]',
    '[aria-label*="Search" i]',
    'button:has(i[class*="search" i])'
  ];

  const rowDeadline = Date.now() + 6500;
  while (Date.now() < rowDeadline) {
    const rows = page.locator("tr");
    for (let i = 0; i < await rows.count(); i++) {
      const row = rows.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      if (!(await row.innerText().catch(() => "")).includes(id)) continue;

      const controls = row.locator("a,button");
      for (let j = 0; j < await controls.count(); j++) {
        const b = controls.nth(j);
        const label = clean(
          (await b.innerText().catch(() => "")) + " " +
          (await b.getAttribute("title").catch(() => "")) + " " +
          (await b.getAttribute("aria-label").catch(() => ""))
        );
        if (/\bview\b/i.test(label)) {
          await b.click({ timeout: 1500 });
          return;
        }
      }
    }

    for (const sel of searchButtons) {
      const loc = page.locator(sel);
      for (let i = 0; i < await loc.count(); i++) {
        const b = loc.nth(i);
        if (await b.isVisible().catch(() => false)) {
          await b.click({ timeout: 700 }).catch(() => {});
          break;
        }
      }
    }

    await page.waitForTimeout(100);
  }

  // Last fallback: locate View near the exact MatchID, including nested/frame-ish DOM.
  const views = page.getByText("View", { exact: true });
  for (let i = 0; i < await views.count(); i++) {
    const v = views.nth(i);
    if (!(await v.isVisible().catch(() => false))) continue;
    const parent = v.locator("xpath=ancestor::tr[1]");
    if (await parent.count()) {
      const txt = await parent.innerText().catch(() => "");
      if (txt.includes(id)) { await v.click(); return; }
    }
  }

  throw new Error(`O MatchID ${id} não apareceu nos resultados do MatchStats.`);
}

async function clickTab(page, label) {
  const candidates = [
    page.getByText(label, { exact: true }),
    page.locator(`[role="tab"]`).filter({ hasText: label }),
    page.locator("button").filter({ hasText: label }),
    page.locator("a").filter({ hasText: label })
  ];
  for (const c of candidates) {
    for (let i = 0; i < await c.count(); i++) {
      const el = c.nth(i);
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 1200 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

async function extractSection(page, section) {
  await clickTab(page, section);

  const deadline = Date.now() + 2500;
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
              for (let cc = 0; cc < cs; cc++) grid[r + rr][col + cc] = text;
            }
            col += cs;
          }
        }
        return grid;
      }

      function expandRow(row) {
        const out = [];
        let col = 0;
        for (const cell of row.querySelectorAll(":scope > th, :scope > td")) {
          while (out[col] !== undefined) col++;
          const text = clean(cell.innerText);
          const cs = Math.max(1, Number(cell.getAttribute("colspan") || 1));
          for (let cc = 0; cc < cs; cc++) out[col + cc] = text;
          col += cs;
        }
        return out;
      }

      function headerScore(values, wantedSection) {
        const text = values.join(" | ");
        const known = wantedSection === "Team Data"
          ? /rank|team|equipe|score|survival|kill|damage|headshot|assist|position|uid|id|point/ig
          : /rank|player|nickname|nick|team|equipe|uid|id|score|survival|kill|damage|headshot|assist|knock|rescue|revive|position/ig;
        let score = 0;
        for (const value of values) {
          if (!value) continue;
          if (known.test(value)) score += 12;
          if (/^\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?$/.test(value)) score -= 20;
          else if (value.length > 24 && !/\s/.test(value)) score -= 8;
          else score += 2;
        }
        if (/\brank\b/i.test(text)) score += 30;
        if (wantedSection === "Team Data" && /team\s*name|teamname/i.test(text)) score += 35;
        if (wantedSection === "Player Data" && /player\s*name|nickname|nick/i.test(text)) score += 35;
        return score;
      }

      function chooseHeaderRows(rows, wantedSection) {
        if (!rows.length) return [];
        const candidates = rows.map(row => expandRow(row));
        let best = candidates[0], bestScore = -Infinity;
        for (const values of candidates) {
          const score = headerScore(values, wantedSection);
          if (score > bestScore) { bestScore = score; best = values; }
        }
        return best;
      }

      const tables = [...document.querySelectorAll("table")].filter(t => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      let best = null, bestScore = -1;
      for (const table of tables) {
        const allRows = [...table.querySelectorAll("tr")];
        const theadRows = [...table.querySelectorAll("thead > tr")];
        if (!allRows.length) continue;

        const headerRows = theadRows.length ? theadRows : allRows.slice(0, Math.min(2, allRows.length));
        const header = chooseHeaderRows(headerRows, wantedSection);
        let bodyRows;
        if (theadRows.length) {
          bodyRows = table.querySelector("tbody")
            ? [...table.querySelector("tbody").querySelectorAll(":scope > tr")]
            : allRows.slice(theadRows.length);
        } else {
          // Without a <thead>, only the selected header row is a header.
          // The next row is Rank 1, followed by Rank 2, etc.; never discard
          // the first two ranked records as if they were header rows.
          const selectedHeaderIndex = headerRows.findIndex(row => {
            const values = expandRow(row);
            return values.length === header.length && values.every((v, i) => v === header[i]);
          });
          bodyRows = allRows.slice(Math.max(0, selectedHeaderIndex) + 1);
        }
        const body = bodyRows.map(tr => [...tr.querySelectorAll(":scope > td, :scope > th")].map(c => clean(c.innerText))).filter(r => r.length);
        if (!header.length || !body.length) continue;

        const h = header.join(" | ").toLowerCase();
        let score = body.length * 4 + header.length * 2;
        if (wantedSection === "Team Data") {
          if (/\brank\b/.test(h)) score += 25;
          if (/team ?name|teamname/.test(h)) score += 40;
          if (/team ?id|match ?id/.test(h)) score += 20;
          if (/score|survival|damage|kill|headshot/.test(h)) score += 25;
          if (/nickname|uid|player/.test(h)) score -= 20;
        } else {
          if (/\brank\b/.test(h)) score += 15;
          if (/nickname|player ?name|playername/.test(h)) score += 40;
          if (/\buid\b|player ?id/.test(h)) score += 25;
          if (/team ?name|teamname/.test(h)) score += 10;
          if (/kill|headshot|survival|revival|rescue|damage/.test(h)) score += 25;
        }
        if (header.length >= 5) score += 10;
        if (score > bestScore) { bestScore = score; best = [header, ...body]; }
      }
      return best || [];
    }, section);

    if (matrix.length >= 2) return normalizeMatrix(matrix, section === "Team Data" ? "team" : "player");
    await page.waitForTimeout(50);
  }
  return [];
}

async function installLiveObserver(page) {
  await page.evaluate(() => {
    window.__statsVersion = 0;
    window.__statsObserverInstalled = true;
    window.__statsSuspend = false;
    window.__statsObserver?.disconnect();

    // The observer fires immediately when MatchStats changes the table.
    // The server checks this version every 30ms, so the next snapshot is
    // never intentionally delayed by the previous 90ms debounce.
    const bump = () => {
      if (window.__statsSuspend) return;
      window.__statsVersion++;
    };

    const observer = new MutationObserver(bump);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true
    });
    window.__statsObserver = observer;
  });
}

let livePollTimer = null;
let liveRefreshBusy = false;
let liveSeenVersion = -1;

function stopLiveWatch() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = null;
  liveRefreshBusy = false;
  liveSeenVersion = -1;
}

function liveWatchLoop() {
  stopLiveWatch();
  livePollTimer = setInterval(async () => {
    if (!page || !lastResult || liveRefreshBusy) return;
    try {
      const version = await page.evaluate(() => window.__statsVersion || 0);
      if (version === liveSeenVersion) return;
      liveSeenVersion = version;
      liveRefreshBusy = true;
      await refreshSnapshot();
    } catch {
      // Keep the 30ms watcher alive. A transient Playwright/DOM read failure
      // must not stop live capture for the whole match.
    } finally {
      liveRefreshBusy = false;
    }
  }, 30);
}

async function capture(matchId) {
  stopLiveWatch();
  const p = await getPage();
  await searchMatch(p, matchId);
  await p.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  await p.waitForTimeout(50);

  const team = await extractSection(p, "Team Data");
  const player = await extractSection(p, "Player Data");
  if (!team.length && !player.length) throw new Error("A página View abriu, mas nenhuma tabela Team Data/Player Data foi capturada.");

  lastResult = {
    matchId: String(matchId),
    sourceUrl: p.url(),
    capturedAt: new Date().toISOString(),
    teamData: team,
    playerData: player
  };

  await installLiveObserver(p);
  liveWatchLoop();
  return lastResult;
}

app.get("/api/events", (req, res) => {
  const matchId = String(req.query?.matchId || "").trim();
  if (!lastResult || !/^\d+$/.test(matchId) || String(lastResult.matchId) !== matchId) {
    return res.status(409).end();
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ ok: true, result: lastResult })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "1.1.0", busy, hasBrowser: !!browser, live: !!livePollTimer, pollMs: 30 });
});

app.post("/api/capture", async (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();
  if (!/^\d+$/.test(matchId)) return res.status(400).json({ ok: false, error: "O MatchID deve conter apenas números." });
  if (busy) return res.status(409).json({ ok: false, error: "Já existe uma captura em andamento. Aguarde alguns segundos." });

  busy = true;
  const started = Date.now();
  try {
    const result = await capture(matchId);
    result.elapsedMs = Date.now() - started;
    lastResult = result;
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Falha na captura.", elapsedMs: Date.now() - started });
  } finally {
    busy = false;
  }
});

app.get("/api/last", (req, res) => res.json({ ok: true, result: lastResult }));

app.listen(PORT, "0.0.0.0", () => console.log(`Stats Engine 1.1.0 running on port ${PORT}`));

process.on("SIGTERM", async () => {
  for (const res of sseClients) { try { res.end(); } catch {} }
  stopLiveWatch();
  try { await browser?.close(); } catch {}
  process.exit(0);
});
