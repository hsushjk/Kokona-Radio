'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const CFG = Object.assign({
  port: 3000,
  musicDir: '/opt/radio/music',
  hlsDir: '/opt/radio/hls',
  publicDir: '/opt/radio/public',
  fifoPath: '/tmp/radio-pcm.fifo',
  ffmpegPath: '/usr/bin/ffmpeg',
  ffprobePath: '/usr/bin/ffprobe',
  bitrate: '192k',
  sampleRate: 44100,
  hlsTime: 2,
  hlsListSize: 6,
  shuffle: true,
  streamDelay: 8,
  controlPath: 'ctrl',
  controlToken: '',
  noticePath: '/opt/radio/notice.json',
}, (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
})());

function abs(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}
CFG.musicDir    = abs(CFG.musicDir);
CFG.hlsDir      = abs(CFG.hlsDir);
CFG.publicDir   = abs(CFG.publicDir);
CFG.ffmpegPath  = abs(CFG.ffmpegPath);
CFG.ffprobePath = abs(CFG.ffprobePath);
CFG.noticePath  = abs(CFG.noticePath);

if (!CFG.controlPath || !/^[a-zA-Z0-9_-]{1,64}$/.test(CFG.controlPath)) {
  CFG.controlPath = '';
}
if (CFG.controlToken && CFG.controlToken.length < 16) {
  console.warn('[warn] controlToken 长度小于 16，建议更换');
}

const CTRL_BASE = CFG.controlPath ? '/' + CFG.controlPath : '';

let noticeData = { text: '', updatedAt: 0 };

function loadNotice() {
  try {
    const raw = fs.readFileSync(CFG.noticePath, 'utf8');
    const j = JSON.parse(raw);
    noticeData = {
      text: typeof j.text === 'string' ? j.text : '',
      updatedAt: j.updatedAt || 0,
    };
  } catch (e) {
    noticeData = { text: '', updatedAt: 0 };
  }
}

function saveNotice(text) {
  noticeData = { text: String(text || ''), updatedAt: Date.now() };
  try {
    fs.writeFileSync(CFG.noticePath, JSON.stringify(noticeData, null, 2), 'utf8');
  } catch (e) {
    console.error('[notice] save failed:', e.message);
  }
}

function formatNoticeHtml(text) {
  if (!text) return '';
  let s = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  s = s
    .replace(/&lt;(\/?)br\s*\/?&gt;/gi, '<$1br>')
    .replace(/&lt;(\/?)b&gt;/gi, '<$1b>')
    .replace(/&lt;(\/?)strong&gt;/gi, '<$1strong>')
    .replace(/&lt;(\/?)i&gt;/gi, '<$1i>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function idOf(file) {
  const rel = path.relative(CFG.musicDir, file);
  return crypto.createHash('md5').update(rel).digest('hex').slice(0, 16);
}
function tagOf(tags, ...keys) {
  if (!tags) return '';
  const lower = {};
  for (const k of Object.keys(tags)) lower[k.toLowerCase()] = tags[k];
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

function scanFiles() {
  const out = [];
  (function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(mp3|flac|m4a|mp4|wav|ogg|oga|opus|aac|wma|aiff?|ape)$/i.test(name)) out.push(p);
    }
  })(CFG.musicDir);
  return out.sort();
}

async function probe(file) {
  const { stdout } = await execFileP(CFG.ffprobePath, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 20000 });
  return JSON.parse(stdout);
}

function extractCover(file) {
  return new Promise((resolve) => {
    const p = spawn(CFG.ffmpegPath, [
      '-v', 'quiet', '-i', file, '-an',
      '-map', '0:v:0', '-c:v', 'mjpeg', '-f', 'mjpeg', 'pipe:1',
    ]);
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
  });
}

