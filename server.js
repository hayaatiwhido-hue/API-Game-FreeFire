const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
const MATCHSTATS_URL = "https://matchstats.us.ffesports.com/";
const VERSION = "1.0.3";
let activeJob = null;

const cleanText = v => String(v ?? "").replace(/\s+/g, " ").trim();

async function visible(locator) {
  try { return await locator.isVisible(); } catch { return false; }
}

async function allFrames(page) {
  return page.frames();
}

async function frameText(frame) {
  return frame.locator("body").innerText().catch(() => "");
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
  for (const frame of await allFrames(page)) {
    for (const selector of selectors) {
      const loc = frame.locator(selector);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) if (await visible(loc.nth(i))) return loc.nth(i);
    }
    const inputs = frame.locator("input");
    const count = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i);
      if (!await visible(el)) continue;
      const type = (await el.getAttribute("type").catch(() => "")) || "";
      if (!["hidden", "button", "submit", "checkbox", "radio"].includes(type)) return el;
    }
  }
  return null;
}

async function clickSearch(page) {
  const selectors = [
    'button:has-text("Search")', 'a:has-text("Search")',
    'button[aria-label*="search" i]', 'button[title*="search" i]',
    '.fa-search', '.glyphicon-search', 'i[class*="search" i]'
  ];
  for (const frame of await allFrames(page)) {
    for (const selector of selectors) {
      const loc = frame.locator(selector);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) if (await visible(loc.nth(i))) {
        await loc.nth(i).click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

async function waitForMatch(page, matchId) {
  const end = Date.now() + 18000;
  while (Date.now() < end) {
    for (const frame of await allFrames(page)) {
      const body = await frameText(frame);
      if (body.includes(String(matchId))) return true;
    }
    await page.waitForTimeout(350);
  }
  return false;
}

async function elementLabel(el) {
  return cleanText([
    await el.innerText().catch(() => ""),
    await el.textContent().catch(() => ""),
    await el.getAttribute("title").catch(() => ""),
    await el.getAttribute("aria-label").catch(() => ""),
    await el.getAttribute("value").catch(() => ""),
    await el.getAttribute("data-original-title").catch(() => "")
  ].join(" "));
}

async function clickView(page, matchId) {
  // 1) Procura literalmente o botão/link View em TODAS as frames.
  const candidates = [
    'button', 'a', 'input[type="button"]', 'input[type="submit"]',
    '[role="button"]', '[title]', '[aria-label]'
  ];
  for (const frame of await allFrames(page)) {
    for (const selector of candidates) {
      const loc = frame.locator(selector);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (!await visible(el)) continue;
        const label = await elementLabel(el);
        if (/^view$/i.test(label) || /\bview\b/i.test(label)) {
          const before = page.url();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          const href = await el.getAttribute("href").catch(() => null);
          await el.click({ timeout: 8000 }).catch(async () => {
            await el.evaluate(node => node.click()).catch(() => {});
          });
          await page.waitForTimeout(1200);
          return { ok: true, method: "view-text", href, before, after: page.url(), label };
        }
      }
    }
  }

  // 2) Procura a linha de resultado. O MatchStats nem sempre coloca o MatchID
  // no texto da célula; nesse caso usamos a linha com a data/colunas e o último
  // grupo de controles, priorizando o controle que parece View.
  for (const frame of await allFrames(page)) {
    const rows = frame.locator("tr");
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      if (!await visible(row)) continue;
      const txt = cleanText(await row.innerText().catch(() => ""));
      const controls = row.locator('button,a,input[type="button"],input[type="submit"],[role="button"]');
      const cc = await controls.count().catch(() => 0);
      if (!cc) continue;
      // Resultado do MatchStats possui uma coluna Operation; ela normalmente é a última.
      for (let j = 0; j < cc; j++) {
        const c = controls.nth(j);
        if (!await visible(c)) continue;
        const label = await elementLabel(c);
        if (/view/i.test(label)) {
          const href = await c.getAttribute("href").catch(() => null);
          await c.click({ timeout: 8000 }).catch(async () => await c.evaluate(node => node.click()).catch(() => {}));
          await page.waitForTimeout(1200);
          return { ok: true, method: "row-view", href, rowText: txt.slice(0, 500), label };
        }
      }
      // Se a linha contém uma data típica e não achamos o texto View, tente o primeiro controle da Operation.
      if (/\d{2}-\d{2}-\d{4}/.test(txt) && cc) {
        const c = controls.nth(0);
        const href = await c.getAttribute("href").catch(() => null);
        await c.click({ timeout: 8000 }).catch(async () => await c.evaluate(node => node.click()).catch(() => {}));
        await page.waitForTimeout(1200);
        return { ok: true, method: "row-first-control", href, rowText: txt.slice(0, 500), label: await elementLabel(c) };
      }
    }
  }

  // 3) Fallback por links: se o href aponta para a página de detalhe, navega diretamente.
  for (const frame of await allFrames(page)) {
    const links = frame.locator("a[href]");
    const n = await links.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const a = links.nth(i);
      if (!await visible(a)) continue;
      const href = await a.getAttribute("href").catch(() => "");
      const label = await elementLabel(a);
      if (/view|matchdetail|matchd/i.test(`${label} ${href}`)) {
        try {
          if (href && !href.startsWith("javascript:")) {
            const url = new URL(href, page.url()).href;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(1000);
            return { ok: true, method: "href-fallback", href: url, label };
          }
        } catch {}
      }
    }
  }

  throw new Error(`A partida ${matchId} foi localizada, mas o controle View não pôde ser acionado. O MatchStats pode estar usando um componente/iframe diferente.`);
}

