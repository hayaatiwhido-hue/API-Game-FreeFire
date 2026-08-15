import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;

const MATCHSTATS_BASE = "https://matchstats.us.ffesports.com";
const SEARCH_URL = (matchId) =>
  `${MATCHSTATS_BASE}/match?search=${encodeURIComponent(matchId)}`;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

const state = {
  running: false,
  matchId: null,
  timer: null,
  clients: new Set(),
  consultations: 0,
  changes: 0,
  lastHash: null,
  lastUpdate: null,
  lastError: null,
  data: null
};

function clean(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(href) {
  if (!href) return null;
  try { return new URL(href, MATCHSTATS_BASE).href; }
  catch { return null; }
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function parseTables($, root) {
  const tables = [];
  $(root).find("table").each((index, table) => {
    const rows = [];
    $(table).find("tr").each((_, tr) => {
      const cells = $(tr).find("th,td").map((__, cell) => clean($(cell).text())).get();
      if (cells.length) rows.push(cells);
    });
    if (rows.length) {
      let headers = [];
      let body = rows;

      const first = rows[0];
      const hasTh = $(table).find("tr").first().find("th").length > 0;
      if (hasTh) {
        headers = first;
        body = rows.slice(1);
      }

      tables.push({
        index,
        headers,
        rows: body,
        rowCount: body.length
      });
    }
  });
  return tables;
}

function parseDefinitionLists($, root) {
  const meta = {};
  $(root).find("dt").each((_, dt) => {
    const key = clean($(dt).text());
    const value = clean($(dt).next("dd").text());
    if (key && value) meta[key] = value;
  });
  return meta;
}

function extractViewCandidates($) {
  const candidates = [];

  $("a").each((_, a) => {
    const text = clean($(a).text()).toLowerCase();
    const href = $(a).attr("href");
    const url = absoluteUrl(href);
    if (!url) return;

    const score =
      (text === "view" ? 100 : 0) +
      (text.includes("view") ? 30 : 0) +
      (href?.toLowerCase().includes("view") ? 20 : 0) +
      (href?.toLowerCase().includes("match") ? 10 : 0);

    if (score > 0) candidates.push({ url, text, score });
  });

  // Also inspect forms/buttons that may carry the target in attributes.
  $("form").each((_, form) => {
    const action = absoluteUrl($(form).attr("action"));
    if (action) candidates.push({ url: action, text: "form", score: 5 });
  });

  const seen = new Set();
  return candidates
    .sort((a,b) => b.score - a.score)
    .filter(x => !seen.has(x.url) && seen.add(x.url));
}

function looksLikeMatchPage(tables, html) {
  const text = clean(cheerio.load(html)("body").text()).toLowerCase();
  const signals = [
    "player", "team", "kill", "rank", "position", "points",
    "damage", "match id", "nickname", "uid"
  ];
  const score = signals.filter(s => text.includes(s)).length;
  return tables.length > 0 && score >= 2;
}

function chooseSearchResult($, requestedId) {
  const requested = String(requestedId);

  const rows = [];
  $("table tr").each((_, tr) => {
    const cells = $(tr).find("th,td").map((__, c) => clean($(c).text())).get();
    if (!cells.length) return;

    const links = $(tr).find("a").map((__, a) => ({
      text: clean($(a).text()),
      href: absoluteUrl($(a).attr("href"))
    })).get().filter(x => x.href);

    rows.push({ cells, links });
  });

  // Prefer a row whose first cell equals the requested Match ID.
  for (const row of rows) {
    if (row.cells.some(c => c === requested)) {
      const view = row.links.find(l => l.text.toLowerCase() === "view")
        || row.links.find(l => l.text.toLowerCase().includes("view"));
      if (view) return view.href;
    }
  }

  // Otherwise prefer any explicit View link. This matches the current
  // MatchStats search page, where the result table exposes a View operation.
  const views = [];
  $("a").each((_, a) => {
    const text = clean($(a).text()).toLowerCase();
    const href = absoluteUrl($(a).attr("href"));
    if (href && text.includes("view")) views.push(href);
  });

  return views[0] || null;
}

async function getHtml(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400,
    headers: {
      "User-Agent": "Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
      "Cache-Control": "no-cache"
    }
  });
  return { html: response.data, finalUrl: response.request?.res?.responseUrl || url };
}

