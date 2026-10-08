require('dotenv').config();
const axios=require('axios');
const express=require('express');
const config=require('./config');

const gh=axios.create({
  baseURL:'https://api.github.com',timeout:config.GITHUB_TIMEOUT_MS,
  headers:{...(config.GITHUB_TOKEN?{Authorization:`Bearer ${config.GITHUB_TOKEN}`}:{}),Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':config.USER_AGENT}
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function canonicalUrl(value){
  try{
    const u=new URL(String(value||'').trim());
    u.hostname=u.hostname.toLowerCase();
    if((u.protocol==='http:'&&u.port==='80')||(u.protocol==='https:'&&u.port==='443'))u.port='';
    if(u.pathname.length>1)u.pathname=u.pathname.replace(/\/+$/,'');
    u.hash='';
    return u.toString();
  }catch{return String(value||'').trim().toLowerCase();}
}
function unique(items){
  const seen=new Set(),out=[];
  for(const x of items){
    const key=canonicalUrl(x?.url);
    if(!key||seen.has(key))continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}
function parseM3U(text){const lines=String(text||'').split(/\r?\n/),out=[];let meta='';for(const raw of lines){const line=raw.trim();if(!line)continue;if(line.startsWith('#EXTINF')){meta=line;continue;}if(line.startsWith('#'))continue;if(/^https?:\/\//i.test(line)){const comma=meta.indexOf(',');out.push({name:comma>=0?meta.slice(comma+1).trim():'Unknown',meta:meta||'#EXTINF:-1,Unknown',url:line});meta='';}}return out;}
function normalizeChannelName(value){
  return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\b(1080p|720p|480p|4k|uhd|fhd|hd|sd|live|tv|television|channel)\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function sameChannelName(target, candidate){
  const a=normalizeChannelName(target), b=normalizeChannelName(candidate);
  if(!a||!b)return false;
  if(a===b)return true;
  const aa=a.split(' ').filter(Boolean), bb=b.split(' ').filter(Boolean);
  // Require every meaningful target token to appear in the source entry.
  return aa.length>0 && aa.every(token=>bb.includes(token));
}
function setName(meta){return String(meta||'').trim();}
function classifySource(source){const s=String(source||'').toLowerCase();if(s.includes('github'))return 'GitHub';if(s.includes('duckduckgo'))return 'DuckDuckGo';if(s.includes('firecrawl'))return 'Firecrawl';if(s.includes('searx'))return 'SearXNG';if(s.includes('google'))return 'Google';if(s.includes('cache'))return 'Cache';return 'Other';}
function emptySourceStats(){return {GitHub:{candidates:0,matched:0,online:0},DuckDuckGo:{candidates:0,matched:0,online:0},Firecrawl:{candidates:0,matched:0,online:0},SearXNG:{candidates:0,matched:0,online:0},Google:{candidates:0,matched:0,online:0},Cache:{candidates:0,matched:0,online:0},Other:{candidates:0,matched:0,online:0}};}
function dedupeTargetChannels(channels){const seen=new Set(),out=[];for(const channel of channels){const key=normalizeChannelName(channel.name);if(!key||seen.has(key)){console.log('[TARGET DEDUPE] Skipping duplicate target name: '+channel.name);continue;}seen.add(key);out.push(channel);}return out;}
function isHttpUrl(value){try{const u=new URL(String(value||''));return u.protocol==='http:'||u.protocol==='https:';}catch{return false;}}
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
        // Only accept entries that carry their own source playlist metadata.
        // A bare stream URL from source code is not enough to prove channel identity.
        for(const entry of parseM3U(content)){
          if(!entry.meta || !entry.meta.startsWith('#EXTINF')) continue;
          chunks.push({url:entry.url,source:item.html_url,name:entry.name,meta:entry.meta,sourceName:entry.name});
        }
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
async function duckduckgoSearch(query){if(!config.DDG_ENABLED)return[];try{const r=await axios.get('https://html.duckduckgo.com/html/',{params:{q:query},timeout:config.DDG_TIMEOUT_MS,headers:{'User-Agent':config.USER_AGENT,Accept:'text/html,application/xhtml+xml'},responseType:'text'});const out=[];const links=r.data.match(/uddg=([^&"']+)/gi)||[];for(const raw of links){try{const url=decodeURIComponent(raw.replace(/^uddg=/i,''));if(isHttpUrl(url))out.push({url,source:'DuckDuckGo',name:'Web result',page:true});}catch{}}return unique(out);}catch(e){console.warn('DuckDuckGo search:',e.message);return[];}}
let searxInstancesPromise=null;
const searxSearchCache=new Map();
const SEARX_INSTANCE_LIST_URL='https://searx.space/data/instances.json';

async function getSearxInstances(){
  if(searxInstancesPromise)return searxInstancesPromise;
  searxInstancesPromise=(async()=>{
    try{
      const r=await axios.get(SEARX_INSTANCE_LIST_URL,{timeout:7000,headers:{'User-Agent':config.USER_AGENT,Accept:'application/json'}});
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

async function expandWebPages(items){const out=[];const pages=unique(items).filter(x=>x.page&&isHttpUrl(x.url)).slice(0,6);for(const item of pages){try{const r=await axios.get(item.url,{timeout:config.WEB_PAGE_TIMEOUT_MS,maxRedirects:5,responseType:'text',headers:{'User-Agent':config.USER_AGENT,Accept:'text/html,application/xhtml+xml,text/plain'}});for(const url of extractUrls(r.data))out.push({url,source:item.source||'Web page',name:item.name||'Web result'});}catch{}}return unique(out);}
function parseSearxHtml(html){
  const out=[];
  const links=String(html||'').match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)||[];
  for(const raw of links){
    const m=raw.match(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!m)continue;
    let href=m[1];
    try{href=decodeURIComponent(href);}catch{}
    const title=m[2].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
    if(isHttpUrl(href))out.push({url:href,source:'SearXNG',name:title||'SearXNG result',page:true});
  }
  return unique(out);
}

async function searxngSearch(query){
  const key=String(query).trim().toLowerCase();
  if(searxSearchCache.has(key))return searxSearchCache.get(key);
  const instances=(await getSearxInstances()).slice(0,4);
  for(const instance of instances){
    try{
      const r=await axios.get(instance.url+'/search',{params:{q:query,format:'json',pageno:1},timeout:10000,headers:{'User-Agent':config.USER_AGENT,Accept:'application/json'}});
      const out=[];
      for(const item of r.data?.results||[]){
        if(isHttpUrl(item.url))out.push({url:item.url,source:'SearXNG',name:item.title||'SearXNG result',page:true});
      }
      const result=unique(out);
      if(result.length){const expanded=await expandWebPages(result);const final=unique([...result.filter(x=>!x.page),...expanded]);if(final.length){searxSearchCache.set(key,final);return final;}}
    }catch(e){
      const status=e.response?.status;
      if(status!==403&&status!==404&&status!==429&&status<500)console.warn('SearXNG:',e.message);
      try{
        if(status===403||status===404){
          const r=await axios.get(instance.url+'/search',{params:{q:query},timeout:7000,headers:{'User-Agent':config.USER_AGENT,Accept:'text/html'}});
          const result=parseSearxHtml(r.data);
          if(result.length){const expanded=await expandWebPages(result);const final=unique([...result.filter(x=>!x.page),...expanded]);if(final.length){searxSearchCache.set(key,final);return final;}}
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
  const direct=unique(out.filter(x=>!x.page));
  if(direct.length<config.MIN_WEB_RESULTS){const expanded=await expandWebPages(out);out.push(...expanded);}
  return unique(out.filter(x=>!x.page));
}
async function googleSearchLegacy(query){if(!config.GOOGLE_ENABLED||!config.GOOGLE_API_KEY||!config.GOOGLE_CX)return[];try{const r=await axios.get('https://www.googleapis.com/customsearch/v1',{params:{key:config.GOOGLE_API_KEY,cx:config.GOOGLE_CX,q:query,num:10},timeout:20000});const out=[];for(const item of r.data.items||[])for(const url of extractUrls([item.title,item.snippet,item.link].join(' ')))out.push({url,source:item.link,name:item.title});return out;}catch(e){console.warn('Google legacy search:',e.response?.data?.error?.message||e.message);return[];}}
async function webSearch(query){const [web,google]=await Promise.all([freeWebSearch(query),googleSearchLegacy(query)]);return unique([...web,...google]);}
async function isOnline(url){
  const key=String(url||'').trim().toLowerCase();
  if(!key)return false;
  if(onlineCheckCache.has(key))return onlineCheckCache.get(key);
  const check=(async()=>{
    let response;
    try{
      response=await axios.get(url,{
        timeout:config.URL_CHECK_TIMEOUT_MS,maxRedirects:5,
        responseType:'stream',validateStatus:s=>s>=200&&s<400,
        headers:{'User-Agent':config.USER_AGENT,Accept:'application/vnd.apple.mpegurl,application/x-mpegURL,video/mp2t,video/*,application/octet-stream,*/*'}
      });
      const status=response.status;
      const headers=response.headers||{};
      const type=String(headers['content-type']||'').toLowerCase();
      const finalUrl=String(response.request?.res?.responseUrl||url).toLowerCase();
      const isPlaylist=/\.m3u8?(?:[?#]|$)/i.test(finalUrl)||/mpegurl/.test(type);
      const isTs=/\.ts(?:[?#]|$)/i.test(finalUrl)||/mp2t/.test(type);
      if(type.includes('text/html')||type.includes('application/xhtml')){
        response.data.destroy();
        return false;
      }
      if(!isPlaylist&&!isTs&&!/video\//.test(type)&&!type.includes('octet-stream')){
        response.data.destroy();
        return false;
      }
      if(isPlaylist){
        const body=await new Promise((resolve,reject)=>{
          let data='',done=false;
          const finish=(err,value)=>{if(done)return;done=true;response.data.destroy();err?reject(err):resolve(value);};
          response.data.setEncoding('utf8');
          response.data.on('data',chunk=>{
            data+=chunk;
            if(data.length>=4096)finish(null,data.slice(0,4096));
          });
          response.data.on('end',()=>finish(null,data));
          response.data.on('error',err=>finish(err));
          setTimeout(()=>finish(null,data),Math.min(config.URL_CHECK_TIMEOUT_MS,2500)).unref?.();
        }).catch(()=> '');
        return status>=200&&status<400&&/^\s*#EXTM3U\b/i.test(body);
      }
      // For transport streams, a successful non-HTML response plus a stream-like
      // content type is required; reject pages that merely return HTTP 200.
      response.data.destroy();
      return status>=200&&status<400;
    }catch{
      if(response?.data?.destroy)response.data.destroy();
      return false;
    }
  })();
  onlineCheckCache.set(key,check);
  const result=await check;
  onlineCheckCache.delete(key);
  return result;
}
async function collectChannel(channel,cachedEntry){
  const baselineUrl=canonicalUrl(channel.url);
  const stats=emptySourceStats();
  const dedupeCandidates=list=>unique(Array.isArray(list)?list:[])
    .filter(x=>canonicalUrl(x?.url)!==baselineUrl)
    .filter(x=>isHttpUrl(x?.url))
    .slice(0,80);
  const cacheCandidates=Array.isArray(cachedEntry?.candidates)?cachedEntry.candidates:[];
  const legacyUrls=Array.isArray(cachedEntry?.urls)?cachedEntry.urls:[];
  let candidates=[];
  // Only structured cache entries containing source EXTINF metadata can be reused.
  // Legacy URL-only entries are retained for migration diagnostics but never trusted as channels.
  for(const c of cacheCandidates){
    const src=classifySource(c.source||'Cache');
    stats[src].candidates++;
    if(c.meta&&c.meta.startsWith('#EXTINF')&&sameChannelName(channel.name,c.sourceName||c.name)){
      stats[src].matched++; candidates.push({...c,source:c.source||'Cache'});
    }
  }
  if(legacyUrls.length) console.log('[CACHE] '+channel.name+': ignored '+legacyUrls.length+' legacy URL-only entries (missing EXTINF/source identity).');

  const githubBefore=candidates.length;
  let githubCandidates=await queueGithubCodeSearch('"'+channel.name+'" m3u8');
  if(!githubCandidates.length) githubCandidates=await queueGithubCodeSearch('"'+channel.name+'" m3u');
  githubCandidates=dedupeCandidates(githubCandidates);
  stats.GitHub.candidates+=githubCandidates.length;
  const githubMatched=githubCandidates.filter(c=>c.meta&&c.meta.startsWith('#EXTINF')&&sameChannelName(channel.name,c.sourceName||c.name));
  stats.GitHub.matched+=githubMatched.length;
  candidates.push(...githubMatched);

  // Search web providers separately for transparent per-provider counts.
  // Search-engine URL-only hits are diagnostic candidates only; without the original
  // source EXTINF metadata they cannot be written into the playlist.
  const webCandidates=await webSearch('"'+channel.name+'" m3u8');
  for(const c of webCandidates){
    const src=classifySource(c.source);
    stats[src].candidates++;
    if(c.meta&&c.meta.startsWith('#EXTINF')&&sameChannelName(channel.name,c.sourceName||c.name)){
      stats[src].matched++; candidates.push(c);
    }
  }
  candidates=dedupeCandidates(candidates)
    .filter(c=>c.meta&&c.meta.startsWith('#EXTINF'))
    .filter(c=>sameChannelName(channel.name,c.sourceName||c.name));

  const good=[];
  for(let i=0;i<candidates.length;i+=config.URL_CHECK_CONCURRENCY){
    const batch=candidates.slice(i,i+config.URL_CHECK_CONCURRENCY);
    const results=await Promise.all(batch.map(async c=>({c,ok:await isOnline(c.url)})));
    for(const {c,ok} of results){
      const src=classifySource(c.source||'Cache');
      if(ok){stats[src].online++;good.push({name:c.sourceName||c.name,url:c.url,meta:c.meta,source:c.source||'Cache'});}
      if(good.length>=config.MAX_RESULTS_PER_CHANNEL)break;
    }
    if(good.length>=config.MAX_RESULTS_PER_CHANNEL)break;
  }
  const compact=Object.fromEntries(Object.entries(stats).filter(([,v])=>v.candidates||v.matched||v.online));
  const summary=Object.entries(compact).map(([k,v])=>k+': candidates='+v.candidates+', matched='+v.matched+', online='+v.online).join(' | ')||'no candidates';
  console.log('[SOURCES] '+channel.name+' => '+summary+' | verified='+unique(good).length);
  return {
    results:unique(good),
    cacheCandidates:unique(candidates).slice(0,20).map(x=>({url:x.url,name:x.name,sourceName:x.sourceName||x.name,meta:x.meta,source:x.source||'Cache'})),
    sourceStats:stats,
    legacyCacheCount:legacyUrls.length
  };
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
  const rawChannels=parseM3U(source.content);\n  const channels=dedupeTargetChannels(rawChannels);\n  console.log('Target playlist entries:',rawChannels.length,'| unique channel names:',channels.length,'| duplicates skipped:',rawChannels.length-channels.length);
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
        if(completed%10===0) await savePersistentSearchCache(nextCache);
        githubCodeSearchCache.clear();
        searxSearchCache.clear();
        onlineCheckCache.clear();
        console.log(`[${i+1}/${channels.length}] DONE ${channel.name} (+${result.results.length} verified, cache-legacy-ignored=${result.legacyCacheCount}, run-total-raw=${found.length}, completed=${completed}/${channels.length})`);
      }catch(e){
        completed++;
        console.warn(`[${i+1}/${channels.length}] ERROR ${channel.name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(config.CHANNEL_CONCURRENCY,channels.length)},worker));
  found=unique(found);
  githubCodeSearchCache.clear();
  searxSearchCache.clear();
  onlineCheckCache.clear();
  await writeTarget(config.SEARCH_OUTPUT,render(found),`Search channel collection: ${found.length} online URLs`);
  await savePersistentSearchCache(nextCache);
  console.log('Search collection unique online URLs:',found.length);
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
      console.log('Scheduler enabled: every '+Math.round(config.RUN_INTERVAL_MS/3600000)+'h.');
    }else state='idle';
    return;
  }
  if(process.env.RUN_ON_STARTUP!=='false')await run();
}
main().catch(e=>{console.error(e.stack||e.message);process.exit(1);});