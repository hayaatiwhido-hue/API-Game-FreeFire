const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 10000;
const TARGET = 'https://matchstats.us.ffesports.com/match';
const POLL_MS = Math.max(1, Number(process.env.POLL_MS || 1));
const MAX_MATCHES = Math.max(1, Number(process.env.MAX_MATCHES || 8));

app.use(express.json({ limit: '4mb' }));
app.use(express.static(__dirname));

const TEAM_HEADERS = [
  'Match Rank','Team ID','Team Name','Survival Score','Kill','Total Score','BOOYAH!',
  'Damage','On Target','Headshots','Headshot Kill Rate','Headshot Accuracy Rate','Survival Time','Revival'
];
const PLAYER_HEADERS = [
  'Match Rank','Team Name','Player ID','Player Name','Kill','Damage','Assist','On Target',
  'Moving Distance','Headshots','Headshot Kill Rate','Headshot Accuracy Rate','Revival','Revival Members',
  'Knock Down','Rescue Members','Survival Time','Maximum kill distance','Operation'
];

const OVERLAYS = {
  ranking: { label:'Ranking da Queda', persistent:true },
  teamKills: { label:'Equipe com mais Abates', persistent:false },
  teamDamage: { label:'Top Dano · Equipe', persistent:false },
  teamHeadshots: { label:'Headshots · Equipe', persistent:false },
  teamAssist: { label:'Top Assist. · Equipe', persistent:false },
  teamRevival: { label:'Top Revival · Equipe', persistent:false },
  teamEliminated: { label:'Equipe Eliminada', persistent:false },
  playerKills: { label:'Player com mais Eliminações', persistent:false },
  playerDamage: { label:'Player com maior Dano', persistent:false },
  playerAssist: { label:'Player com mais Assistências', persistent:false },
  playerMovingDistance: { label:'Player que mais andou no Mapa', persistent:false },
  playerHeadshots: { label:'Player com mais Headshots', persistent:false },
  playerKnockDown: { label:'Player mais derrubado', persistent:false },
  playerRescueMembers: { label:'Player que mais reviveu aliados', persistent:false },
  playerMaximumKillDistance: { label:'Abate mais distante', persistent:false }
};

const state = {
  mode: 'single',
  selectedMatchId: null,
  matches: new Map(),
  overlays: Object.fromEntries(Object.keys(OVERLAYS).map(k => [k, { enabled:false, seq:0, event:null }])),
  revision: 0
};
const sseClients = new Set();
let browser = null;
let busy = false;

const clean = v => String(v ?? '').replace(/\s+/g,' ').trim();
const norm = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');
const num = v => {
  const s = clean(v).replace(/%/g,'').replace(/\s/g,'').replace(',','.');
  const n = Number(s.replace(/[^0-9+\-.]/g,''));
  return Number.isFinite(n) ? n : 0;
};
const isNumericLike = v => /^[-+]?\d+(?:[.,]\d+)?$/.test(clean(v));
const keyFor = (name) => norm(name);

function headerIndex(header, ...aliases) {
  const aliasesN = aliases.map(norm);
  return header.findIndex(h => aliasesN.some(a => norm(h) === a || norm(h).includes(a)));
}
function value(row, header, ...aliases) {
  const i = headerIndex(header, ...aliases);
  return i >= 0 ? clean(row?.[i]) : '';
}
function setAt(row, header, aliases, v) {
  const i = headerIndex(header, ...aliases);
  if (i >= 0) row[i] = String(v);
}
function canonicalHeader(raw, fallback, type) {
  const n = norm(raw);
  const map = {
    matchrank:'Match Rank', rank:'Match Rank', position:'Match Rank', posicao:'Match Rank',
    teamid:'Team ID', teamname:'Team Name', team:'Team Name',
    playerid:'Player ID', uid:'UID', playername:'Player Name', nickname:'Player Name', player:'Player Name',
    survivalscore:'Survival Score', survivalscore:'Survival Score', survivalpoints:'Survival Score',
    kill:'Kill', kills:'Kill', abates:'Kill', eliminacoes:'Kill',
    totalscore:'Total Score', totalpoints:'Total Score', score:'Total Score', pontos:'Total Score',
    booyah:'BOOYAH!', booyahscore:'BOOYAH!', damage:'Damage', dano:'Damage',
    assist:'Assist', assists:'Assist', assistencias:'Assist', 'on-target':'On Target', ontarget:'On Target',
    movingdistance:'Moving Distance', distance:'Moving Distance',
    headshot:'Headshots', headshots:'Headshots',
    headshotkillrate:'Headshot Kill Rate', headshotaccuracyrate:'Headshot Accuracy Rate', accuracy:'Headshot Accuracy Rate',
    survivaltime:'Survival Time', revival:'Revival', revives:'Revival',
    revivalmembers:'Revival Members', knockdown:'Knock Down', knockdowns:'Knock Down',
    rescue:'Rescue', rescues:'Rescue', rescumembers:'Rescue Members', rescuemembers:'Rescue Members',
    maximumkilldistance:'Maximum kill distance', maxkilldistance:'Maximum kill distance', operation:'Operation'
  };
  return map[n] || clean(raw) || fallback || (type === 'team' ? 'Team Data' : 'Player Data');
}

