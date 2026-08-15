const express=require("express");
const path=require("path");
const {chromium}=require("playwright");
const app=express();
app.use(express.json({limit:"1mb"}));
const PORT=process.env.PORT||3000, HOST="0.0.0.0";
const BASE="https://matchstats.us.ffesports.com/match?search=";

let browser=null,page=null,running=false,pollTimer=null,matchId=null;
let consultations=0,changes=0,lastSignature="",lastUpdate=null,lastError=null;
let phase="idle",currentData=null,navigationInProgress=false;

const safe=(v)=>{try{return JSON.parse(JSON.stringify(v))}catch{return null}};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function ensureBrowser(){
  if(browser?.isConnected()&&page&&!page.isClosed()) return;
  browser=await chromium.launch({headless:true,args:[
    "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu"
  ]});
  page=await browser.newPage({
    viewport:{width:1440,height:1000},
    userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
  });
}

async function openMatchOnce(id){
  await ensureBrowser();
  navigationInProgress=true; phase="opening";
  try{
    await page.goto(BASE+encodeURIComponent(id),{
      waitUntil:"domcontentloaded",timeout:45000
    });
  }finally{navigationInProgress=false}
  phase="reading";
  await sleep(1800);
}

async function readPage(){
  if(!page||page.isClosed()) throw new Error("Página do MatchStats não está disponível.");
  return await page.evaluate(()=>{
    const norm=v=>String(v??"").replace(/\u00a0/g," ").replace(/\r/g,"")
      .replace(/[ \t]+/g," ").trim();
    const tables=[...document.querySelectorAll("table")].map((t,index)=>({
      index,
      rows:[...t.querySelectorAll("tr")].map(tr=>
        [...tr.querySelectorAll("th,td")].map(td=>norm(td.innerText))
      ).filter(r=>r.length)
    })).filter(t=>t.rows.length);
    return {title:document.title||"Match Stats",url:location.href,
      tables,bodyText:document.body?.innerText||""};
  });
}

function normalize(raw,id){
  if(!raw)return null;
  const tables=raw.tables||[], rows=tables.flatMap(t=>t.rows||[]);
  const hi=rows.findIndex(r=>r.some(x=>/match id/i.test(x))&&r.some(x=>/season id/i.test(x)));
  let matchRows=[];
  if(hi>=0){
    const head=rows[hi];
    matchRows=rows.slice(hi+1).filter(r=>r.length>=2&&r.some(Boolean)).map(r=>{
      const o={}; head.forEach((k,i)=>o[k||`column_${i+1}`]=r[i]??""); return o;
    });
  }
  return {capturedAt:new Date().toISOString(),requestedMatchId:String(id),
    title:raw.title,url:raw.url,matchRows,tables,bodyText:raw.bodyText};
}

async function capture(){
  if(!running||!matchId||navigationInProgress)return;
  consultations++; phase="capturing";
  try{
    const data=normalize(await readPage(),matchId);
    const sig=JSON.stringify({tables:data.tables,bodyText:data.bodyText});
    if(sig!==lastSignature){
      if(lastSignature)changes++;
      lastSignature=sig; currentData=data; lastUpdate=new Date().toISOString();
    }
    lastError=null; phase="monitoring";
  }catch(e){lastError=String(e?.stack||e?.message||e);phase="error"}
}

function loop(){
  clearTimeout(pollTimer);
  const tick=async()=>{if(!running)return;await capture();pollTimer=setTimeout(tick,1000)};
  tick();
}

async function stop(close=false){
  running=false;clearTimeout(pollTimer);pollTimer=null;navigationInProgress=false;
  if(close&&browser){try{await browser.close()}catch{} browser=null;page=null}
  if(phase!=="error")phase="stopped";
}

async function start(id){
  if(!id)throw new Error("Informe um Match ID.");
  await stop(false);
  matchId=String(id).trim();consultations=0;changes=0;lastSignature="";
  lastUpdate=null;lastError=null;currentData=null;phase="opening";running=true;
  try{await openMatchOnce(matchId);await capture();loop()}
  catch(e){lastError=String(e?.stack||e?.message||e);phase="error";running=false;throw e}
}

app.get("/health",(req,res)=>res.json({ok:true,version:"1.0.2",playwright:"1.62.1",running,phase}));
app.get("/api/status",(req,res)=>res.json({
  version:"1.0.2",status:lastError?"ERROR":running?"RUNNING":"IDLE",phase,matchId,
  currentUrl:page&&!page.isClosed()?page.url():null,title:currentData?.title||null,
  consultations,changes,lastUpdate,error:lastError,
  diagnostics:{browserReady:!!browser?.isConnected(),pageReady:!!(page&&!page.isClosed()),
    navigationInProgress,persistentPage:true,reloadEverySecond:false}
}));
app.get("/api/data",(req,res)=>res.json({version:"1.0.2",monitored:!!currentData,data:safe(currentData)}));
app.post("/api/start",async(req,res)=>{
  const id=String(req.body?.matchId||"").trim();
  if(!id)return res.status(400).json({ok:false,error:"Match ID obrigatório."});
  try{await start(id);res.json({ok:true,version:"1.0.2",matchId:id})}
  catch(e){res.status(500).json({ok:false,version:"1.0.2",error:String(e?.message||e)})}
});
app.post("/api/stop",async(req,res)=>{await stop(false);res.json({ok:true,version:"1.0.2"})});
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,HOST,()=>console.log(`Stats Engine 1.0.2 running on ${HOST}:${PORT}`));
process.on("SIGTERM",async()=>{await stop(true);process.exit(0)});
process.on("SIGINT",async()=>{await stop(true);process.exit(0)});