async function buildTrack(file) {
  const id = idOf(file);
  let info = { format: {}, streams: [] };
  try { info = await probe(file); } catch (e) {}

  const fmt = info.format || {};
  const tags = fmt.tags || {};
  const streams = info.streams || [];

  const title   = tagOf(tags, 'title') || path.basename(file, path.extname(file));
  const artist  = tagOf(tags, 'artist', 'album_artist', 'albumartist', 'performer') || '';
  const album   = tagOf(tags, 'album') || '';
  const duration = Math.max(0, Math.floor(parseFloat(fmt.duration || 0) || 0));
  const hasCover = streams.some(s =>
    s.codec_type === 'video' && s.disposition && Number(s.disposition.attached_pic) === 1
  );
  const lyricsInline = tagOf(
    tags,
    'lyrics', 'unsyncedlyrics', 'unsynced_lyrics', 'unsynced lyrics',
    'syncedlyrics', 'synced_lyrics', 'synclyrics',
    'lyric', '©lyr', 'lyr'
  );
  let lyricsPath = null;
  if (!lyricsInline) {
    const stem = file.replace(/\.[^.]+$/, '');
    if (fs.existsSync(stem + '.lrc')) lyricsPath = stem + '.lrc';
  }

  return { id, file, title, artist, album, duration, hasCover, lyricsInline, lyricsPath };
}

let tracks = [];
let tracksById = new Map();

async function reloadLibrary() {
  loadNotice();
  const files = scanFiles();
  const built = [];
  const LIMIT = 6;
  for (let i = 0; i < files.length; i += LIMIT) {
    const slice = files.slice(i, i + LIMIT);
    const part = await Promise.all(slice.map(f => buildTrack(f).catch(() => null)));
    for (const t of part) if (t) built.push(t);
  }
  tracks = built;
  tracksById = new Map(tracks.map(t => [t.id, t]));
  console.log('[library] ' + tracks.length + ' tracks');
}

const coverCache = new Map();
async function getCover(track) {
  if (coverCache.has(track.id)) return coverCache.get(track.id);
  if (!track.hasCover) { coverCache.set(track.id, null); return null; }
  const buf = await extractCover(track.file);
  const entry = buf ? { buf } : null;
  coverCache.set(track.id, entry);
  return entry;
}

const lyricsCache = new Map();
async function getLyrics(track) {
  if (lyricsCache.has(track.id)) return lyricsCache.get(track.id);
  let text = '';
  if (track.lyricsInline) text = track.lyricsInline;
  else if (track.lyricsPath) {
    try { text = await fs.promises.readFile(track.lyricsPath, 'utf8'); } catch (e) {}
  }
  lyricsCache.set(track.id, text);
  return text;
}

let mainFF = null;
let fifoWriter = null;
let restartTimer = null;

function ensureFifo() {
  try { fs.unlinkSync(CFG.fifoPath); } catch (e) {}
  execFileSync('mkfifo', [CFG.fifoPath]);
  console.log('[fifo] created ' + CFG.fifoPath);
}

function startMainFFmpeg() {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(CFG.sampleRate), '-ac', '2',
    '-i', CFG.fifoPath,
    '-c:a', 'aac',
    '-b:a', CFG.bitrate,
    '-ar', String(CFG.sampleRate),
    '-ac', '2',
    '-f', 'hls',
    '-hls_time', String(CFG.hlsTime),
    '-hls_list_size', String(CFG.hlsListSize),
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(CFG.hlsDir, 's_%06d.ts'),
    path.join(CFG.hlsDir, 'stream.m3u8'),
  ];
  const proc = spawn(CFG.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) console.error('[main-ffmpeg] ' + s);
  });
  proc.on('error', err => console.error('[main-ffmpeg spawn error]', err.message));
  proc.on('exit', (code, sig) => {
    console.error('[main-ffmpeg] exit code=' + code + ' sig=' + sig);
    mainFF = null;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      openFifoWriter();
      mainFF = startMainFFmpeg();
    }, 1500);
  });
  return proc;
}

