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

async function clickTab(page,label){
  const candidates=[page.getByText(label,{exact:true}),page.locator('[role="tab"]').filter({hasText:label}),page.locator('button').filter({hasText:label}),page.locator('a').filter({hasText:label})];
  for(const c of candidates){for(let i=0;i<await c.count();i++){const el=c.nth(i);if(await el.isVisible().catch(()=>false)){await el.click({timeout:1200}).catch(()=>{});return true;}}}
  return false;
}

async function extractSection(page, section) {
  await clickTab(page,section);
  const type=section==='Team Data'?'team':'player';
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
    const matrix=await page.evaluate((wanted)=>{
      const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
      const tables=[...document.querySelectorAll('table')].filter(t=>{const r=t.getBoundingClientRect();return r.width>0&&r.height>0;});
      function rowValues(tr){return [...tr.querySelectorAll(':scope > th, :scope > td')].map(c=>clean(c.innerText));}
      function scoreHeader(values){
        const text=values.join(' | '); let s=0;
        const known=wanted==='Team Data'?/rank|team|equipe|score|survival|kill|damage|headshot|assist|point|id/i:/rank|player|nickname|nick|team|equipe|uid|id|score|survival|kill|damage|headshot|assist|knock|rescue|revive|moving|distance/i;
        for(const v of values){if(!v)continue;if(known.test(v))s+=12;if(/^\d+(?:[.,]\d+)?$/.test(v))s-=20;else s+=2;}
        if(/\brank\b/i.test(text))s+=30;if(wanted==='Team Data'&&/team\s*name|teamname/i.test(text))s+=35;if(wanted==='Player Data'&&/player\s*name|nickname|nick/i.test(text))s+=35;
        return s;
      }
      let best=null,bestScore=-1;
      for(const table of tables){
        const all=[...table.querySelectorAll('tr')]; if(!all.length)continue;
        const thead=[...table.querySelectorAll('thead > tr')];
        let headerRows=thead.length?thead:all.slice(0,Math.min(3,all.length));
        let header=headerRows.map(rowValues).sort((a,b)=>scoreHeader(b)-scoreHeader(a))[0]||[];
        const headerPos=all.findIndex(tr=>JSON.stringify(rowValues(tr))===JSON.stringify(header));
        const body=(thead.length? [...(table.querySelector('tbody')?.querySelectorAll(':scope > tr')||[])]:all.slice(Math.max(0,headerPos)+1))
          .map(rowValues).filter(r=>r.length);
        if(!header.length||!body.length)continue;
        let s=body.length*4+header.length*2;
        const h=header.join(' | ').toLowerCase();
        if(/\brank\b/.test(h))s+=25;
        if(wanted==='Team Data'){if(/team ?name|teamname/.test(h))s+=40;if(/team ?id/.test(h))s+=20;if(/score|survival|damage|kill|headshot/.test(h))s+=25;if(/nickname|uid|player/.test(h))s-=20;}
        else {if(/nickname|player ?name|playername/.test(h))s+=40;if(/uid|player ?id/.test(h))s+=25;if(/team ?name|teamname/.test(h))s+=10;if(/kill|headshot|survival|revival|rescue|damage|moving|distance/.test(h))s+=25;}
        if(header.length>=5)s+=10;
        if(s>bestScore){bestScore=s;best=[header,...body];}
      }
      return best||[];
    },section);
    if(matrix.length>=2)return normalizeMatrix(matrix,type);
    await page.waitForTimeout(50);
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
  if(m.refreshing)return;
  m.refreshing=true;
  try{
    const before=JSON.stringify({team:m.teamData,player:m.playerData});
    const next=await snapshot(m);
    m.teamData=next.teamData;m.playerData=next.playerData;m.capturedAt=next.capturedAt;m.sourceUrl=next.sourceUrl;
    // extractSection alternates MatchStats tabs, which can itself mutate the DOM.
    // Reset the observed version after taking a snapshot to avoid a self-trigger loop.
    try { m.seenVersion = await m.page.evaluate(() => window.__statsVersion || 0); } catch {}
    const after=JSON.stringify({team:m.teamData,player:m.playerData});
    if(before!==after) publish('data', {matchId:m.matchId, ...next, derived:deriveCurrent()});
  }catch(e){m.lastError=e?.message||String(e);}finally{m.refreshing=false;}
}

