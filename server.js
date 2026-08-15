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
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

  const inputs = page.locator("input");
  let input = null;

  for (let i = 0; i < await inputs.count(); i++) {
    const x = inputs.nth(i);
    try {
      if (await x.isVisible()) {
        const ph = clean(await x.getAttribute("placeholder"));
        const name = clean(await x.getAttribute("name"));
        const type = clean(await x.getAttribute("type"));
        if (type !== "hidden" && !/date|season|event/i.test(`${ph} ${name}`)) {
          input = x;
          break;
        }
      }
    } catch {}
  }

  if (!input) throw new Error("Campo de pesquisa do MatchStats não foi localizado.");

  await input.click();
  await input.fill(id);
  await input.dispatchEvent("input");
  await input.dispatchEvent("change");
  await clickSearch(page, input);

  // A página oficial faz uma consulta assíncrona. Em vez de procurar imediatamente,
  // observamos DOM + URL por alguns segundos, em pequenos intervalos.
  const deadline = Date.now() + 9000;
  let found = false;

  while (Date.now() < deadline) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (body.includes(id)) {
      found = true;
      break;
    }

    // Algumas versões do MatchStats renderizam o resultado em iframe.
    for (const fr of page.frames()) {
      try {
        const t = await fr.locator("body").innerText({ timeout: 500 }).catch(() => "");
        if (t.includes(id)) { found = true; break; }
      } catch {}
    }
    if (found) break;
    await page.waitForTimeout(180);
  }

  if (!found) {
    throw new Error(`O MatchID ${id} não apareceu nos resultados do MatchStats após a pesquisa.`);
  }

  // Localiza a linha que contém o ID e procura o View dentro dela.
  const rows = page.locator("tr");
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    try {
      if (!(await row.isVisible())) continue;
      const txt = await row.innerText();
      if (!txt.includes(id)) continue;

      const links = row.locator("a,button");
      for (let j = 0; j < await links.count(); j++) {
        const b = links.nth(j);
        const label = clean((await b.innerText().catch(() => "")) + " " +
          (await b.getAttribute("title").catch(() => "")) + " " +
          (await b.getAttribute("aria-label").catch(() => "")));
        if (/^view$/i.test(label) || /\bview\b/i.test(label)) {
          await b.click();
          return true;
        }
      }
    } catch {}
  }

  // Fallback: procura qualquer elemento View próximo de uma ocorrência do MatchID.
  const views = page.getByText("View", { exact: true });
  for (let i = 0; i < await views.count(); i++) {
    try {
      const v = views.nth(i);
      if (await v.isVisible()) {
        const parent = v.locator("xpath=ancestor::tr[1]");
        if (await parent.count()) {
          const txt = await parent.innerText().catch(() => "");
          if (txt.includes(id)) {
            await v.click();
            return true;
          }
        }
      }
    } catch {}
  }

  throw new Error(`A partida ${id} foi localizada, mas o botão View correspondente não foi encontrado.`);
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
    page.locator(`text=${label}`)
  ];

  for (const c of candidates) {
    try {
      const n = await c.count();
      for (let i = 0; i < n; i++) {
        const el = c.nth(i);
        if (await el.isVisible()) {
          await el.click({ timeout: 1500 });
          await page.waitForTimeout(120);
          return true;
        }
      }
    } catch {}
  }
  return false;
}

async function extractSection(page, section) {
  await clickTab(page, section);
  await page.waitForTimeout(150);
  return await extractTable(page);
}

async function capture(matchId) {
  const p = await getPage();
  await p.bringToFront();

  await searchMatch(p, matchId);

  // Dá tempo apenas para a página de View montar as tabelas.
  await p.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(350);

  const team = await extractSection(p, "Team Data");
  const player = await extractSection(p, "Player Data");

  if (!team.length && !player.length) {
    throw new Error("A página View abriu, mas nenhuma tabela Team Data/Player Data foi capturada.");
  }

  return {
    matchId: String(matchId),
    sourceUrl: p.url(),
    capturedAt: new Date().toISOString(),
    teamData: team,
    playerData: player
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "1.0.6", busy, hasBrowser: !!browser });
});

app.post("/api/capture", async (req, res) => {
  const matchId = String(req.body?.matchId || "").trim();

  if (!/^\d{5,}$/.test(matchId)) {
    return res.status(400).json({ ok: false, error: "Informe um MatchID numérico válido." });
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
  console.log(`Stats Engine 1.0.6 running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  try { await browser?.close(); } catch {}
  process.exit(0);
});