function openFifoWriter() {
  if (fifoWriter) {
    try { fifoWriter.destroy(); } catch (e) {}
    fifoWriter = null;
  }
  const ws = fs.createWriteStream(CFG.fifoPath, { flags: 'w' });
  ws.on('error', err => {
    console.error('[fifo write] error:', err.message);
    if (fifoWriter === ws) {
      fifoWriter = null;
      setTimeout(openFifoWriter, 1000);
    }
  });
  ws.on('open', () => console.log('[fifo] writer opened'));
  fifoWriter = ws;
}

let queue = [];
let current = null;
let currentStart = 0;
let currentDecoder = null;
let switchId = 0;
const feedTimeline = [];
const playHistory = [];

function silenceBuffer(seconds) {
  return Buffer.alloc(Math.max(0, Math.floor(CFG.sampleRate * 2 * 2 * seconds)));
}

function switchTo(track, opts) {
  const fromPrev = !!(opts && opts.fromPrev);
  const myId = ++switchId;

  if (current && current !== track && !fromPrev) {
    playHistory.push(current);
    if (playHistory.length > 500) playHistory.shift();
  }

  if (currentDecoder) {
    try { currentDecoder.kill('SIGKILL'); } catch (e) {}
    currentDecoder = null;
  }

  current = track;
  currentStart = Date.now();

  feedTimeline.push({
    t: currentStart,
    track: {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      hasCover: !!track.hasCover,
    },
  });
  const keepFrom = Date.now() - (CFG.streamDelay + 300) * 1000;
  while (feedTimeline.length > 1 && feedTimeline[0].t < keepFrom) feedTimeline.shift();

  console.log('[play] ' + (track.artist ? track.artist + ' — ' : '') + track.title);

  const dec = spawn(CFG.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-threads', '1',
    '-re',
    '-i', track.file,
    '-vn',
    '-f', 's16le',
    '-ar', String(CFG.sampleRate),
    '-ac', '2',
    '-threads', '1',
    'pipe:1',
  ]);
  currentDecoder = dec;

  let ended = false;
  function onEnd(reason) {
    if (ended) return;
    ended = true;
    if (myId !== switchId) return;
    if (reason) console.error('[decoder] ' + reason);
    try {
      if (fifoWriter && !fifoWriter.destroyed) fifoWriter.write(silenceBuffer(0.08));
    } catch (e) {}
    setTimeout(feedNext, 20);
  }

  dec.stdout.on('data', chunk => {
    if (myId !== switchId) return;
    if (!fifoWriter || fifoWriter.destroyed) {
      try { dec.kill('SIGKILL'); } catch (e) {}
      return;
    }
    const ok = fifoWriter.write(chunk);
    if (!ok) {
      dec.stdout.pause();
      fifoWriter.once('drain', () => {
        try { dec.stdout.resume(); } catch (e) {}
      });
    }
  });
  dec.stdout.on('end', () => onEnd(null));
  dec.on('exit', (code, sig) => {
    if (code !== 0 && sig !== 'SIGKILL') onEnd('exit code=' + code + ' sig=' + sig);
    else onEnd(null);
  });
  dec.on('error', err => onEnd('spawn: ' + err.message));
}

function feedNext() {
  if (!fifoWriter || fifoWriter.destroyed) {
    setTimeout(feedNext, 1000);
    return;
  }
  if (tracks.length === 0) {
    console.error('[radio] 曲库为空，5 秒后重试');
    setTimeout(feedNext, 5000);
    return;
  }
  if (queue.length === 0) {
    queue = CFG.shuffle ? shuffle(tracks) : tracks.slice();
  }
  const t = queue.shift();
  switchTo(t, null);
}

function feedPrev() {
  if (playHistory.length === 0) return false;
  const t = playHistory.pop();
  if (current) queue.unshift(current);
  switchTo(t, { fromPrev: true });
  return true;
}

