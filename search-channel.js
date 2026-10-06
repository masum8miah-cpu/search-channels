require('dotenv').config();
const axios=require('axios');
const express=require('express');
const config=require('./config');

const gh=axios.create({
  baseURL:'https://api.github.com',timeout:config.GITHUB_TIMEOUT_MS,
  headers:{...(config.GITHUB_TOKEN?{Authorization:`Bearer ${config.GITHUB_TOKEN}`}:{}),Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':config.USER_AGENT}
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function unique(items){const seen=new Set(),out=[];for(const x of items){const key=x.url.toLowerCase().trim();if(!seen.has(key)){seen.add(key);out.push(x);}}return out;}
function parseM3U(text){const lines=String(text||'').split(/\r?\n/),out=[];let meta='';for(const raw of lines){const line=raw.trim();if(!line)continue;if(line.startsWith('#EXTINF')){meta=line;continue;}if(line.startsWith('#'))continue;if(/^https?:\/\//i.test(line)){const comma=meta.indexOf(',');out.push({name:comma>=0?meta.slice(comma+1).trim():'Unknown',meta:meta||'#EXTINF:-1,Unknown',url:line});meta='';}}return out;}
function extractUrls(text){return (String(text||'').match(/https?:\/\/[^\s"'<>]+/gi)||[]).map(u=>u.replace(/[),.;]+$/,'')).filter(u=>/\.(?:m3u8?|ts)(?:[?#]|$)/i.test(u));}
async function targetFile(path){const r=await gh.get(`/repos/${config.GITHUB_OWNER}/${config.TARGET_REPO}/contents/${encodeURIComponent(path)}`);return{sha:r.data.sha,content:Buffer.from(r.data.content,'base64').toString('utf8')};}
let githubCodeSearchPausedUntil=0;
let githubCodeSearchQueue=Promise.resolve();
const githubCodeSearchCache=new Map();
let githubCodeSearchPauseLoggedUntil=0;
const onlineCheckCache=new Map();

function githubRateLimitWaitMs(headers){
  const retryAfter=Number(headers?.['retry-after']);
  if(Number.isFinite(retryAfter)&&retryAfter>0)return Math.min(retryAfter*1000,config.GITHUB_CODE_SEARCH_RETRY_MAX_MS);
  const reset=Number(headers?.['x-ratelimit-reset']);
  if(Number.isFinite(reset)&&reset>0)return Math.max(1000,Math.min(reset*1000-Date.now()+1000,config.GITHUB_CODE_SEARCH_RETRY_MAX_MS));
  return Math.min(60000,config.GITHUB_CODE_SEARCH_RETRY_MAX_MS);
}

async function waitForGithubCodeSearch(){
  const wait=Math.max(0,githubCodeSearchPausedUntil-Date.now());
  if(wait>0){
    if(githubCodeSearchPauseLoggedUntil!==githubCodeSearchPausedUntil){
      githubCodeSearchPauseLoggedUntil=githubCodeSearchPausedUntil;
      console.log('GitHub code search rate limit: waiting '+Math.ceil(wait/1000)+'s before continuing.');
    }
    await sleep(wait);
  }
}

function queueGithubCodeSearch(query){
  const run=githubCodeSearchQueue.then(async()=>{
    await waitForGithubCodeSearch();
    return githubSearch(query);
  });
  githubCodeSearchQueue=run.catch(()=>{});
  return run;
}

async function githubSearch(query,attempt=0){
  if(!config.GITHUB_ENABLED||!config.GITHUB_TOKEN)return[];
  const key=String(query).trim().toLowerCase();
  if(githubCodeSearchCache.has(key))return githubCodeSearchCache.get(key);
  await waitForGithubCodeSearch();
  try{
    const r=await gh.get('/search/code',{params:{q:query,per_page:config.MAX_RESULTS_PER_CHANNEL}});
    const remaining=Number(r.headers?.['x-ratelimit-remaining']);
    const reset=Number(r.headers?.['x-ratelimit-reset']);
    if(Number.isFinite(remaining)&&remaining<=0&&Number.isFinite(reset))githubCodeSearchPausedUntil=Math.max(githubCodeSearchPausedUntil,reset*1000+1000);
    const items=r.data.items||[];
    const chunks=[];
    for(let i=0;i<items.length;i+=4){
      const batch=items.slice(i,i+4);
      const results=await Promise.allSettled(batch.map(async item=>{
        let content=(item.text_matches||[]).map(x=>x.fragment||'').join('\n');
        try{
          const b=await gh.get(item.url);
          if(b.data.content)content+='\n'+Buffer.from(b.data.content,'base64').toString('utf8');
        }catch{}
        return {item,content};
      }));
      for(const result of results)if(result.status==='fulfilled'){
        const {item,content}=result.value;
        for(const url of extractUrls(content))chunks.push({url,source:item.html_url,name:item.name});
      }
    }
    const result=unique(chunks);
    githubCodeSearchCache.set(key,result);
    await sleep(config.GITHUB_CODE_SEARCH_DELAY_MS);
    return result;
  }catch(e){
    const status=e.response?.status;
    if((status===403||status===429)&&attempt<1){
      const wait=githubRateLimitWaitMs(e.response?.headers||{});
      githubCodeSearchPausedUntil=Math.max(githubCodeSearchPausedUntil,Date.now()+wait);
      console.warn('GitHub code search rate-limited; pausing for '+Math.ceil(wait/1000)+'s.');
      await waitForGithubCodeSearch();
      return githubSearch(query,attempt+1);
    }
    console.warn('GitHub search:',e.response?.data?.message||e.message);
    return[];
  }
}
async function firecrawlSearch(query){if(!config.FIRECRAWL_ENABLED)return[];try{const headers={'Content-Type':'application/json'};if(config.FIRECRAWL_API_KEY)headers.Authorization=`Bearer ${config.FIRECRAWL_API_KEY}`;const r=await axios.post('https://api.firecrawl.dev/v2/search',{query,limit:config.FIRECRAWL_RESULTS,sources:['web'],scrapeOptions:{formats:['markdown']}},{timeout:config.FIRECRAWL_TIMEOUT_MS,headers});const out=[];for(const item of r.data.data?.web||[]){const text=[item.title,item.description,item.url,item.markdown].join(' ');for(const url of extractUrls(text))out.push({url,source:item.url,name:item.title||'Web result'});}return unique(out);}catch(e){console.warn('Firecrawl search:',e.response?.data?.error||e.message);return[];}}
async function duckduckgoSearch(query){if(!config.DDG_ENABLED)return[];try{const r=await axios.get('https://html.duckduckgo.com/html/',{params:{q:query},timeout:config.DDG_TIMEOUT_MS,headers:{'User-Agent':config.USER_AGENT,Accept:'text/html,application/xhtml+xml'},responseType:'text'});const out=[];const links=r.data.match(/uddg=([^&"']+)/gi)||[];for(const raw of links){try{const url=decodeURIComponent(raw.replace(/^uddg=/i,''));for(const stream of extractUrls(url))out.push({url:stream,source:'DuckDuckGo',name:'Web result'});}catch{}}return unique(out);}catch(e){console.warn('DuckDuckGo search:',e.message);return[];}}
let searxInstancesPromise=null;
const searxSearchCache=new Map();
const SEARX_INSTANCE_LIST_URL='https://searx.space/data/instances.json';

async function getSearxInstances(){
  if(searxInstancesPromise)return searxInstancesPromise;
  searxInstancesPromise=(async()=>{
    try{
      const r=await axios.get(SEARX_INSTANCE_LIST_URL,{timeout:10000,headers:{'User-Agent':config.USER_AGENT,Accept:'application/json'}});
      const source=r.data?.instances||r.data||{};
      const entries=Array.isArray(source)?source:Object.entries(source).map(([url,value])=>({url,...(value||{})}));
      return entries.map(x=>({
        url:String(x.url||'').replace(/\/$/,''),
        uptime:Number(x.http?.uptime??x.uptime??1)
      })).filter(x=>/^https:\/\//i.test(x.url)&&x.uptime>=0.9);
    }catch(e){
      console.warn('SearXNG instance list:',e.message);
      return [];
    }
  })();
  return searxInstancesPromise;
}

function parseSearxHtml(html){
  const out=[];
  const links=String(html||'').match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)||[];
  for(const raw of links){
    const m=raw.match(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!m)continue;
    let href=m[1];
    try{href=decodeURIComponent(href);}catch{}
    const title=m[2].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
    for(const url of extractUrls(href+' '+title))out.push({url,source:'SearXNG',name:title||'SearXNG result'});
  }
  return unique(out);
}

async function searxngSearch(query){
  const key=String(query).trim().toLowerCase();
  if(searxSearchCache.has(key))return searxSearchCache.get(key);
  const instances=(await getSearxInstances()).slice(0,8);
  for(const instance of instances){
    try{
      const r=await axios.get(instance.url+'/search',{params:{q:query,format:'json',pageno:1},timeout:10000,headers:{'User-Agent':config.USER_AGENT,Accept:'application/json'}});
      const out=[];
      for(const item of r.data?.results||[]){
        for(const url of extractUrls([item.title,item.content,item.url].join(' ')))out.push({url,source:'SearXNG',name:item.title||'SearXNG result'});
      }
      const result=unique(out);
      if(result.length){searxSearchCache.set(key,result);return result;}
    }catch(e){
      const status=e.response?.status;
      if(status!==403&&status!==404&&status!==429&&status<500)console.warn('SearXNG:',e.message);
      try{
        if(status===403||status===404){
          const r=await axios.get(instance.url+'/search',{params:{q:query},timeout:10000,headers:{'User-Agent':config.USER_AGENT,Accept:'text/html'}});
          const result=parseSearxHtml(r.data);
          if(result.length){searxSearchCache.set(key,result);return result;}
        }
      }catch{}
    }
  }
  searxSearchCache.set(key,[]);
  return [];
}

async function freeWebSearch(query){
  const out=[];
  if(config.FIRECRAWL_ENABLED)out.push(...await firecrawlSearch(query));
  if(out.length<config.MIN_WEB_RESULTS&&config.DDG_ENABLED)out.push(...await duckduckgoSearch(query));
  if(out.length<config.MIN_WEB_RESULTS)out.push(...await searxngSearch(query));
  return unique(out);
}
async function googleSearchLegacy(query){if(!config.GOOGLE_ENABLED||!config.GOOGLE_API_KEY||!config.GOOGLE_CX)return[];try{const r=await axios.get('https://www.googleapis.com/customsearch/v1',{params:{key:config.GOOGLE_API_KEY,cx:config.GOOGLE_CX,q:query,num:10},timeout:20000});const out=[];for(const item of r.data.items||[])for(const url of extractUrls([item.title,item.snippet,item.link].join(' ')))out.push({url,source:item.link,name:item.title});return out;}catch(e){console.warn('Google legacy search:',e.response?.data?.error?.message||e.message);return[];}}
async function webSearch(query){const [web,google]=await Promise.all([freeWebSearch(query),googleSearchLegacy(query)]);return unique([...web,...google]);}
async function isOnline(url){
  const key=String(url||'').trim().toLowerCase();
  if(!key)return false;
  if(onlineCheckCache.has(key))return onlineCheckCache.get(key);
  const check=(async()=>{
    try{
      const r=await axios.get(url,{timeout:config.URL_CHECK_TIMEOUT_MS,maxRedirects:5,responseType:'stream',validateStatus:s=>s>=200&&s<400,headers:{'User-Agent':config.USER_AGENT,Accept:'*/*'}});
      r.data.destroy(); return true;
    }catch{
      try{
        const r=await axios.head(url,{timeout:config.URL_CHECK_TIMEOUT_MS,maxRedirects:5,validateStatus:s=>s>=200&&s<400,headers:{'User-Agent':config.USER_AGENT}});
        return r.status>=200&&r.status<400;
      }catch{return false;}
    }
  })();
  onlineCheckCache.set(key,check);
  const result=await check;
  onlineCheckCache.delete(key);
  return result;
}
async function collectChannel(channel,cachedCandidates){
  const query=`"${channel.name}" m3u8`;
  let candidates=Array.isArray(cachedCandidates)&&cachedCandidates.length
    ? unique(cachedCandidates.map(url=>({url,source:'Persistent cache',name:channel.name})))
    : [];
  let usedCache=candidates.length>0;
  if(!candidates.length){
    const [githubCandidates,webCandidates]=await Promise.all([
      queueGithubCodeSearch(query),
      webSearch(query+' live')
    ]);
    candidates=unique([...githubCandidates,...webCandidates]).filter(x=>x.url!==channel.url).slice(0,40);
    usedCache=false;
  }
  async function validate(list){
    const good=[];
    for(let i=0;i<list.length;i+=config.URL_CHECK_CONCURRENCY){
      const batch=list.slice(i,i+config.URL_CHECK_CONCURRENCY);
      const results=await Promise.all(batch.map(async c=>({c,ok:await isOnline(c.url)})));
      for(const {c,ok} of results)if(ok){
        good.push({name:channel.name,url:c.url,meta:setName(channel.meta,channel.name,'Search Collection'),source:c.source});
        if(good.length>=config.MAX_RESULTS_PER_CHANNEL)break;
      }
      if(good.length>=config.MAX_RESULTS_PER_CHANNEL)break;
    }
    return good;
  }
  let good=await validate(candidates);
  if(usedCache&&!good.length){
    const [githubCandidates,webCandidates]=await Promise.all([
      queueGithubCodeSearch(query),
      webSearch(query+' live')
    ]);
    candidates=unique([...githubCandidates,...webCandidates]).filter(x=>x.url!==channel.url).slice(0,40);
    good=await validate(candidates);
  }
  return {results:good,candidates:candidates.slice(0,10)};
}
async function collectLive(){
  const batches=await Promise.all(config.LIVE_QUERIES.map(async q=>[...(await queueGithubCodeSearch(q)),...(await webSearch(q))]));
  const candidates=unique(batches.flat());
  const good=[];
  for(let i=0;i<candidates.length;i+=config.URL_CHECK_CONCURRENCY){
    const batch=candidates.slice(i,i+config.URL_CHECK_CONCURRENCY);
    const results=await Promise.all(batch.map(async c=>({c,ok:await isOnline(c.url)})));
    for(const {c,ok} of results)if(ok){
      const name=c.name||'Live Event Channel';
      good.push({name,url:c.url,meta:'#EXTINF:-1 tvg-name="'+name+'" group-title="Live Events",'+name,source:c.source});
      if(good.length>=config.MAX_LIVE_RESULTS)break;
    }
    if(good.length>=config.MAX_LIVE_RESULTS)break;
  }
  return good;
}
function render(items){return '#EXTM3U\n'+items.map(x=>x.meta+'\n'+x.url).join('\n')+'\n';}
async function writeTarget(path,content,message){let sha=null;try{sha=(await targetFile(path)).sha;}catch(e){if(e.response?.status!==404)throw e;}const body={message,content:Buffer.from(content,'utf8').toString('base64'),branch:config.TARGET_BRANCH};if(sha)body.sha=sha;await gh.put(`/repos/${config.GITHUB_OWNER}/${config.TARGET_REPO}/contents/${encodeURIComponent(path)}`,body);}
async function loadPersistentSearchCache(){
  try{
    const file=await targetFile(config.SEARCH_CACHE_OUTPUT);
    const data=JSON.parse(file.content);
    return data&&typeof data==='object'&&data.channels&&typeof data.channels==='object'?data:{version:1,channels:{}};
  }catch(e){
    if(e.response?.status!==404)console.warn('Search cache read:',e.message);
    return {version:1,channels:{}};
  }
}
async function savePersistentSearchCache(cache){
  try{await writeTarget(config.SEARCH_CACHE_OUTPUT,JSON.stringify(cache),'Update persistent channel search cache');}
  catch(e){console.warn('Search cache write skipped:',e.message);}
}
async function run(){
  if(!config.GITHUB_TOKEN)throw new Error('GITHUB_TOKEN is required');
  onlineCheckCache.clear();
  const source=await targetFile(config.SOURCE_PLAYLIST);
  const channels=parseM3U(source.content);
  if(!channels.length)throw new Error('No channels found in '+config.SOURCE_PLAYLIST);
  const previousCache=await loadPersistentSearchCache();
  const nextCache={version:1,channels:{}};
  console.log('Fetched latest baseline:',config.SOURCE_PLAYLIST);
  console.log('Target channel count:',channels.length);
  console.log('Search cache entries:',Object.keys(previousCache.channels||{}).length);
  console.log('Search sources:',[config.GITHUB_ENABLED&&config.GITHUB_TOKEN?'GitHub':'',config.FIRECRAWL_ENABLED?'Firecrawl':'',config.DDG_ENABLED?'DuckDuckGo':'','SearXNG fallback',config.GOOGLE_ENABLED&&config.GOOGLE_API_KEY&&config.GOOGLE_CX?'Google legacy':''].filter(Boolean).join(', ')||'none');let found=[];
  let nextIndex=0, completed=0;
  async function worker(){
    while(true){
      const i=nextIndex++;
      if(i>=channels.length)return;
      const channel=channels[i];
      console.log(`[${i+1}/${channels.length}] START ${channel.name}`);
      const before=found.length;
      try{
        const cacheKey=String(channel.name||'').trim().toLowerCase();
        const cached=previousCache.channels?.[cacheKey]?.urls||[];
        const result=await collectChannel(channel,cached);
        found.push(...result.results);
        nextCache.channels[cacheKey]={name:channel.name,urls:result.candidates.map(x=>x.url).filter(Boolean)};
        completed++;
        console.log(`[${i+1}/${channels.length}] DONE ${channel.name} (+${result.results.length}, ${cached.length?'cache':'search'}, total=${found.length}, completed=${completed})`);
      }catch(e){
        completed++;
        console.warn(`[${i+1}/${channels.length}] ERROR ${channel.name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(config.CHANNEL_CONCURRENCY,channels.length)},worker));
  found=unique(found);
  await writeTarget(config.SEARCH_OUTPUT,render(found),`Search channel collection: ${found.length} online URLs`);
  await savePersistentSearchCache(nextCache);
  console.log('Search collection:',found.length);
  const live=unique(await collectLive());
  await writeTarget(config.LIVE_OUTPUT,render(live),`Live event channel collection: ${live.length} online URLs`);
  console.log('Live-event collection:',live.length);
  return{targets:channels.length,search:found.length,live:live.length};
}
async function main(){
  const startHttp=process.env.START_HTTP==='true'||process.env.RENDER_SERVICE_TYPE==='web';
  if(startHttp){
    const app=express();
    let state='starting',lastResult=null,lastError=null,running=false;
    const execute=async()=>{
      if(running)return;
      running=true; state='running'; lastError=null;
      try{
        lastResult=await run();
        state='completed';
        console.log('Collection completed:',JSON.stringify(lastResult));
      }catch(error){
        state='error'; lastError=error.message;
        console.error(error.stack||error.message);
      }finally{running=false;}
    };
    app.get('/',(_,res)=>res.json({service:'search-channels',status:state,lastResult,lastError}));
    app.get('/health',(_,res)=>res.status(200).json({ok:true,status:state,lastResult,lastError}));
    app.listen(config.PORT,'0.0.0.0',()=>console.log('HTTP listening on '+config.PORT));
    if(process.env.RUN_ON_STARTUP!=='false'){
      void execute();
      setInterval(()=>{void execute();},config.RUN_INTERVAL_MS);
      console.log('Daily scheduler enabled: '+Math.round(config.RUN_INTERVAL_MS/3600000)+'h interval.');
    }else state='idle';
    return;
  }
  if(process.env.RUN_ON_STARTUP!=='false')await run();
}
main().catch(e=>{console.error(e.stack||e.message);process.exit(1);});