function expandRows(rows) {
  const grid = [];
  for (let r=0;r<rows.length;r++) {
    if (!grid[r]) grid[r]=[];
    let col=0;
    for (const cell of rows[r].querySelectorAll(':scope > th, :scope > td')) {
      while (grid[r][col] !== undefined) col++;
      const text=clean(cell.innerText);
      const rs=Math.max(1,Number(cell.getAttribute('rowspan')||1));
      const cs=Math.max(1,Number(cell.getAttribute('colspan')||1));
      for(let rr=0;rr<rs;rr++){
        if(!grid[r+rr]) grid[r+rr]=[];
        for(let cc=0;cc<cs;cc++) grid[r+rr][col+cc]=text;
      }
      col+=cs;
    }
  }
  return grid;
}

function normalizeMatrix(matrix, type) {
  if (!Array.isArray(matrix) || matrix.length < 2) return [];
  const defaults = type==='team' ? TEAM_HEADERS : PLAYER_HEADERS;
  let header = (matrix[0]||[]).map((v,i)=>canonicalHeader(v,defaults[i],type));
  const body = matrix.slice(1).map(r => {
    const out = Array.from({length:Math.max(header.length,r?.length||0)},(_,i)=>clean(r?.[i]||''));
    if (out.length < header.length) while(out.length<header.length) out.push('');
    return out.slice(0,header.length);
  });

  // If MatchStats gave the headers in a grouped/merged form, keep the DOM order and
  // repair only the labels. This prevents the old "TEAM NAME one row above/below" shift.
  const looksData = header.every((h,i)=> !h || isNumericLike(h) || /^\d+\s*\/\s*\d+$/.test(h));
  if (looksData) {
    header = defaults.slice(0, Math.max(header.length, defaults.length));
    while (header.length < body[0]?.length) header.push(`Informação ${header.length+1}`);
  }
  return [header, ...body];
}

async function getBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({
    headless:true,
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-blink-features=AutomationControlled']
  });
  return browser;
}

