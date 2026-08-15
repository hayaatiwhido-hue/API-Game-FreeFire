import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = process.env.PORT || 10000;
const MATCHSTATS_URL = process.env.MATCHSTATS_URL || 'https://matchstats.us.ffesports.com/match';
app.use(express.json({limit:'1mb'}));
app.use(express.static('.'));
app.get('/', (req,res)=>res.sendFile(new URL('./index.html', import.meta.url).pathname));

let browserPromise;
function getBrowser(){
  if(!browserPromise) browserPromise = chromium.launch({headless:true});
  return browserPromise;
}

const norm = v => String(v ?? '').replace(/\\s+/g,' ').trim();
const normId = v => String(v ?? '').replace(/\\D/g,'');

async function clickViewForMatch(page, matchId){
  const target = normId(matchId);
  await page.goto(MATCHSTATS_URL, {waitUntil:'domcontentloaded', timeout:60000});
  await page.waitForTimeout(1200);

  const frames = () => page.frames();
  // Find the main search input by placeholder/name/nearby text.
  let input = null;
  for(const f of frames()){
    const candidates = f.locator('input');
    const n = await candidates.count().catch(()=>0);
    for(let i=0;i<n;i++){
      const el=candidates.nth(i);
      const meta = await el.evaluate(e=>({ph:e.placeholder||'',name:e.name||'',type:e.type||'',aria:e.getAttribute('aria-label')||''})).catch(()=>({}));
      const s=JSON.stringify(meta).toLowerCase();
      if(s.includes('match') || s.includes('name') || meta.type==='text' || meta.type==='search') { input=el; break; }
    }
    if(input) break;
  }
  if(input){
    await input.fill(target);
    await input.press('Enter').catch(()=>{});
    await page.waitForTimeout(1200);
    // Some Angular inputs only react to input/change.
    await input.evaluate(e=>{e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}).catch(()=>{});
    await page.waitForTimeout(1000);
  }

  // Look for the ID in text, hrefs, data attributes, row HTML, and then click a View control in its row.
  for(let pass=0; pass<4; pass++){
    for(const f of frames()){
      const rows = f.locator('tr');
      const count = await rows.count().catch(()=>0);
      for(let i=0;i<count;i++){
        const row=rows.nth(i);
        const html=await row.evaluate(e=>e.outerHTML).catch(()=> '');
        if(normId(html).includes(target)){
          const view=row.getByText(/^View$/i).first();
          if(await view.count().catch(()=>0)) { await view.click({force:true}); return; }
          const buttons=row.locator('button,a,[role="button"]');
          const bn=await buttons.count().catch(()=>0);
          for(let j=0;j<bn;j++){
            const b=buttons.nth(j); const t=norm(await b.innerText().catch(()=>''));
            const h=await b.getAttribute('href').catch(()=>null);
            if(/^view$/i.test(t) || /view/i.test(h||'')){ await b.click({force:true}); return; }
          }
        }
      }
      const links=f.locator('a'); const ln=await links.count().catch(()=>0);
      for(let i=0;i<ln;i++){
        const a=links.nth(i); const h=await a.getAttribute('href').catch(()=>null); const txt=norm(await a.innerText().catch(()=>''));
        if(normId(h||'').includes(target) && /view/i.test(txt+' '+(h||''))){await a.click({force:true}); return;}
      }
    }
    // Pagination fallback: click next controls if available and not disabled.
    let advanced=false;
    for(const f of frames()){
      const controls=f.locator('button,a,[role="button"]'); const n=await controls.count().catch(()=>0);
      for(let i=0;i<n;i++){
        const c=controls.nth(i); const txt=norm(await c.innerText().catch(()=>'')); const aria=await c.getAttribute('aria-label').catch(()=>null); const dis=await c.isDisabled().catch(()=>false);
        if(dis) continue;
        if(/^(next|>|›|»)$/i.test(txt) || /next/i.test(aria||'')) { await c.click({force:true}).catch(()=>{}); await page.waitForTimeout(700); advanced=true; break; }
      }
      if(advanced) break;
    }
    if(!advanced) break;
  }
  throw new Error(`MatchID ${target} foi localizado na página, mas o botão View não pôde ser acionado. Estrutura do MatchStats pode ter mudado.`);
}

async function extractTables(page){
  return await page.evaluate(() => {
    const clean=s=>String(s??'').replace(/\\s+/g,' ').trim();
    const tables=[...document.querySelectorAll('table')];
    return tables.map((table,index)=>{
      const rows=[...table.querySelectorAll('tr')];
      if(!rows.length) return null;
      let headers=[...rows[0].querySelectorAll('th,td')].map(x=>clean(x.innerText));
      const body=rows.slice(1).map(r=>[...r.querySelectorAll('th,td')].map(x=>clean(x.innerText))).filter(r=>r.length);
      return {index, caption:clean(table.querySelector('caption')?.innerText), headers, rows:body};
    }).filter(Boolean);
  });
}

function classify(tables){
  const out={teamData:[],playerData:[]};
  for(const t of tables){
    const blob=(t.caption+' '+t.headers.join(' ')).toLowerCase();
    if(blob.includes('player')) out.playerData.push(t);
    else if(blob.includes('team') || blob.includes('match rank') || blob.includes('survival score')) out.teamData.push(t);
  }
  if(!out.teamData.length) out.teamData=tables.filter(t=>/team id|team name|survival score|match rank/i.test(t.headers.join(' ')));
  if(!out.playerData.length) out.playerData=tables.filter(t=>/player id|player name|nickname|kills|damage|headshot/i.test(t.headers.join(' ')) && !out.teamData.includes(t));
  return out;
}

app.post('/api/capture', async (req,res)=>{
  const matchId=normId(req.body?.matchId);
  if(!matchId) return res.status(400).json({ok:false,error:'Informe um MatchID válido.'});
  const started=Date.now();
  let context;
  try{
    const browser=await getBrowser();
    context=await browser.newContext({viewport:{width:1440,height:1000}, userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36'});
    const page=await context.newPage();
    page.setDefaultTimeout(15000);
    await clickViewForMatch(page,matchId);
    await page.waitForLoadState('domcontentloaded').catch(()=>{});
    await page.waitForTimeout(1200);
    // If View opened a new route, keep waiting for data tables.
    for(let i=0;i<10;i++){
      const n=await page.locator('table').count().catch(()=>0);
      if(n>0) break;
      await page.waitForTimeout(600);
    }
    const tables=await extractTables(page);
    const classified=classify(tables);
    const title=norm(await page.title().catch(()=>''));
    const currentUrl=page.url();
    if(!tables.length) throw new Error('A página View foi aberta, mas nenhum quadro de dados foi encontrado.');
    res.json({ok:true,matchId,title,currentUrl,teamData:classified.teamData,playerData:classified.playerData,allTables:tables,elapsedMs:Date.now()-started});
  }catch(e){
    res.status(502).json({ok:false,error:e?.message||String(e),elapsedMs:Date.now()-started});
  }finally{ if(context) await context.close().catch(()=>{}); }
});

app.get('/api/health',(req,res)=>res.json({ok:true,version:'1.0.5'}));
process.on('SIGTERM',async()=>{if(browserPromise){const b=await browserPromise.catch(()=>null); await b?.close().catch(()=>{});} process.exit(0);});
app.listen(PORT,()=>console.log(`Stats Engine 1.0.5 listening on ${PORT}`));
