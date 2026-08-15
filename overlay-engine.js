(function(){
  const cfg=window.OVERLAY_CONFIG||{}; const server=window.SERVER_CONFIG||{};
  const API=(server.API_BASE_URL||'').replace(/\/$/,'');
  const streamUrl=API+(server.STREAM_ENDPOINT||'/api/stream');
  const root=document.documentElement;
  root.style.setProperty('--enter-ms',`${cfg.animation?.enterMs||420}ms`);
  root.style.setProperty('--exit-ms',`${cfg.animation?.exitMs||360}ms`);
  window.OverlayEngine={
    api: async function(path,opts){const r=await fetch(API+path,{cache:'no-store',...(opts||{})});return r.json()},
    esc:function(v){return String(v??'').replace(/[&<>'"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]))},
    css:function(el,props){Object.assign(el.style,props)},
    stream:function(handler){const es=new EventSource(streamUrl);es.onmessage=e=>{try{handler(JSON.parse(e.data))}catch{}};return es},
    image:function(src,cls){const i=document.createElement('img');i.src=src;i.className=cls||'';i.draggable=false;return i},
    fadeIn:function(el){el.classList.remove('out');void el.offsetWidth;el.classList.add('in')},
    fadeOut:function(el){el.classList.remove('in');el.classList.add('out')},
    start:function(){document.body.classList.add('ready')}
  };
})();
