require('dotenv').config();
const axios=require('axios');
const express=require('express');
const config=require('./config');

const gh=axios.create({
  baseURL:'https://api.github.com',
  timeout:30000,
  headers:{
    ...(config.GITHUB_TOKEN?{Authorization:`Bearer ${config.GITHUB_TOKEN}`}:{}),
    Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':config.USER_AGENT
  }
});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function unique(items){
  const seen=new Set(),out=[];
  for(const x of items){
    const key=x.url.toLowerCase().trim();
    if(!seen.has(key)){seen.add(key);out.push(x);}
  }
  return out;
}

function parseM3U(text){
  const lines=String(text||'').split(/\r?\n/),out=[];
  let meta='';
  for(const raw of lines){
    const line=raw.trim();
    if(!line)continue;
    if(line.startsWith('#EXTINF')){meta=line;continue;}
    if(line.startsWith('#'))continue;
    if(/^https?:\\/\\//i.test(line)){
      const comma=meta.indexOf(',');
      out.push({
        name:comma>=0?meta.slice(comma+1).trim():'Unknown',
        meta:meta||'#EXTINF:-1,Unknown',
        url:line
      });
      meta='';
    }
  }
  return out;
}

function extractUrls(text){
  const urls=String(text||'').match(/https?:\\/\\/[^\\s"'<>]+/gi)||[];
  return urls
    .map(u=>u.replace(/[),.;]+$/,''))
    .filter(u=>/\\.m3u8?(?:[?#]|$)|\\.ts(?:[?#]|$)/i.test(u));
}

async function targetFile(path){
  const r=await gh.get(`/repos/${config.GITHUB_OWNER}/${config.TARGET_REPO}/contents/${encodeURIComponent(path)}`);
  return {sha:r.data.sha,content:Buffer.from(r.data.content,'base64').toString('utf8')};
}

async function githubSearch(query){
  if(!config.GITHUB_ENABLED||!config.GITHUB_TOKEN)return [];
  try{
    const r=await gh.get('/search/code',{params:{q:query,per_page:config.MAX_RESULTS_PER_CHANNEL}});
    const out=[];
    for(const item of r.data.items||[]){
      try{
        const b=await gh.get(item.url);
        const content=b.data.content?Buffer.from(b.data.content,'base64').toString('utf8'):'';
        for(const url of extractUrls(content))out.push({url,source:item.html_url,name:item.name});
      }catch{}
    }
    return out;
  }catch(e){
    console.warn('GitHub search:',e.response?.data?.message||e.message);
    return [];
  }
}

async function googleSearch(query){
  if(!config.GOOGLE_ENABLED||!config.GOOGLE_API_KEY||!config.GOOGLE_CX)return [];
  try{
    const r=await axios.get('https://www.googleapis.com/customsearch/v1',{
      params:{key:config.GOOGLE_API_KEY,cx:config.GOOGLE_CX,q:query,num:10},
      timeout:20000
    });
    const out=[];
    for(const item of r.data.items||[]){
      for(const url of extractUrls([item.title,item.snippet,item.link].join(' '))){
        out.push({url,source:item.link,name:item.title});
      }
    }
    return out;
  }catch(e){
    console.warn('Google search:',e.response?.data?.error?.message||e.message);
    return [];
  }
}

async function isOnline(url){
  try{
    const r=await axios.get(url,{
      timeout:config.URL_CHECK_TIMEOUT_MS,maxRedirects:5,responseType:'stream',
      validateStatus:s=>s>=200&&s<400,
      headers:{'User-Agent':config.USER_AGENT,Accept:'*/*'}
    });
    r.data.destroy();
    return true;
  }catch{
    try{
      const r=await axios.head(url,{
        timeout:config.URL_CHECK_TIMEOUT_MS,maxRedirects:5,
        validateStatus:s=>s>=200&&s<400,
        headers:{'User-Agent':config.USER_AGENT}
      });
      return r.status>=200&&r.status<400;
    }catch{return false;}
  }
}

function setName(meta,name,group){
  let m=meta||'#EXTINF:-1';
  m=m.replace(/,(.*)$/ ,','+name);
  if(!m.includes(','))m+=','+name;
  if(group&&!/group-title=/i.test(m))m=m.replace('#EXTINF:-1','#EXTINF:-1 group-title="'+group+'"');
  return m;
}

async function collectChannel(channel){
  const queries=[
    `"${channel.name}" m3u8`,
    `"${channel.name}" stream m3u8`
  ];
  let candidates=[];
  for(const q of queries){
    candidates.push(...await githubSearch(q));
    candidates.push(...await googleSearch(q+' live'));
    await sleep(config.SEARCH_DELAY_MS);
  }
  candidates=unique(candidates).filter(x=>x.url!==channel.url);
  const good=[];
  for(const c of candidates){
    if(await isOnline(c.url)){
      good.push({
        name:channel.name,
        url:c.url,
        meta:setName(channel.meta,channel.name,'Search Collection'),
        source:c.source
      });
    }
    if(good.length>=config.MAX_RESULTS_PER_CHANNEL)break;
  }
  return good;
}

async function collectLive(){
  let candidates=[];
  for(const q of config.LIVE_QUERIES){
    candidates.push(...await githubSearch(q));
    candidates.push(...await googleSearch(q));
    await sleep(config.SEARCH_DELAY_MS);
  }
  const good=[];
  for(const c of unique(candidates)){
    if(await isOnline(c.url)){
      const name=c.name||'Live Event Channel';
      good.push({
        name,
        url:c.url,
        meta:'#EXTINF:-1 tvg-name="'+name+'" group-title="Live Events",'+name,
        source:c.source
      });
    }
    if(good.length>=config.MAX_LIVE_RESULTS)break;
  }
  return good;
}

function render(items){
  return '#EXTM3U\n'+items.map(x=>x.meta+'\n'+x.url).join('\n')+'\n';
}

async function writeTarget(path,content,message){
  let sha=null;
  try{sha=(await targetFile(path)).sha;}
  catch(e){if(e.response?.status!==404)throw e;}
  const body={message,content:Buffer.from(content,'utf8').toString('base64'),branch:config.TARGET_BRANCH};
  if(sha)body.sha=sha;
  await gh.put(`/repos/${config.GITHUB_OWNER}/${config.TARGET_REPO}/contents/${encodeURIComponent(path)}`,body);
}

async function run(){
  if(!config.GITHUB_TOKEN)throw new Error('GITHUB_TOKEN is required');
  const source=await targetFile(config.SOURCE_PLAYLIST);
  const channels=parseM3U(source.content);
  if(!channels.length)throw new Error('No channels found in '+config.SOURCE_PLAYLIST);

  console.log('Target channel count:',channels.length);
  let found=[];
  for(let i=0;i<channels.length;i++){
    console.log(`[${i+1}/${channels.length}] ${channels[i].name}`);
    found.push(...await collectChannel(channels[i]));
  }
  found=unique(found);
  await writeTarget(config.SEARCH_OUTPUT,render(found),`Search channel collection: ${found.length} online URLs`);
  console.log('Search collection:',found.length);

  const live=unique(await collectLive());
  await writeTarget(config.LIVE_OUTPUT,render(live),`Live event channel collection: ${live.length} online URLs`);
  console.log('Live-event collection:',live.length);

  return {targets:channels.length,search:found.length,live:live.length};
}

async function main(){
  if(process.env.RUN_ON_STARTUP!=='false')await run();
  if(process.env.START_HTTP==='true'){
    const app=express();
    app.get('/',(_,res)=>res.json({service:'search-channels',status:'ok'}));
    app.get('/health',(_,res)=>res.json({ok:true}));
    app.listen(config.PORT,'0.0.0.0');
  }
}
main().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