async function extractTables(page) {
  const all = [];
  for (const frame of await allFrames(page)) {
    const tables = await frame.locator("table:visible").evaluateAll(tables => {
      const norm = v => String(v ?? "").replace(/\s+/g, " ").trim();
      return tables.map((table, index) => {
        const trs = [...table.querySelectorAll("tr")];
        const rows = trs.map(tr => [...tr.querySelectorAll("th,td")].map(td => norm(td.innerText))).filter(r => r.some(Boolean));
        if (!rows.length) return null;
        let headers = rows[0], data = rows.slice(1);
        const head = table.querySelector("thead tr");
        if (head) headers = [...head.querySelectorAll("th,td")].map(td => norm(td.innerText));
        const bodyRows = [...table.querySelectorAll("tbody tr")];
        if (bodyRows.length) data = bodyRows.map(tr => [...tr.querySelectorAll("th,td")].map(td => norm(td.innerText)));
        return { index, headers, rows: data };
      }).filter(Boolean);
    }).catch(() => []);
    all.push(...tables);
  }
  return all;
}

function classifyTables(tables) {
  const team = [], player = [], other = [];
  for (const table of tables) {
    const h = table.headers.join(" | ").toLowerCase();
    if (/team id|team name|number of team|survival score|rescue members/.test(h)) team.push(table);
    else if (/player|uid|nickname|headshot|revival|damage|kill|headshot accuracy|on target/.test(h)) player.push(table);
    else other.push(table);
  }
  return { team, player, other };
}

async function clickTabLike(page, patterns) {
  for (const frame of await allFrames(page)) {
    const loc = frame.locator('a,button,[role="button"],li');
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!await visible(el)) continue;
      const label = await elementLabel(el);
      if (patterns.some(p => p.test(label))) {
        await el.click({ timeout: 7000 }).catch(async () => await el.evaluate(node => node.click()).catch(() => {}));
        await page.waitForTimeout(900);
        return { ok: true, label };
      }
    }
  }
  return { ok: false };
}

async function scrapeMatch(matchId) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);

  const result = { version: VERSION, matchId: String(matchId), source: MATCHSTATS_URL, capturedAt: new Date().toISOString(), match: {}, teamData: [], playerData: [], tables: [], downloads: [], diagnostics: {} };

  try {
    try { await page.goto(MATCHSTATS_URL, { waitUntil: "commit", timeout: 30000 }); }
    catch (e) { if (!page.url().includes("matchstats.us.ffesports.com")) throw e; }
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const input = await findSearchInput(page);
    if (!input) throw new Error("Campo de pesquisa do MatchStats não foi encontrado.");
    await input.fill(String(matchId));
    await clickSearch(page);
    await input.press("Enter").catch(() => {});
    const found = await waitForMatch(page, matchId);
    if (!found) throw new Error(`O MatchID ${matchId} não apareceu nos resultados do MatchStats.`);
    await page.waitForTimeout(1000);

    const view = await clickView(page, matchId);
    result.diagnostics.view = view;
    await page.waitForTimeout(1500);

    let tables = await extractTables(page);
    let classified = classifyTables(tables);

    // O detalhe pode apresentar TeamData primeiro e PlayerData em uma aba/ícone separado.
    if (!classified.player.length) {
      const playerClick = await clickTabLike(page, [/player\s*data/i, /^player$/i]);
      result.diagnostics.playerTab = playerClick;
      const after = await extractTables(page);
      const c2 = classifyTables(after);
      if (c2.player.length) { classified.player = c2.player; tables = after; }
    }

    // Volta/abre Team Data caso o clique de Player Data tenha trocado a área.
    if (!classified.team.length) {
      const teamClick = await clickTabLike(page, [/team\s*data/i, /^team$/i]);
      result.diagnostics.teamTab = teamClick;
      const after = await extractTables(page);
      const c2 = classifyTables(after);
      if (c2.team.length) { classified.team = c2.team; tables = after; }
    }

    result.tables = tables;
    result.teamData = classified.team;
    result.playerData = classified.player;
    result.match = { url: page.url(), title: await page.title().catch(() => ""), textPreview: (await page.locator("body").innerText().catch(() => "")).slice(0, 7000) };
    result.diagnostics = { ...result.diagnostics, finalUrl: page.url(), tablesFound: tables.length, teamTables: classified.team.length, playerTables: classified.player.length, otherTables: classified.other.length, frames: page.frames().length, pageReady: true };

    if (!classified.team.length && !classified.player.length) throw new Error("A página View abriu, mas nenhum TeamData/PlayerData foi encontrado. Veja o diagnóstico para identificar a estrutura carregada.");
    return result;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, version: VERSION, engine: "Playwright", playwright: require("playwright/package.json").version }));

app.post("/api/match", async (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();
  if (!/^\d{5,30}$/.test(matchId)) return res.status(400).json({ ok: false, error: "Informe um MatchID numérico válido." });
  if (activeJob) return res.status(429).json({ ok: false, error: "O Engine já está processando uma partida. Aguarde a captura terminar." });
  activeJob = matchId;
  try { res.json({ ok: true, data: await scrapeMatch(matchId) }); }
  catch (error) { res.status(502).json({ ok: false, version: VERSION, matchId, error: String(error?.message || error), hint: "A V1.0.3 amplia a procura do View para frames, controles, links e coluna Operation." }); }
  finally { activeJob = null; }
});

app.listen(PORT, () => console.log(`Stats Engine ${VERSION} running on port ${PORT}`));