function getClientTrack() {
  if (feedTimeline.length === 0) return null;
  const cutoff = Date.now() - CFG.streamDelay * 1000;
  let chosen = null;
  for (let i = feedTimeline.length - 1; i >= 0; i--) {
    if (feedTimeline[i].t <= cutoff) { chosen = feedTimeline[i]; break; }
  }
  if (!chosen) return { entry: feedTimeline[0], elapsed: 0 };
  return { entry: chosen, elapsed: (cutoff - chosen.t) / 1000 };
}

const seen = new Map();
const SESSION_TTL = 20000;

function clientKey(req, url) {
  const sid = url && url.searchParams.get('sid');
  if (sid && /^[A-Za-z0-9_-]{8,64}$/.test(sid)) return 's:' + sid;
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return 'i:' + first;
  }
  const real = req.headers['x-real-ip'];
  if (real) return 'i:' + String(real).trim();
  const ra = req.socket.remoteAddress || '';
  return 'i:' + (ra.replace(/^::ffff:/, '') || 'unknown');
}
function touch(req, url) { seen.set(clientKey(req, url), Date.now()); }
function activeCount() {
  const now = Date.now();
  let n = 0;
  for (const [k, t] of seen) {
    if (now - t < SESSION_TTL) n++;
    else seen.delete(k);
  }
  return n;
}
function getUserList() {
  const now = Date.now();
  const arr = [];
  for (const [k, t] of seen) {
    if (now - t < SESSION_TTL) {
      arr.push({ key: k, secondsAgo: Math.floor((now - t) / 1000) });
    }
  }
  arr.sort((a, b) => a.secondsAgo - b.secondsAgo);
  return arr;
}

function checkToken(req) {
  const expected = CFG.controlToken;
  if (!expected || expected.length < 16) return false;
  const provided = req.headers['x-ctrl-token'] || '';
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}

function buildState() {
  const d = getClientTrack();
  return {
    ok: true,
    current: current ? {
      id: current.id, title: current.title, artist: current.artist, duration: current.duration,
    } : null,
    clientTrack: d ? {
      title: d.entry.track.title, artist: d.entry.track.artist, elapsed: Math.max(0, Math.floor(d.elapsed)),
    } : null,
    queue: queue.map(t => ({ id: t.id, title: t.title, artist: t.artist })),
    history: playHistory.slice().reverse().map(t => ({ id: t.id, title: t.title, artist: t.artist })),
    listeners: getUserList(),
    librarySize: tracks.length,
    notice: noticeData.text,
    noticeUpdatedAt: noticeData.updatedAt,
  };
}

