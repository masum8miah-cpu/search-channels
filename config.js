require('dotenv').config();

const num=(v,d)=>v===undefined||v===''||Number.isNaN(Number(v))?d:Number(v);
const bool=(v,d)=>v===undefined?d:String(v).toLowerCase()==='true';

module.exports={
  PORT:num(process.env.PORT,10000),
  NODE_ENV:process.env.NODE_ENV||'production',
  GITHUB_TOKEN:process.env.GITHUB_TOKEN||'',
  GITHUB_OWNER:process.env.GITHUB_OWNER||'masum8miah-cpu',
  TARGET_REPO:process.env.TARGET_REPO||'my-ip-tv',
  TARGET_BRANCH:process.env.TARGET_BRANCH||'main',
  SOURCE_PLAYLIST:process.env.SOURCE_PLAYLIST||'Brightis.m3u',
  SEARCH_OUTPUT:process.env.SEARCH_OUTPUT||'সার্চ কালেকশন.m3u',
  LIVE_OUTPUT:process.env.LIVE_OUTPUT||'live-event-channel-colector.m3u',
  SEARCH_CACHE_OUTPUT:process.env.SEARCH_CACHE_OUTPUT||'search-channel-cache.json',
  RUN_INTERVAL_MS:num(process.env.RUN_INTERVAL_MS,24*60*60*1000),

  FIRECRAWL_ENABLED:bool(process.env.FIRECRAWL_ENABLED,true),
  FIRECRAWL_API_KEY:process.env.FIRECRAWL_API_KEY||'',
  FIRECRAWL_RESULTS:num(process.env.FIRECRAWL_RESULTS,5),
  FIRECRAWL_TIMEOUT_MS:num(process.env.FIRECRAWL_TIMEOUT_MS,30000),
  DDG_ENABLED:bool(process.env.DDG_ENABLED,true),
  DDG_TIMEOUT_MS:num(process.env.DDG_TIMEOUT_MS,15000),
  MIN_WEB_RESULTS:num(process.env.MIN_WEB_RESULTS,3),

  GOOGLE_API_KEY:process.env.GOOGLE_API_KEY||'',
  GOOGLE_CX:process.env.GOOGLE_CX||'',
  GOOGLE_ENABLED:bool(process.env.GOOGLE_ENABLED,false),

  GITHUB_ENABLED:bool(process.env.GITHUB_ENABLED,true),
  GITHUB_TIMEOUT_MS:num(process.env.GITHUB_TIMEOUT_MS,12000),
  GITHUB_CODE_SEARCH_DELAY_MS:num(process.env.GITHUB_CODE_SEARCH_DELAY_MS,1000),
  GITHUB_CODE_SEARCH_RETRY_MAX_MS:num(process.env.GITHUB_CODE_SEARCH_RETRY_MAX_MS,90000),
  CHANNEL_CONCURRENCY:num(process.env.CHANNEL_CONCURRENCY,1),
  URL_CHECK_CONCURRENCY:num(process.env.URL_CHECK_CONCURRENCY,4),
  URL_CHECK_TIMEOUT_MS:num(process.env.URL_CHECK_TIMEOUT_MS,10000),
  WEB_PAGE_TIMEOUT_MS:num(process.env.WEB_PAGE_TIMEOUT_MS,12000),
  SEARCH_DELAY_MS:num(process.env.SEARCH_DELAY_MS,250),
  MAX_RESULTS_PER_CHANNEL:num(process.env.MAX_RESULTS_PER_CHANNEL,10),
  MAX_LIVE_RESULTS:num(process.env.MAX_LIVE_RESULTS,200),
  LIVE_QUERIES:(process.env.LIVE_QUERIES||'live sports m3u8,live cricket m3u8,live football m3u8,live event m3u8,live tv m3u8').split(',').map(s=>s.trim()).filter(Boolean),
  USER_AGENT:process.env.USER_AGENT||'search-channels/1.0'
};