async function newMatchPage(matchId) {
  const b=await getBrowser();
  const context=await b.newContext({viewport:{width:1440,height:1000},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'});
  const page=await context.newPage();
  page.setDefaultTimeout(7000);
  return {context,page,matchId:String(matchId)};
}

async function searchMatch(page, matchId) {
  const id=String(matchId).trim();
  await page.goto(TARGET,{waitUntil:'domcontentloaded',timeout:18000});
  const selectors=['input[placeholder*="Match ID" i]','input[placeholder*="Match" i]','input[name*="match" i]','input[type="search"]','input[type="text"]'];
  let input=null;
  for(const sel of selectors){
    const loc=page.locator(sel);
    for(let i=0;i<await loc.count();i++){
      const x=loc.nth(i);
      if(await x.isVisible().catch(()=>false)){input=x;break;}
    }
    if(input)break;
  }
  if(!input)throw new Error('Campo de pesquisa do MatchStats não foi localizado.');
  await input.fill(id); await input.press('Enter').catch(()=>{}); await page.waitForTimeout(80);
  const rowDeadline=Date.now()+6500;
  while(Date.now()<rowDeadline){
    const rows=page.locator('tr');
    for(let i=0;i<await rows.count();i++){
      const row=rows.nth(i); if(!(await row.isVisible().catch(()=>false)))continue;
      const txt=await row.innerText().catch(()=>'' ); if(!txt.includes(id))continue;
      const controls=row.locator('a,button');
      for(let j=0;j<await controls.count();j++){
        const b=controls.nth(j); const label=clean((await b.innerText().catch(()=>''))+' '+(await b.getAttribute('title').catch(()=>''))+' '+(await b.getAttribute('aria-label').catch(()=>'')));
        if(/\bview\b/i.test(label)){await b.click({timeout:1500});return;}
      }
    }
    await page.waitForTimeout(100);
  }
  const views=page.getByText('View',{exact:true});
  for(let i=0;i<await views.count();i++){
    const v=views.nth(i); if(!(await v.isVisible().catch(()=>false)))continue;
    const parent=v.locator('xpath=ancestor::tr[1]');
    if(await parent.count() && (await parent.innerText().catch(()=>'' )).includes(id)){await v.click();return;}
  }
  throw new Error(`O MatchID ${id} não apareceu nos resultados do MatchStats.`);
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

      // ORDEM EXATA usada pelo MatchStats nas telas de referência.
      // Não existe uma coluna artificial "Position"/"Team Position" entre Rank e Team ID.
      const teamCanonical = [
        "Match Rank", "Team ID", "Team Name", "Survival Score", "Kill", "Total Score", "BOOYAH!",
        "Damage", "On Target", "Headshots", "Headshot Kill Rate", "Headshot Accuracy Rate", "Survival Time", "Revival"
      ];
      const playerCanonical = [
        "Match Rank", "Team Name", "Player ID", "Player Name", "Kill", "Damage", "Assist", "On Target",
        "Moving Distance", "Headshots", "Headshot Kill Rate", "Headshot Accuracy Rate", "Revival", "Revival Members",
        "Knock Down", "Rescue Members", "Survival Time", "Maximum kill distance", "Operation"
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

        // Alinha os DADOS ao mesmo campo do cabeçalho. O MatchStats pode
        // entregar a tabela com a ordem visual correta, mas em algumas
        // atualizações o DOM inclui/omite uma coluna auxiliar. Se usarmos
        // apenas row[index], Team Name pode acabar embaixo de Team ID.
        // Quando existe um cabeçalho real, fazemos o mapeamento pelo nome
        // da coluna e depois reconstruímos cada linha na ordem canônica.
        const canonical = wantedSection === "Team Data" ? teamCanonical : playerCanonical;
        const alias = {
          matchrank:"Match Rank", rank:"Match Rank", position:"Match Rank", posicao:"Match Rank",
          teamid:"Team ID", teamname:"Team Name", team:"Team Name",
          survivalscore:"Survival Score", survival:"Survival Score",
          kill:"Kill", kills:"Kill", abates:"Kill",
          totalscore:"Total Score", score:"Total Score", pontos:"Total Score",
          booyah:"BOOYAH!", booyahscore:"BOOYAH!",
          damage:"Damage", dano:"Damage", ontarget:"On Target",
          headshot:"Headshots", headshots:"Headshots",
          headshotkillrate:"Headshot Kill Rate",
          headshotaccuracyrate:"Headshot Accuracy Rate", accuracy:"Headshot Accuracy Rate",
          survivaltime:"Survival Time", revival:"Revival", revives:"Revival",
          playerid:"Player ID", uid:"Player ID", playername:"Player Name", nickname:"Player Name", player:"Player Name", jogador:"Player Name",
          assist:"Assist", assists:"Assist", movingdistance:"Moving Distance",
          revivalmembers:"Revival Members", knockdown:"Knock Down", knockdowns:"Knock Down",
          rescue:"Rescue Members", rescues:"Rescue Members", rescuemembers:"Rescue Members",
          maximumkilldistance:"Maximum kill distance", operation:"Operation"
        };
        const sourceToCanonical = header.map(h => alias[norm(h)] || clean(h));
        const canonicalIndex = new Map(canonical.map((h,i)=>[norm(h),i]));
        const hasUsefulHeaderMapping = header.some(h => canonicalIndex.has(norm(alias[norm(h)] || h)));
        if (hasUsefulHeaderMapping) {
          body = body.map(row => {
            const out = Array(canonical.length).fill("");
            sourceToCanonical.forEach((name, srcIdx) => {
              const dst = canonicalIndex.get(norm(name));
              if (dst !== undefined && out[dst] === "") out[dst] = row[srcIdx] ?? "";
            });
            return out;
          });
          header = canonical.slice();
        } else {
          // Sem cabeçalho real, a própria tabela é considerada já na ordem
          // oficial e somente é limitada ao número correto de colunas.
          body = body.map(row => canonical.map((_,i) => row[i] ?? ""));
          header = canonical.slice();
        }

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

async function snapshot(match) {
  const team=await extractSection(match.page,'Team Data');
  const player=await extractSection(match.page,'Player Data');
  if(team.length<2&&player.length<2)throw new Error('A página View abriu, mas nenhuma tabela Team Data/Player Data foi capturada.');
  return {matchId:match.matchId,sourceUrl:match.page.url(),capturedAt:new Date().toISOString(),teamData:team.length?team:match.teamData||[],playerData:player.length?player:match.playerData||[]};
}

async function installObserver(match){
  await match.page.evaluate(()=>{
    window.__statsVersion=0; window.__statsObserver?.disconnect();
    const bump=()=>window.__statsVersion++;
    const observer=new MutationObserver(bump); observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:false}); window.__statsObserver=observer;
  });
}

function broadcast(payload){
  const data=`data: ${JSON.stringify(payload)}\n\n`;
  for(const res of [...sseClients]){try{res.write(data);}catch{sseClients.delete(res);}}
}
function publish(type,data){state.revision++;broadcast({type,revision:state.revision,data});}

async function refreshMatch(m){
  if(m.refreshing)return false;
  m.refreshing=true;
  try{
    const before=JSON.stringify({team:m.teamData,player:m.playerData});
    const next=await snapshot(m);
    m.teamData=next.teamData;m.playerData=next.playerData;m.capturedAt=next.capturedAt;m.sourceUrl=next.sourceUrl;
    try { m.seenVersion = await m.page.evaluate(() => window.__statsVersion || 0); } catch {}
    const after=JSON.stringify({team:m.teamData,player:m.playerData});
    const changed=before!==after;
    if(changed) publish('data', {matchId:m.matchId, ...next, derived:deriveCurrent()});
    return changed;
  }catch(e){m.lastError=e?.message||String(e);return false;}finally{m.refreshing=false;}
}

function startWatcher(m){
  if(m.timer)clearInterval(m.timer);
  // O ciclo é programado em 1 ms. A proteção `m.refreshing` impede
  // que uma leitura nova comece antes da anterior terminar. Assim,
  // o servidor tenta buscar a atualização no menor intervalo possível
  // sem empilhar centenas de capturas concorrentes.
  m.timer=setInterval(()=>{ refreshMatch(m).catch(()=>{}); },POLL_MS);
}

async function addMatch(matchId){
  const id=String(matchId).trim();
  if(!/^\d+$/.test(id))throw new Error('O MatchID deve conter apenas números.');
  if(state.matches.has(id))return state.matches.get(id);
  if(state.matches.size>=MAX_MATCHES)throw new Error(`Limite de ${MAX_MATCHES} quedas atingido.`);
  const m=await newMatchPage(id);
  await searchMatch(m.page,id); await m.page.waitForLoadState('domcontentloaded',{timeout:4000}).catch(()=>{}); await m.page.waitForTimeout(80);
  const first=await snapshot(m); Object.assign(m,first,{teamData:first.teamData,playerData:first.playerData,refreshing:false,seenVersion:-1,timer:null,lastError:null});
  await installObserver(m); state.matches.set(id,m); if(!state.selectedMatchId)state.selectedMatchId=id; startWatcher(m);
  publish('matches',{matches:listMatches(),state:publicState()}); publish('data',{matchId:id,...first,derived:deriveCurrent()});
  return m;
}

async function removeMatch(id){
  const m=state.matches.get(id); if(!m)return;
  if(m.timer)clearInterval(m.timer); try{await m.page.close();await m.context.close();}catch{}
  state.matches.delete(id); if(state.selectedMatchId===id)state.selectedMatchId=state.matches.keys().next().value||null;
  publish('matches',{matches:listMatches(),state:publicState()}); publish('data',{derived:deriveCurrent()});
}

function listMatches(){return [...state.matches.values()].map(m=>({matchId:m.matchId,capturedAt:m.capturedAt,sourceUrl:m.sourceUrl,lastError:m.lastError,teams:Math.max(0,(m.teamData?.length||0)-1),players:Math.max(0,(m.playerData?.length||0)-1)}));}
function publicState(){return {mode:state.mode,selectedMatchId:state.selectedMatchId,overlays:state.overlays,revision:state.revision,pollMs:POLL_MS,matches:listMatches()};}

function matrixToObjects(matrix,type){
  if(!Array.isArray(matrix)||matrix.length<1)return [];
  const header=matrix[0]||[]; return matrix.slice(1).filter(r=>r?.some(v=>clean(v)!=='')).map(r=>Object.fromEntries(header.map((h,i)=>[h,clean(r[i])])));
}
function objectsToMatrix(header,objects){return [header,...objects.map(o=>header.map(h=>o[h]??''))];}

function aggregateMatrices(matrices,type){
  if(!matrices.length)return [];
  const header=type==='team'?TEAM_HEADERS.slice():PLAYER_HEADERS.slice();
  const objects= new Map();
  const identity= type==='team' ? ['Team ID','Team Name'] : ['Player ID','Player Name','Team Name'];
  const numericFields = type==='team'
    ? ['Survival Score','Kill','Total Score','Damage','On Target','Headshots','Revival']
    : ['Kill','Damage','Assist','On Target','Moving Distance','Headshots','Revival','Revival Members','Knock Down','Rescue Members','Survival Time'];
  for(const matrix of matrices){
    const objs=matrixToObjects(matrix,type);
    for(const o of objs){
      const id=identity.map(k=>norm(o[k])).join('|'); if(!id.replace(/\|/g,''))continue;
      if(!objects.has(id))objects.set(id,{...o});
      const acc=objects.get(id);
      for(const f of numericFields)acc[f]=num(acc[f])+num(o[f]);
      if(type==='player')acc['Maximum kill distance']=Math.max(num(acc['Maximum kill distance']),num(o['Maximum kill distance']));
      else acc['BOOYAH!']=Math.max(num(acc['BOOYAH!']),num(o['BOOYAH!']));
    }
  }
  const out=[...objects.values()];
  for(const o of out){
    if(type==='team'){
      o['Headshot Kill Rate']=num(o.Kill)?((num(o.Headshots)/num(o.Kill))*100).toFixed(2)+'%':'';
      o['Headshot Accuracy Rate']=o['Headshot Accuracy Rate']||'';
    } else {
      o['Headshot Kill Rate']=num(o.Kill)?((num(o.Headshots)/num(o.Kill))*100).toFixed(2)+'%':'';
      o['Headshot Accuracy Rate']=o['Headshot Accuracy Rate']||'';
    }
  }
  out.sort((a,b)=>num(b['Total Score'])-num(a['Total Score'])||num(b.Kill)-num(a.Kill)||num(b.Damage)-num(a.Damage));
  out.forEach((o,i)=>o['Match Rank']=String(i+1));
  return objectsToMatrix(header,out);
}

function currentMatrices(){
  if(state.mode==='single'){
    const m=state.matches.get(state.selectedMatchId); return {teamData:m?.teamData||[],playerData:m?.playerData||[],matchId:m?.matchId||null};
  }
  const teams=[...state.matches.values()].map(m=>m.teamData).filter(x=>x?.length>=2);
  const players=[...state.matches.values()].map(m=>m.playerData).filter(x=>x?.length>=2);
  return {teamData:aggregateMatrices(teams,'team'),playerData:aggregateMatrices(players,'player'),matchId:'ALL'};
}

function topFrom(matrix,type,aliases){
  if(!matrix?.length)return null; const header=matrix[0]; const rows=matrix.slice(1).filter(r=>r?.some(v=>clean(v)!==''));
  const field=aliases.find(a=>headerIndex(header,a)>=0); if(!field)return null;
  const idx=headerIndex(header,field); const sorted=[...rows].sort((a,b)=>num(b[idx])-num(a[idx])); const row=sorted[0]; if(!row)return null;
  const out={type,field,value:row[idx],rank:value(row,header,'Match Rank','Rank'),teamName:value(row,header,'Team Name'),playerName:value(row,header,'Player Name'),teamId:value(row,header,'Team ID'),playerId:value(row,header,'Player ID','UID'),row,header};
  return out;
}

function detectEliminated(matrix){
  if(!Array.isArray(matrix)||matrix.length<2)return null;
  const header=matrix[0]||[];
  const statusAliases=['Status','State','Player Status','Operation'];
  const statusIdx=header.findIndex(h=>statusAliases.some(a=>norm(h)===norm(a)));
  if(statusIdx<0)return null;
  const teamIdx=headerIndex(header,'Team Name','Team');
  if(teamIdx<0)return null;
  const rows=matrix.slice(1).filter(r=>r?.some(v=>clean(v)!==''));
  const byTeam=new Map();
  for(const row of rows){
    const team=clean(row[teamIdx]); if(!team)continue;
    if(!byTeam.has(team))byTeam.set(team,[]);
    byTeam.get(team).push(row);
  }
  for(const [team,players] of byTeam){
    if(players.length<2)continue;
    const states=players.map(r=>norm(r[statusIdx]));
    const explicit=states.filter(s=>/dead|elimin|morto|eliminado|spectator|out/.test(s));
    if(explicit.length===players.length){
      const rank=clean(players[0]?.[headerIndex(header,'Match Rank','Rank')]||'');
      return {teamName:team,rank,players:players.map(r=>Object.fromEntries(header.map((h,i)=>[h,clean(r[i])])))};
    }
  }
  return null;
}

function deriveCurrent(){
  const cur=currentMatrices();
  const teamAssistTop=(()=>{
    const ph=cur.playerData?.[0]||[];
    const rows=cur.playerData?.slice(1)||[];
    const teamNameIdx=headerIndex(ph,'Team Name','Team');
    const assistIdx=headerIndex(ph,'Assist','Assists');
    if(teamNameIdx<0||assistIdx<0)return null;
    const sums=new Map();
    for(const r of rows){
      const team=clean(r[teamNameIdx]); if(!team)continue;
      sums.set(team,(sums.get(team)||0)+num(r[assistIdx]));
    }
    let best=null;
    for(const [team,v] of sums){if(!best||v>best.value)best={type:'team',field:'Assist',value:String(v),teamName:team,row:null,header:ph};}
    return best;
  })();
  const tops={
    teamKills:topFrom(cur.teamData,'team',['Kill','Kills']),
    teamDamage:topFrom(cur.teamData,'team',['Damage']),
    teamHeadshots:topFrom(cur.teamData,'team',['Headshots','Headshot']),
    teamAssist:topFrom(cur.teamData,'team',['Assist','Assists'])||teamAssistTop,
    teamRevival:topFrom(cur.teamData,'team',['Revival','Revives']),
    playerKills:topFrom(cur.playerData,'player',['Kill','Kills']),
    playerDamage:topFrom(cur.playerData,'player',['Damage']),
    playerAssist:topFrom(cur.playerData,'player',['Assist','Assists']),
    playerMovingDistance:topFrom(cur.playerData,'player',['Moving Distance']),
    playerHeadshots:topFrom(cur.playerData,'player',['Headshots','Headshot']),
    playerKnockDown:topFrom(cur.playerData,'player',['Knock Down','Knockdowns']),
    playerRescueMembers:topFrom(cur.playerData,'player',['Rescue Members','Rescue']),
    playerMaximumKillDistance:topFrom(cur.playerData,'player',['Maximum kill distance','Maximum Kill Distance'])
  };
  tops.teamEliminated=detectEliminated(cur.playerData);
  return { ...cur, tops };
}

function rankingPayload(){
  const cur=currentMatrices();
  return {matchId:cur.matchId,teamData:cur.teamData,mode:state.mode};
}
function fireOverlay(key,reason='change'){
  const o=state.overlays[key]; if(!o?.enabled)return;
  o.seq++; o.event={seq:o.seq,reason,at:Date.now(),data:deriveCurrent().tops[key]||null};
  publish('overlay',{key,overlay:o,data:deriveCurrent().tops[key]||null});
}

function compareSignature(top){
  if(!top)return '';
  return JSON.stringify({value:top.value,team:top.teamName,player:top.playerName,rank:top.rank});
}
const lastTopSignature={};
function processDerived(){
  const tops=deriveCurrent().tops;
  for(const key of Object.keys(tops)){
    const sig=compareSignature(tops[key]);
    if(lastTopSignature[key]===undefined){lastTopSignature[key]=sig;continue;}
    if(sig!==lastTopSignature[key]){lastTopSignature[key]=sig;fireOverlay(key,'leader-change');}
  }
}

app.get('/api/health',(req,res)=>res.json({ok:true,version:'2.0.0-multimatch',pollMs:POLL_MS,busy,matches:state.matches.size}));
app.get('/api/state',(req,res)=>res.json({ok:true,state:publicState(),data:deriveCurrent()}));
app.get('/api/matches',(req,res)=>res.json({ok:true,matches:listMatches()}));
app.post('/api/matches',async(req,res)=>{
  if(busy)return res.status(409).json({ok:false,error:'Outra captura está em andamento.'});
  const id=String(req.body?.matchId||'').trim(); if(!/^\d+$/.test(id))return res.status(400).json({ok:false,error:'MatchID inválido.'});
  busy=true;try{const m=await addMatch(id);res.json({ok:true,match:{matchId:m.matchId,capturedAt:m.capturedAt},state:publicState(),data:deriveCurrent()});}catch(e){res.status(500).json({ok:false,error:e?.message||'Falha ao adicionar queda.'});}finally{busy=false;}
});
app.delete('/api/matches/:id',async(req,res)=>{await removeMatch(String(req.params.id));res.json({ok:true,state:publicState(),data:deriveCurrent()});});
app.post('/api/view-mode',(req,res)=>{const mode=req.body?.mode==='all'?'all':'single';state.mode=mode;if(mode==='single'&&!state.selectedMatchId)state.selectedMatchId=state.matches.keys().next().value||null;processDerived();publish('state',publicState());res.json({ok:true,state:publicState(),data:deriveCurrent()});});
app.post('/api/select-match',(req,res)=>{const id=String(req.body?.matchId||'');if(!state.matches.has(id))return res.status(404).json({ok:false,error:'Queda não encontrada.'});state.selectedMatchId=id;state.mode='single';processDerived();publish('state',publicState());res.json({ok:true,state:publicState(),data:deriveCurrent()});});
app.post('/api/overlays/:key',(req,res)=>{const key=req.params.key;if(!OVERLAYS[key])return res.status(404).json({ok:false,error:'Overlay não encontrada.'});state.overlays[key].enabled=Boolean(req.body?.enabled);publish('overlay-state',{key,enabled:state.overlays[key].enabled,data:deriveCurrent(),ranking:key==='ranking'?rankingPayload():undefined});if(key==='ranking'&&state.overlays[key].enabled)publish('ranking',rankingPayload());res.json({ok:true,overlay:state.overlays[key]});});
app.post('/api/overlays/:key/test',(req,res)=>{const key=req.params.key;if(!OVERLAYS[key])return res.status(404).json({ok:false,error:'Overlay não encontrada.'});state.overlays[key].enabled=true;fireOverlay(key,'manual-test');res.json({ok:true,overlay:state.overlays[key]});});
app.get('/api/overlay/:key',(req,res)=>{const key=req.params.key;if(!OVERLAYS[key])return res.status(404).json({ok:false,error:'Overlay não encontrada.'});res.json({ok:true,key,config:OVERLAYS[key],enabled:state.overlays[key].enabled,state:publicState(),data:deriveCurrent()});});
app.get('/api/stream',(req,res)=>{res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders?.();res.write(`data: ${JSON.stringify({type:'state',revision:state.revision,state:publicState(),data:deriveCurrent()})}\n\n`);sseClients.add(res);req.on('close',()=>sseClients.delete(res));});

// After every data update, evaluate automatic TOP triggers.
const originalPublish=publish;
// Keep processDerived in the watcher path by wrapping broadcast calls from refreshMatch.
const _refreshMatch=refreshMatch;
refreshMatch = async function(m){
  const changed=await _refreshMatch(m);
  if(changed){
    processDerived();
    if(state.overlays.ranking.enabled)publish('ranking',rankingPayload());
  }
  return changed;
};

app.listen(PORT,'0.0.0.0',()=>console.log(`FFWS vMix MultiMatch server running on :${PORT} · poll=${POLL_MS}ms`));
process.on('SIGTERM',async()=>{for(const r of sseClients){try{r.end();}catch{}}for(const m of state.matches.values()){try{if(m.timer)clearInterval(m.timer);await m.page.close();await m.context.close();}catch{}}try{await browser?.close();}catch{}process.exit(0);});
