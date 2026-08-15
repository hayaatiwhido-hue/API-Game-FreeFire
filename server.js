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
      const norm = v => clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const isNumber = v => /^-?\d+(?:[.,]\d+)?$/.test(clean(v));

      const teamCanonical = [
        "Rank", "Position", "Team ID", "Team Name", "Total Score", "Survival Score", "Kill", "Headshot", "Damage", "Booyah"
      ];
      const playerCanonical = [
        "Rank", "Team Position", "Team Name", "UID", "Player Name", "Total Score", "Survival Score", "Kill", "Headshot", "Damage", "Revival", "Rescue"
      ];

      function expandRow(tr) {
        const cells = [...tr.querySelectorAll(":scope > th, :scope > td")];
        const out = [];
        let col = 0;
        for (const cell of cells) {
          while (out[col] !== undefined) col++;
          const text = clean(cell.innerText);
          const cs = Math.max(1, Number(cell.getAttribute("colspan") || 1));
          for (let c = 0; c < cs; c++) out[col + c] = text;
          col += cs;
        }
        return out;
      }

      function looksLikeHeader(row, tr) {
        const raw = row.map(clean).filter(Boolean);
        const vals = raw.map(norm);
        if (!vals.length) return false;

        // IMPORTANTE: uma linha como
        // "1 | 2 | - | TEAM RAY | 0 | 5 | 5" contém palavras como Team Name
        // na tabela original em algumas versões do MatchStats, mas continua
        // sendo uma LINHA DE DADOS. Nunca use dados como cabeçalho.
        const hasNumericData = raw.some(v => isNumber(v) || /^\d+\s*\/\s*\d+$/.test(v));
        if (hasNumericData) return false;

        const words = new Set([
          "rank", "position", "posicao", "teamname", "team", "teamid", "playername", "nickname", "player", "uid",
          "totalscore", "survivalscore", "kill", "kills", "headshot", "headshots", "damage", "revival", "rescue",
          "booyah", "abates", "pontos", "equipes", "jogador"
        ]);
        const hits = vals.filter(v => words.has(v)).length;
        const hasRank = vals.some(v => v === "rank" || v === "position" || v === "posicao");
        const hasIdentity = wantedSection === "Team Data"
          ? vals.some(v => v === "teamname" || v === "team" || v === "teamid")
          : vals.some(v => v === "playername" || v === "nickname" || v === "player" || v === "uid");

        // Se houver <th>, aceitamos somente se a linha não tiver valores numéricos.
        // Sem <th>, exigimos pelo menos 2 nomes de coluna reconhecíveis.
        return (tr.querySelectorAll(":scope > th").length > 0 && hits >= 1) || (hits >= 2 && (hasRank || hasIdentity));
      }

      function canonicalHeader(count) {
        const source = wantedSection === "Team Data" ? teamCanonical : playerCanonical;
        return Array.from({length: count}, (_, i) => source[i] || `Informação ${i + 1}`);
      }

      const tables = [...document.querySelectorAll("table")].filter(t => {
        const r = t.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      let best = null;
      let bestScore = -1;

      for (const table of tables) {
        const trs = [...table.querySelectorAll("tr")];
        if (trs.length < 1) continue;
        const rows = trs.map(expandRow).filter(r => r.some(v => clean(v) !== ""));
        if (!rows.length) continue;

        // Primeiro procura um cabeçalho REAL. Linhas de jogadores/equipes nunca
        // podem virar cabeçalho só porque não existe THEAD no site de origem.
        let headerIndex = -1;
        for (let i = 0; i < Math.min(rows.length, 8); i++) {
          if (looksLikeHeader(rows[i], trs[i])) {
            headerIndex = i;
            break;
          }
        }

        let header;
        let body;
        if (headerIndex >= 0) {
          header = rows[headerIndex].map((v, i) => clean(v) || `Informação ${i + 1}`);
          body = rows.slice(headerIndex + 1);
        } else {
          // O MatchStats em alguns momentos entrega apenas as linhas de dados.
          // Nesse caso o cabeçalho é definido pela estrutura da tabela e TODAS
          // as linhas recebidas continuam sendo dados.
          const count = Math.max(...rows.map(r => r.length));
          header = canonicalHeader(count);
          body = rows;
        }

        body = body.filter(row => row.some(v => clean(v) !== ""));
        if (!header.length || !body.length) continue;

        // Remove linhas de controle/paginação que não representam registro.
        body = body.filter(row => {
          const first = clean(row[0]);
          const text = row.map(clean).join(" ").toLowerCase();
          if (/^(next|previous|prev|pagina|page|mostrar|show)$/i.test(first)) return false;
          if (text === "no data" || text === "no records") return false;
          return true;
        });

        const h = header.map(norm);
        let score = body.length * 5 + header.length * 4;
        if (h.some(x => x === "teamname" || x === "team")) score += wantedSection === "Team Data" ? 50 : 5;
        if (h.some(x => x === "playername" || x === "nickname" || x === "player")) score += wantedSection === "Team Data" ? 0 : 50;
        if (h.includes("uid")) score += wantedSection === "Team Data" ? 0 : 30;
        if (h.includes("rank") || h.includes("position")) score += 25;
        if (h.some(x => ["totalscore","survivalscore","kill","kills","headshot","damage","booyah","abates","pontos"].includes(x))) score += 20;
        if (headerIndex < 0) score += 15; // tabelas sem cabeçalho real ainda são válidas
        if (wantedSection === "Team Data" && h.some(x => ["nickname","playername","uid","player"].includes(x))) score -= 60;
        if (wantedSection !== "Team Data" && h.some(x => ["teamname","team"].includes(x)) && !h.some(x => ["playername","nickname","player","uid"].includes(x))) score -= 30;

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
  // Interval solicitado: 10 ms. refreshCurrentMatch possui um bloqueio
  // interno para impedir duas recargas do MatchStats ao mesmo tempo.
  livePollTimer = setInterval(() => {
    refreshCurrentMatch().catch(() => {});
  }, 10);
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
    // Return the latest server-side snapshot. The background poller checks
    // the official View on a 10 ms interval, with an in-flight guard so
    // refreshes never overlap.
    return res.json({ ok: true, result: lastResult });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Falha na atualização."
    });
  }
});


app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "2.1.2", busy, hasBrowser: !!browser });
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
  console.log(`Stats Engine 2.0.0 running on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  stopLivePolling();
  try { await browser?.close(); } catch {}
  process.exit(0);
});