const CTRL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',system-ui,sans-serif;background:#0d0d10;color:#ddd;font-size:13px;min-height:100vh;padding:24px}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:13px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:#888;margin-bottom:20px}
.auth{display:flex;gap:8px;margin-bottom:20px}
input{flex:1;padding:10px 12px;background:#1a1a1e;border:1px solid #2a2a30;border-radius:6px;color:#eee;font:inherit;outline:none}
input:focus{border-color:#444}
button{padding:10px 20px;background:#1f1f24;border:1px solid #2a2a30;border-radius:6px;color:#ddd;font:inherit;cursor:pointer;transition:background .15s}
button:hover:not(:disabled){background:#2a2a30}
button:active:not(:disabled){background:#333}
button:disabled{opacity:.3;cursor:not-allowed}
select{padding:6px 10px;background:#1a1a1e;border:1px solid #2a2a30;border-radius:6px;color:#ddd;font:inherit;outline:none;cursor:pointer}
.controls{display:flex;gap:10px;margin-bottom:16px}
.controls button{flex:1}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:12px;color:#888}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.col h2{font-size:10px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:#666;margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline}
.col h2 .count{color:#444;font-weight:400;letter-spacing:0;text-transform:none;font-size:11px}
.list{background:#131316;border:1px solid #1e1e22;border-radius:6px;height:420px;overflow-y:auto}
.item{padding:8px 12px;border-bottom:1px solid #1a1a1e;font-size:12px;color:#aaa}
.item:last-child{border-bottom:0}
.item .t{color:#ddd}
.item .a{color:#666;font-size:11px;margin-left:6px}
.empty{padding:16px 12px;color:#444;text-align:center;font-size:12px}
.status{margin-bottom:16px;padding:12px 14px;background:#131316;border:1px solid #1e1e22;border-radius:6px;font-size:12px;color:#888}
.status .now{color:#ddd}
.err{color:#e53;font-size:12px;margin-bottom:10px;min-height:16px}
.pager{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:8px;font-size:11px;color:#666;height:26px}
.pager button{padding:3px 12px;font-size:11px}
.pager .num{color:#aaa}
.notice-edit{margin-top:20px}
.notice-edit h2{font-size:10px;font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:#666;margin-bottom:8px}
.notice-edit textarea{width:100%;padding:10px 12px;background:#131316;border:1px solid #1e1e22;border-radius:6px;color:#ddd;font:inherit;font-size:12px;line-height:1.7;resize:vertical;min-height:80px;outline:none;font-family:inherit}
.notice-edit textarea:focus{border-color:#3a3a42}
.notice-actions{display:flex;align-items:center;gap:12px;margin-top:10px}
.notice-actions button{padding:7px 16px;font-size:12px}
.notice-status{font-size:11px;color:#666}
.notice-status.ok{color:#6c9}
.notice-status.err{color:#e53}
#panel[hidden],#auth[hidden]{display:none}
</style>
</head>
<body>
<div class="wrap">
<h1>Radio Control</h1>
<div id="auth">
<input id="token" type="password" placeholder="Token" autocomplete="off">
<button id="login">连接</button>
</div>
<div id="err" class="err"></div>
<div id="panel" hidden>
<div class="status" id="status"></div>
<div class="controls">
<button id="prev">上一首</button>
<button id="next">下一首</button>
</div>
<div class="toolbar">
<span>每页</span>
<select id="pageSize">
<option value="50">50</option>
<option value="100">100</option>
<option value="250">250</option>
<option value="500">500</option>
<option value="800">800</option>
<option value="1000">1000</option>
</select>
<span>条</span>
</div>
<div class="cols">
<div class="col">
<h2>待播队列 <span class="count" id="queueCount"></span></h2>
<div class="list" id="queue"></div>
<div class="pager" id="queuePager"></div>
</div>
<div class="col">
<h2>已播历史 <span class="count" id="historyCount"></span></h2>
<div class="list" id="history"></div>
<div class="pager" id="historyPager"></div>
</div>
<div class="col">
<h2>在线听众 <span class="count" id="listenersCount"></span></h2>
<div class="list" id="listeners"></div>
<div class="pager" id="listenersPager"></div>
</div>
</div>
<div class="notice-edit">
<h2>通知 / 公告</h2>
<textarea id="noticeText" placeholder="支持 &lt;br&gt; 换行、&lt;b&gt;加粗&lt;/b&gt;、&lt;strong&gt;、&lt;i&gt;。留空则不显示。"></textarea>
<div class="notice-actions">
<button id="saveNotice">保存</button>
<span class="notice-status" id="noticeStatus"></span>
</div>
</div>
</div>
</div>
<script>
(function(){
'use strict';
var base=location.pathname;
if(base.length>1&&base.charAt(base.length-1)==='/')base=base.slice(0,-1);
var token='';
var timer=null;
var pageSize=50;
var pageState={queue:1,history:1,listeners:1};
var dataCache={queue:[],history:[],listeners:[]};

function $(id){return document.getElementById(id)}
function setErr(s){$('err').textContent=s||''}
function setNoticeStatus(s,cls){var e=$('noticeStatus');e.textContent=s||'';e.className='notice-status'+(cls?' '+cls:'')}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

async function api(p,o){
o=o||{};
o.headers=o.headers||{};
o.headers['X-Ctrl-Token']=token;
if(o.body)o.headers['Content-Type']='application/json';
var r=await fetch(base+p,o);
if(!r.ok)throw new Error('HTTP '+r.status);
return r.json();
}

function renderItems(name,slice){
if(name==='listeners'){
return slice.map(function(u){return '<div class="item"><span class="t">'+esc(u.key)+'</span><span class="a">'+u.secondsAgo+'s 前</span></div>'}).join('');
}
return slice.map(function(t){return '<div class="item"><span class="t">'+esc(t.title)+'</span><span class="a">'+esc(t.artist)+'</span></div>'}).join('');
}

function renderPage(name){
var items=dataCache[name]||[];
var total=items.length;
var pages=Math.max(1,Math.ceil(total/pageSize));
if(pageState[name]>pages)pageState[name]=pages;
if(pageState[name]<1)pageState[name]=1;
var start=(pageState[name]-1)*pageSize;
var slice=items.slice(start,start+pageSize);
var listEl=$(name);
if(!slice.length)listEl.innerHTML='<div class="empty">空</div>';
else listEl.innerHTML=renderItems(name,slice);
var countEl=$(name+'Count');
if(countEl)countEl.textContent=total+' 条';
var pagerEl=$(name+'Pager');
if(pages<=1){pagerEl.innerHTML='';return}
pagerEl.innerHTML=
'<button data-name="'+name+'" data-page="'+(pageState[name]-1)+'"'+(pageState[name]<=1?' disabled':'')+'>上一页</button>'+
'<span class="num">'+pageState[name]+' / '+pages+'</span>'+
'<button data-name="'+name+'" data-page="'+(pageState[name]+1)+'"'+(pageState[name]>=pages?' disabled':'')+'>下一页</button>';
}

function render(st){
var now=st.clientTrack?(esc(st.clientTrack.title)+' <span class="a">'+esc(st.clientTrack.artist)+'</span>'):'<span style="color:#555">无</span>';
var srv=st.current?(esc(st.current.title)+' <span class="a">'+esc(st.current.artist)+'</span>'):'<span style="color:#555">无</span>';
$('status').innerHTML='听众：'+esc(st.listeners.length)+' ｜ 曲库：'+esc(st.librarySize||0)+' 首 ｜ 服务端曲目：<span class="now">'+srv+'</span> ｜ 客户端正听：<span class="now">'+now+'</span>';
dataCache.queue=st.queue||[];
dataCache.history=st.history||[];
dataCache.listeners=st.listeners||[];
renderPage('queue');
renderPage('history');
renderPage('listeners');
var ta=$('noticeText');
if(document.activeElement!==ta&&ta.value!==(st.notice||'')){
ta.value=st.notice||'';
}
}

async function refresh(){
try{
var s=await api('/api/state');
render(s);
setErr('');
}catch(e){
setErr('连接失败：'+e.message);
}
}

async function doAction(a,extra){
var body={action:a};
if(extra)for(var k in extra)body[k]=extra[k];
try{
await api('/api/action',{method:'POST',body:JSON.stringify(body)});
refresh();
}catch(e){
setErr('操作失败：'+e.message);
}
}

document.addEventListener('click',function(e){
var t=e.target;
if(t.tagName==='BUTTON'&&t.dataset&&t.dataset.name&&t.dataset.page){
pageState[t.dataset.name]=parseInt(t.dataset.page,10);
renderPage(t.dataset.name);
}
});

$('pageSize').addEventListener('change',function(){
pageSize=parseInt(this.value,10);
pageState={queue:1,history:1,listeners:1};
try{localStorage.setItem('radio_ctrl_pagesize',String(pageSize))}catch(e){}
renderPage('queue');
renderPage('history');
renderPage('listeners');
});

$('prev').addEventListener('click',function(){doAction('prev')});
$('next').addEventListener('click',function(){doAction('next')});

$('saveNotice').addEventListener('click',async function(){
var text=$('noticeText').value;
setNoticeStatus('保存中...');
try{
await api('/api/action',{method:'POST',body:JSON.stringify({action:'setNotice',text:text})});
setNoticeStatus('已保存','ok');
setTimeout(function(){setNoticeStatus('')},2500);
}catch(e){
setNoticeStatus('保存失败：'+e.message,'err');
}
});

$('login').addEventListener('click',function(){
var v=$('token').value.trim();
if(!v){setErr('请输入 token');return}
token=v;
try{localStorage.setItem('radio_ctrl_token',token)}catch(e){}
$('auth').hidden=true;
$('panel').hidden=false;
setErr('');
refresh();
if(timer)clearInterval(timer);
timer=setInterval(refresh,2000);
});

$('token').addEventListener('keydown',function(e){if(e.key==='Enter')$('login').click()});

try{
var saved=localStorage.getItem('radio_ctrl_token');
if(saved)$('token').value=saved;
var savedSize=localStorage.getItem('radio_ctrl_pagesize');
if(savedSize){
var n=parseInt(savedSize,10);
if([50,100,250,500,800,1000].indexOf(n)>=0){
pageSize=n;
$('pageSize').value=String(n);
}
}
}catch(e){}
})();
</script>
</body>
</html>`;

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts':   'video/mp2t',
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

function head(res, code, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
}
function sendText(res, code, type, body) { head(res, code, type); res.end(body); }
function sendJson(res, code, obj) {
  sendText(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}
function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
    head(res, 200, type);
    res.end(data);
  });
}

function findTrack(id) {
  if (current && current.id === id) return current;
  for (const t of queue) if (t.id === id) return t;
  return tracksById.get(id) || null;
}

async function handleControl(req, res, p, u) {
  if (p === CTRL_BASE || p === CTRL_BASE + '/') {
    head(res, 200, 'text/html; charset=utf-8');
    res.end(CTRL_HTML);
    return;
  }

  if (!checkToken(req)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  if (p === CTRL_BASE + '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, buildState());
  }

  if (p === CTRL_BASE + '/api/action' && req.method === 'POST') {
    let body = '';
    try {
      for await (const chunk of req) body += chunk;
    } catch (e) {}
    let data = null;
    try { data = JSON.parse(body); } catch (e) {}
    const act = data && data.action;
    if (act === 'next') {
      feedNext();
      return sendJson(res, 200, { ok: true, action: 'next' });
    }
    if (act === 'prev') {
      const ok = feedPrev();
      return sendJson(res, 200, { ok: ok, action: 'prev' });
    }
    if (act === 'setNotice') {
      const text = data && typeof data.text === 'string' ? data.text : '';
      if (text.length > 8000) return sendJson(res, 400, { ok: false, error: 'too long' });
      saveNotice(text);
      return sendJson(res, 200, { ok: true, action: 'setNotice' });
    }
    return sendJson(res, 400, { ok: false, error: 'bad action' });
  }

  return sendJson(res, 404, { ok: false });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);

  if (CTRL_BASE && (p === CTRL_BASE || p.startsWith(CTRL_BASE + '/'))) {
    return handleControl(req, res, p, u);
  }

  if (p === '/api/status') {
    touch(req, u);
    const d = getClientTrack();
    const noticeHtml = formatNoticeHtml(noticeData.text);
    if (!d) {
      return sendJson(res, 200, {
        playing: false, buffering: true,
        listeners: activeCount(),
        notice: noticeHtml,
      });
    }
    return sendJson(res, 200, {
      playing: true,
      buffering: false,
      listeners: activeCount(),
      elapsed: Math.max(0, Math.floor(d.elapsed)),
      track: d.entry.track,
      notice: noticeHtml,
    });
  }

  if (p.startsWith('/stream/')) {
    const rel = p.slice('/stream/'.length);
    if (!rel || rel.includes('..') || rel.includes('/')) return sendText(res, 400, 'text/plain', 'bad');
    const file = path.join(CFG.hlsDir, rel);
    const ext = path.extname(file).toLowerCase();
    return sendFile(res, file, MIME[ext] || 'application/octet-stream');
  }

  if (p.startsWith('/cover/')) {
    const id = p.slice('/cover/'.length);
    const t = findTrack(id);
    if (!t) return sendText(res, 404, 'text/plain', 'no track');
    const c = await getCover(t);
    if (!c) return sendText(res, 404, 'text/plain', 'no cover');
    head(res, 200, 'image/jpeg');
    return res.end(c.buf);
  }

  if (p.startsWith('/lyrics/')) {
    const id = p.slice('/lyrics/'.length);
    const t = findTrack(id);
    if (!t) return sendText(res, 200, 'text/plain; charset=utf-8', '');
    const text = await getLyrics(t);
    return sendText(res, 200, 'text/plain; charset=utf-8', text);
  }

  if (p.startsWith('/static/')) {
    const rel = p.slice('/static/'.length);
    if (rel.includes('..')) return sendText(res, 400, 'text/plain', 'bad');
    const file = path.join(CFG.publicDir, rel);
    const ext = path.extname(file).toLowerCase();
    return sendFile(res, file, MIME[ext] || 'application/octet-stream');
  }

  if (p !== '/' && p !== '/index.html' &&
      /\.(png|jpe?g|gif|svg|ico|webp|css|js|woff2?|ttf|otf|json|txt|map)$/i.test(p)) {
    const rel = p.replace(/^\/+/, '');
    if (rel.includes('..')) return sendText(res, 400, 'text/plain', 'bad');
    const file = path.join(CFG.publicDir, rel);
    const ext = path.extname(file).toLowerCase();
    return sendFile(res, file, MIME[ext] || 'application/octet-stream');
  }

  if (p === '/' || p === '/index.html') {
    return sendFile(res, path.join(CFG.publicDir, 'index.html'), MIME['.html']);
  }

  sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
});

(function main() {
  if (!fs.existsSync(CFG.ffmpegPath)) {
    console.error('[fatal] ffmpeg 不存在: ' + CFG.ffmpegPath);
    process.exit(1);
  }
  if (!fs.existsSync(CFG.ffprobePath)) {
    console.error('[fatal] ffprobe 不存在: ' + CFG.ffprobePath);
    process.exit(1);
  }

  fs.mkdirSync(CFG.hlsDir, { recursive: true });
  fs.mkdirSync(CFG.musicDir, { recursive: true });
  fs.mkdirSync(CFG.publicDir, { recursive: true });

  for (const f of fs.readdirSync(CFG.hlsDir)) {
    try { fs.unlinkSync(path.join(CFG.hlsDir, f)); } catch (e) {}
  }

  loadNotice();

  ensureFifo();
  mainFF = startMainFFmpeg();
  openFifoWriter();

  setTimeout(() => {
    reloadLibrary().then(() => {
      feedNext();
      setInterval(() => reloadLibrary().catch(() => {}), 300000);
      server.listen(CFG.port, '0.0.0.0', () => {
        console.log('[cfg] ffmpeg      = ' + CFG.ffmpegPath);
        console.log('[cfg] ffprobe     = ' + CFG.ffprobePath);
        console.log('[cfg] music       = ' + CFG.musicDir);
        console.log('[cfg] hls         = ' + CFG.hlsDir);
        console.log('[cfg] public      = ' + CFG.publicDir);
        console.log('[cfg] fifo        = ' + CFG.fifoPath);
        console.log('[cfg] notice      = ' + CFG.noticePath);
        console.log('[cfg] hlsTime     = ' + CFG.hlsTime);
        console.log('[cfg] hlsListSize = ' + CFG.hlsListSize);
        console.log('[cfg] streamDelay = ' + CFG.streamDelay);
        if (CTRL_BASE) console.log('[cfg] control     = ' + CTRL_BASE);
        else console.log('[cfg] control     = 已禁用');
        console.log('[radio] http://0.0.0.0:' + CFG.port);
      });
    }).catch(err => {
      console.error('[fatal] 初始化失败:', err);
      process.exit(1);
    });
  }, 800);
})();