async function scrapeMatch(matchId) {
  if (!matchId) throw new Error("Informe um Match ID.");

  const search = await getHtml(SEARCH_URL(matchId));
  const $search = cheerio.load(search.html);

  const searchTables = parseTables($search, "body");
  const viewUrl = chooseSearchResult($search, matchId);

  if (!viewUrl) {
    return {
      found: false,
      matchId: String(matchId),
      source: SEARCH_URL(matchId),
      stage: "search",
      message: "A pesquisa abriu, mas nenhum resultado com link 'View' foi encontrado."
    };
  }

  const detail = await getHtml(viewUrl);
  const $detail = cheerio.load(detail.html);

  const tables = parseTables($detail, "body");
  const meta = parseDefinitionLists($detail, "body");

  const title = clean($detail("title").first().text()) || "MatchStats";
  const headings = unique(
    $detail("h1,h2,h3,h4").map((_, el) => clean($detail(el).text())).get()
  );

  if (!tables.length && !looksLikeMatchPage(tables, detail.html)) {
    return {
      found: true,
      matchId: String(matchId),
      source: viewUrl,
      stage: "detail",
      title,
      headings,
      meta,
      tables: [],
      message: "A página da partida foi aberta, mas nenhum quadro HTML foi encontrado."
    };
  }

  return {
    found: true,
    matchId: String(matchId),
    source: viewUrl,
    stage: "detail",
    capturedAt: new Date().toISOString(),
    title,
    headings,
    meta,
    tables
  };
}

function hashData(data) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
}

function publicState() {
  return {
    running: state.running,
    matchId: state.matchId,
    consultations: state.consultations,
    changes: state.changes,
    lastUpdate: state.lastUpdate,
    lastError: state.lastError,
    data: state.data
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of state.clients) res.write(payload);
}

async function tick() {
  if (!state.running || !state.matchId) return;

  try {
    const data = await scrapeMatch(state.matchId);
    state.consultations++;
    state.lastError = null;
    state.lastUpdate = new Date().toISOString();

    const nextHash = hashData(data);
    if (nextHash !== state.lastHash) {
      state.changes++;
      state.lastHash = nextHash;
      state.data = data;
    } else if (state.data) {
      // Keep the original data but update the capture timestamp.
      state.data = { ...state.data, capturedAt: state.lastUpdate };
    } else {
      state.data = data;
    }
  } catch (error) {
    state.consultations++;
    state.lastError = error?.message || String(error);
    state.lastUpdate = new Date().toISOString();
  }

  broadcast();
}

function stopMonitor() {
  state.running = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  broadcast();
}

function startMonitor(matchId) {
  stopMonitor();
  state.running = true;
  state.matchId = String(matchId);
  state.consultations = 0;
  state.changes = 0;
  state.lastHash = null;
  state.lastUpdate = null;
  state.lastError = null;
  state.data = null;

  tick();
  state.timer = setInterval(tick, 1000);
}

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    engine: "Stats Engine V3",
    matchstats: MATCHSTATS_BASE,
    intervalMs: 1000
  });
});

app.get("/api/state", (_, res) => res.json(publicState()));

app.post("/api/monitor/start", (req, res) => {
  const matchId = String(req.body?.matchId ?? "").trim();
  if (!matchId) return res.status(400).json({ error: "Match ID obrigatório." });
  startMonitor(matchId);
  res.json({ ok: true, state: publicState() });
});

app.post("/api/monitor/stop", (_, res) => {
  stopMonitor();
  res.json({ ok: true, state: publicState() });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  state.clients.add(res);
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    state.clients.delete(res);
  });
});

app.get("/api/match/:id", async (req, res) => {
  try {
    const data = await scrapeMatch(req.params.id);
    res.json(data);
  } catch (error) {
    res.status(502).json({
      found: false,
      error: error?.message || String(error)
    });
  }
});

app.get("*", (_, res) => res.sendFile("index.html", { root: "." }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Stats Engine V3 listening on 0.0.0.0:${PORT}`);
});