function startWatcher(m){
  if(m.timer)clearInterval(m.timer);
  m.timer=setInterval(async()=>{
    try{
      const v=await m.page.evaluate(()=>window.__statsVersion||0);
      if(v!==m.seenVersion){m.seenVersion=v;await refreshMatch(m);}
    }catch{}
  },POLL_MS);
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
  const rows=matrixToObjects(matrix,'player'); if(!rows.length)return null;
  const teamMap=new Map();
  for(const p of rows){const team=p['Team Name']||p.Team||'';if(!team)continue;if(!teamMap.has(team))teamMap.set(team,[]);teamMap.get(team).push(p);}
  for(const [team,ps] of teamMap){
    if(ps.length<2)continue;
    const alive=ps.filter(p=>{const s=norm(p.Operation||p.Status||p.State||''); if(/dead|elimin|morto|eliminado/.test(s))return false; if(/alive|vivo|living/.test(s))return true; const kd=num(p['Knock Down']); return kd===0;});
    if(alive.length===0)return {teamName:team,players:ps};
  }
  return null;
}

function deriveCurrent(){
  const cur=currentMatrices();
  const tops={
    teamKills:topFrom(cur.teamData,'team',['Kill','Kills']),
    teamDamage:topFrom(cur.teamData,'team',['Damage']),
    teamHeadshots:topFrom(cur.teamData,'team',['Headshots','Headshot']),
    teamAssist:topFrom(cur.teamData,'team',['Assist','Assists']),
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
app.post('/api/overlays/:key',(req,res)=>{const key=req.params.key;if(!OVERLAYS[key])return res.status(404).json({ok:false,error:'Overlay não encontrada.'});state.overlays[key].enabled=Boolean(req.body?.enabled);publish('overlay-state',{key,enabled:state.overlays[key].enabled});if(key==='ranking'&&state.overlays[key].enabled)publish('ranking',rankingPayload());res.json({ok:true,overlay:state.overlays[key]});});
app.post('/api/overlays/:key/test',(req,res)=>{const key=req.params.key;if(!OVERLAYS[key])return res.status(404).json({ok:false,error:'Overlay não encontrada.'});state.overlays[key].enabled=true;fireOverlay(key,'manual-test');res.json({ok:true,overlay:state.overlays[key]});});
app.get('/api/overlay/:key',(req,res)=>{const key=req.params.key;if(!OVERLAYS[key])return res.status(404).json({ok:false,error:'Overlay não encontrada.'});res.json({ok:true,key,config:OVERLAYS[key],enabled:state.overlays[key].enabled,state:publicState(),data:deriveCurrent()});});
app.get('/api/stream',(req,res)=>{res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders?.();res.write(`data: ${JSON.stringify({type:'state',revision:state.revision,state:publicState(),data:deriveCurrent()})}\n\n`);sseClients.add(res);req.on('close',()=>sseClients.delete(res));});

// After every data update, evaluate automatic TOP triggers.
const originalPublish=publish;
// Keep processDerived in the watcher path by wrapping broadcast calls from refreshMatch.
const _refreshMatch=refreshMatch;
refreshMatch = async function(m){
  await _refreshMatch(m);
  processDerived();
  if(state.overlays.ranking.enabled)publish('ranking',rankingPayload());
};

app.listen(PORT,'0.0.0.0',()=>console.log(`FFWS vMix MultiMatch server running on :${PORT} · poll=${POLL_MS}ms`));
process.on('SIGTERM',async()=>{for(const r of sseClients){try{r.end();}catch{}}for(const m of state.matches.values()){try{if(m.timer)clearInterval(m.timer);await m.page.close();await m.context.close();}catch{}}try{await browser?.close();}catch{}process.exit(0);});
