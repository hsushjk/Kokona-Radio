'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.stack || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.stack || e));

const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')); }
  catch (e) { return { version: '0.0.0' }; }
})();

const CFG_FILE = process.env.RADIO_CONFIG || path.join(__dirname, 'config.json');
if (!fs.existsSync(CFG_FILE)) {
  console.warn('[warn] 未找到配置文件：' + CFG_FILE);
  console.warn('[warn] 正在使用内置默认值。请执行 cp config.example.json config.json 后修改。');
}

const CFG = Object.assign({
  port: 3000,
  musicDir: 'music',
  hlsDir: 'hls',
  publicDir: 'public',
  cachePath: 'cache.json',
  fifoPath: '.radio-pcm.fifo',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  bitrate: '192k',
  sampleRate: 44100,
  hlsTime: 2,
  hlsListSize: 6,
  shuffle: true,

  streamDelay: 1,

  liveSyncDurationCount: 2,
  hlsStartNumberSource: 'epoch',
  scanInterval: 300000,
  coverMaxWidth: 512,
  coverCacheEntries: 64,
  coverCacheBytes: 32 * 1024 * 1024,
  coverTimeoutMs: 8000,

  loudnessEnabled: true,
  loudnessTarget: -16,
  loudnessMaxGain: 12,

  playlistCacheMs: 250,
  controlPath: 'ctrl',
  controlToken: '',
  noticePath: 'notice.json',
}, (() => {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch (e) { return {}; }
})());

function abs(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;

  if (p === CFG.ffmpegPath || p === CFG.ffprobePath) {
    if (!p.includes('/') && !p.includes('\\')) return p;
  }
  return path.join(__dirname, p);
}
CFG.musicDir    = abs(CFG.musicDir);
CFG.hlsDir      = abs(CFG.hlsDir);
CFG.publicDir   = abs(CFG.publicDir);
CFG.ffmpegPath  = abs(CFG.ffmpegPath);
CFG.ffprobePath = abs(CFG.ffprobePath);
CFG.noticePath  = abs(CFG.noticePath);
CFG.cachePath   = abs(CFG.cachePath);
CFG.fifoPath    = abs(CFG.fifoPath);

function ensureDirOf(file) {
  const dir = path.dirname(file);
  if (!dir || dir === '.') return;
  if (fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[dir] 已创建 ' + dir);
  } catch (e) {
    console.error('[dir] 创建失败 ' + dir + '：' + e.message);
  }
}

function ensureFile(file, initial) {
  if (fs.existsSync(file)) return;
  try {
    fs.writeFileSync(file, initial, 'utf8');
    console.log('[file] 已创建 ' + file);
  } catch (e) {
    console.error('[file] 创建失败 ' + file + '：' + e.message);
  }
}

ensureDirOf(CFG.cachePath);
ensureDirOf(CFG.noticePath);

if (!CFG.controlPath || !/^[a-zA-Z0-9_-]{1,64}$/.test(CFG.controlPath)) {
  CFG.controlPath = '';
}
if (CFG.controlToken && CFG.controlToken.length < 16) {
  console.warn('[warn] controlToken 长度小于 16，建议更换');
  CFG.controlToken = '';
}
if (!CFG.controlToken) {
  console.warn('[warn] controlToken 未配置或长度不足，控制面板已禁用');
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
    ensureDirOf(CFG.noticePath);
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

const AUDIO_RE = /\.(mp3|flac|m4a|mp4|wav|ogg|oga|opus|aac|wma|aiff?|ape)$/i;

async function scanFiles() {
  const out = [];
  const stack = [CFG.musicDir];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(p); continue; }
      if (!AUDIO_RE.test(ent.name)) continue;
      if (ent.isFile()) { out.push(p); continue; }

      try { if ((await fs.promises.stat(p)).isFile()) out.push(p); } catch (e) {}
    }
  }
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
      '-hide_banner', '-loglevel', 'error',
      '-i', file, '-an',
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', 'scale=' + CFG.coverMaxWidth + ':-2',
      '-c:v', 'mjpeg', '-f', 'mjpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let done = false;
    const finish = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch (e) {}
      resolve(buf);
    };
    const timer = setTimeout(() => finish(null), CFG.coverTimeoutMs);
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => finish(null));
    p.on('close', () => finish(chunks.length ? Buffer.concat(chunks) : null));
  });
}

function extractBlurCover(file) {
  return new Promise((resolve) => {
    const p = spawn(CFG.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', file, '-an',
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,gblur=sigma=30',
      '-q:v', '3',
      '-c:v', 'mjpeg', '-f', 'mjpeg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let done = false;
    const finish = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch (e) {}
      resolve(buf);
    };
    const timer = setTimeout(() => finish(null), CFG.coverTimeoutMs);
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', () => finish(null));
    p.on('close', () => finish(chunks.length ? Buffer.concat(chunks) : null));
  });
}

function loudnessGain(rawI, rawTp, target, maxGain) {
  const parseLvl = (m) => {
    if (m == null) return NaN;
    const v = String(m).toLowerCase();
    if (v.indexOf('inf') >= 0) return v.charAt(0) === '-' ? -Infinity : Infinity;
    return parseFloat(v);
  };
  const inputI = parseLvl(rawI);
  const inputTp = parseLvl(rawTp);

  if (!Number.isFinite(inputI) || inputI <= -70) return 0;
  const cap = Math.abs(Number(maxGain) || 12);
  let gain = (Number(target) || 0) - inputI;

  if (Number.isFinite(inputTp)) {
    const peakLimit = -1.0 - inputTp;
    if (gain > peakLimit) gain = peakLimit;
  }
  if (!Number.isFinite(gain)) gain = 0;
  if (gain > cap) gain = cap;
  if (gain < -cap) gain = -cap;

  return Math.round(gain * 10) / 10;
}

const loudProcs = new Set();

function measureLoudness(file, timeoutMs) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'info',
      '-threads', '1',
      '-i', file,
      '-vn',
      '-af', 'loudnorm=I=' + CFG.loudnessTarget + ':TP=-1.5:print_format=json',
      '-f', 'null', '-',
    ];

    const onLinux = process.platform === 'linux';
    const p = spawn(onLinux ? 'nice' : CFG.ffmpegPath,
      onLinux ? ['-n', '19', CFG.ffmpegPath].concat(args) : args,
      { stdio: ['ignore', 'ignore', 'pipe'] });

    loudProcs.add(p);
    p.on('close', () => loudProcs.delete(p));
    p.on('error', () => loudProcs.delete(p));
    let err = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch (e) {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs || 180000);
    p.stderr.on('data', d => {
      err += d.toString();
      if (err.length > 131072) err = err.slice(-65536);
    });
    p.on('error', () => finish(null));
    p.on('close', () => {
      const mi = err.match(/"input_i"\s*:\s*"([-+]?\d*\.?\d+|[-+]?inf)"/i);
      const mt = err.match(/"input_tp"\s*:\s*"([-+]?\d*\.?\d+|[-+]?inf)"/i);
      finish(loudnessGain(mi && mi[1], mt && mt[1], CFG.loudnessTarget, CFG.loudnessMaxGain));
    });
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
    if (await exists(stem + '.lrc')) lyricsPath = stem + '.lrc';
  }

  return { id, file, title, artist, album, duration, hasCover, lyricsInline, lyricsPath };
}

async function exists(p) {
  try { await fs.promises.access(p); return true; } catch (e) { return false; }
}

let metaCache = new Map();
let metaCacheDirty = false;
let metaCacheTimer = null;

function loadMetaCache() {
  let raw;
  try { raw = fs.readFileSync(CFG.cachePath, 'utf8'); } catch (e) { return; }
  try {
    const j = JSON.parse(raw);
    const src = (j && typeof j === 'object' && j.files) ? j.files : j;
    metaCache = new Map(Object.keys(src || {}).map(k => [k, src[k]]));
    console.log('[cache] loaded ' + metaCache.size + ' entries');
  } catch (e) {
    console.warn('[cache] cache.json 解析失败，忽略：' + e.message);
  }
}

function scheduleCacheSave(delay) {
  metaCacheDirty = true;
  if (metaCacheTimer) return;
  metaCacheTimer = setTimeout(() => {
    metaCacheTimer = null;

    saveMetaCache().catch(e => console.error('[cache] ' + e.message));
  }, delay || 5000);
}

let cacheSaving = false;

async function saveMetaCache() {
  if (!metaCacheDirty || cacheSaving) return;
  cacheSaving = true;
  const files = {};
  for (const [k, v] of metaCache) files[k] = v;
  const body = JSON.stringify({ version: 1, files });
  const tmp = CFG.cachePath + '.tmp';
  try {
    await fs.promises.mkdir(path.dirname(CFG.cachePath), { recursive: true });
    await fs.promises.writeFile(tmp, body, 'utf8');
    await fs.promises.rename(tmp, CFG.cachePath);
    metaCacheDirty = false;
  } catch (e) {
    console.error('[cache] 写入失败：' + e.message);

    fs.promises.unlink(tmp).catch(() => {});
  } finally {
    cacheSaving = false;
  }
}

let tracks = [];
let tracksById = new Map();

let libState = { scanning: false, scanned: 0, total: 0, lastScanAt: 0, lastError: '' };

async function reloadLibrary() {
  if (libState.scanning) return;
  libState = { scanning: true, scanned: 0, total: 0, lastScanAt: libState.lastScanAt, lastError: '' };
  try {
    loadNotice();
    const files = await scanFiles();
    libState.total = files.length;

    const nextCache = new Map();
    const infos = new Array(files.length);
    const LIMIT = Math.max(2, (os.cpus().length || 2) * 2);
    let done = 0;

    for (let i = 0; i < files.length; i += LIMIT) {
      const slice = files.slice(i, i + LIMIT);
      const part = await Promise.all(slice.map(async (f) => {
        let st;
        try { st = await fs.promises.stat(f); } catch (e) { return null; }
        const key = f + '|' + Math.floor(st.mtimeMs) + '|' + st.size;
        const hit = metaCache.get(key);
        if (hit) {
          nextCache.set(key, hit);
          done++;

          return Object.assign({}, hit, { id: idOf(f), file: f });
        }
        try {
          const t = await buildTrack(f);

          nextCache.set(key, {
            title: t.title, artist: t.artist, album: t.album,
            duration: t.duration, hasCover: t.hasCover,
            lyricsInline: t.lyricsInline, lyricsPath: t.lyricsPath,
          });
          return t;
        } catch (e) {
          return null;
        } finally {
          done++;
        }
      }));
      for (let j = 0; j < part.length; j++) infos[i + j] = part[j];
      libState.scanned = done;

      await new Promise(r => setImmediate(r));
    }

    const built = infos.filter(Boolean);
    metaCache = nextCache;
    scheduleCacheSave(5000);

    const byId = new Map(built.map(t => [t.id, t]));
    tracks = built;
    tracksById = byId;
    for (let i = 0; i < queue.length; i++) {
      const t = byId.get(queue[i].id);
      if (t) queue[i] = t;
    }
    const cur = current && byId.get(current.id);
    if (cur) current = cur;
    libState.lastScanAt = Date.now();

    lyricsCache.clear();
    console.log('[library] ' + tracks.length + ' tracks' +
      (files.length !== built.length ? ' (' + (files.length - built.length) + ' 个文件无法解析)' : ''));
  } catch (e) {
    libState.lastError = e.message;
    console.error('[library] 扫描失败：' + e.message);
  } finally {
    libState.scanning = false;
  }

  loudnessScanPass();
}

let loudRunning = false;
const loudState = { active: false, done: 0, total: 0, lastAt: 0 };

async function loudnessScanPass() {
  if (loudRunning || !CFG.loudnessEnabled) return;
  if (!tracks.length) return;
  loudRunning = true;
  loudState.active = true;
  try {
    const todo = tracks.filter(t => t && typeof t.loudGain !== 'number');
    loudState.total = todo.length;
    loudState.done = 0;
    if (todo.length) console.log('[loudness] 需要补测 ' + todo.length + ' 首');
    for (const t of todo) {
      if (!CFG.loudnessEnabled) break;
      let gain = null;
      try {
        await fs.promises.access(t.file);
        gain = await measureLoudness(t.file);
      } catch (e) {
        gain = null;
      }
      loudState.done++;
      loudState.lastAt = Date.now();

      t.loudGain = gain == null ? 0 : gain;
      try {
        const st = await fs.promises.stat(t.file);
        const key = t.file + '|' + Math.floor(st.mtimeMs) + '|' + st.size;
        const hit = metaCache.get(key);
        if (hit) hit.loudGain = t.loudGain;
      } catch (e) {}
      scheduleCacheSave(3000);

      await new Promise(r => setTimeout(r, 800));
    }
    if (loudState.total) console.log('[loudness] 补测完成 ' + loudState.done + '/' + loudState.total);
  } catch (e) {
    console.error('[loudness] ' + e.message);
  } finally {
    loudRunning = false;
    loudState.active = false;
  }
}

const coverCache = new Map();
let coverBytes = 0;
let coverPinnedBytes = 0;
let coverPinnedId = null;
let coverPending = new Map();

function coverTouch(id) {
  const v = coverCache.get(id);
  if (v === undefined) return undefined;
  coverCache.delete(id);
  coverCache.set(id, v);
  return v;
}

function pinCover(id) {
  if (coverPinnedId === id) return;
  coverPinnedId = id;
  const v = coverCache.get(id);
  coverPinnedBytes = (v && v.buf) ? v.buf.length : 0;
  coverEvict();
}

function coverEvict() {
  const maxEntries = Math.max(1, CFG.coverCacheEntries | 0);
  while (coverCache.size > maxEntries ||
         (coverBytes - coverPinnedBytes) > CFG.coverCacheBytes) {

    let victim = null;
    for (const k of coverCache.keys()) {
      if (k !== coverPinnedId) { victim = k; break; }
    }
    if (victim === null) break;
    const v = coverCache.get(victim);
    if (v && v.buf) coverBytes -= v.buf.length;
    coverCache.delete(victim);
  }

  const p = coverPinnedId ? coverCache.get(coverPinnedId) : null;
  coverPinnedBytes = (p && p.buf) ? p.buf.length : 0;
}

async function getCover(track) {
  const hit = coverTouch(track.id);
  if (hit !== undefined) return hit;
  if (!track.hasCover) {
    coverCache.set(track.id, null);
    coverEvict();
    return null;
  }
  if (coverPending.has(track.id)) return coverPending.get(track.id);

  const job = (async () => {
    const buf = await extractCover(track.file);
    const entry = buf ? { buf } : null;
    coverCache.set(track.id, entry);
    if (entry) coverBytes += buf.length;
    coverEvict();
    return entry;
  })();

  coverPending.set(track.id, job);
  try {
    return await job;
  } catch (e) {
    console.error('[cover] ' + e.message);
    return null;
  } finally {
    coverPending.delete(track.id);
  }
}

const blurCache = new Map();
const blurPending = new Map();
const BLUR_CACHE_ENTRIES = 128;

function blurEvict() {
  while (blurCache.size > BLUR_CACHE_ENTRIES) {
    const k = blurCache.keys().next().value;
    blurCache.delete(k);
  }
}

async function getBlurCover(track) {
  if (blurCache.has(track.id)) {
    const v = blurCache.get(track.id);
    blurCache.delete(track.id);
    blurCache.set(track.id, v);
    return v;
  }
  if (blurPending.has(track.id)) return blurPending.get(track.id);
  const job = (async () => {
    let buf = null;

    try { buf = await extractBlurCover(track.file); } catch (e) { buf = null; }
    blurCache.set(track.id, buf);
    blurEvict();
    return buf;
  })();
  blurPending.set(track.id, job);
  try {
    return await job;
  } finally {
    blurPending.delete(track.id);
  }
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
let mainFfBackoff = 0;

let statFfmpegRestarts = 0;
let statWriteStalls = 0;
let statLastStallMs = 0;
const STALL_WARN_MS = 500;
let fifoWriter = null;
let restartTimer = null;
let shutdown = false;

function ensureFifo() {
  if (process.platform !== 'linux') {
    console.error('[fatal] 命名管道（FIFO）依赖 mkfifo，本项目只支持 Linux。');
    console.error('[fatal] 当前平台：' + process.platform + '。Windows / macOS 请用 Linux 服务器（VPS 或 WSL2）运行。');
    process.exit(1);
  }
  try { fs.unlinkSync(CFG.fifoPath); } catch (e) {}
  try {
    execFileSync('mkfifo', [CFG.fifoPath]);
  } catch (e) {
    console.error('[fatal] mkfifo 失败：' + e.message);
    process.exit(1);
  }
  console.log('[fifo] created ' + CFG.fifoPath);
}

function shiftFeedTimeline(gapMs) {
  if (!gapMs || gapMs <= 0) return;
  for (const e of feedTimeline) e.t += gapMs;
  console.log('[timeline] shifted +' + Math.round(gapMs) + 'ms after main ffmpeg restart');
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

    '-hls_flags', 'delete_segments+omit_endlist+independent_segments+temp_file+program_date_time',

    '-hls_start_number_source', String(CFG.hlsStartNumberSource || 'epoch'),
    '-hls_segment_filename', path.join(CFG.hlsDir, 's_%06d.ts'),
    path.join(CFG.hlsDir, 'stream.m3u8'),
  ];
  const proc = spawn(CFG.ffmpegPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.startedAt = Date.now();
  proc.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) console.error('[main-ffmpeg] ' + s);
  });
  proc.on('error', err => console.error('[main-ffmpeg spawn error]', err.message));
  proc.on('exit', (code, sig) => {
    console.error('[main-ffmpeg] exit code=' + code + ' sig=' + sig);
    if (mainFF === proc) mainFF = null;
    if (shutdown) return;
    statFfmpegRestarts++;

    shiftFeedTimeline(Date.now() - proc.startedAt);
    if (restartTimer) clearTimeout(restartTimer);

    if (Date.now() - proc.startedAt > 10000) mainFfBackoff = 0;
    mainFfBackoff = Math.min(mainFfBackoff ? mainFfBackoff * 2 : 1500, 30000);
    if (mainFfBackoff > 1500) {
      console.error('[main-ffmpeg] 连续退出，' + mainFfBackoff + 'ms 后重启');
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (shutdown) return;
      openFifoWriter();
      mainFF = startMainFFmpeg();
    }, mainFfBackoff);
  });
  return proc;
}

function openFifoWriter() {
  if (fifoWriter) {
    const old = fifoWriter;
    try { old.destroy(); } catch (e) {}
    fifoWriter = null;
  }
  const ws = fs.createWriteStream(CFG.fifoPath, { flags: 'w' });
  ws.on('error', err => {
    console.error('[fifo write] error:', err.message);
    if (fifoWriter === ws && !shutdown) {
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
  pinCover(track.id);

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

  const decArgs = [
    '-hide_banner', '-loglevel', 'error',
    '-threads', '1',
    '-re',
    '-i', track.file,
    '-vn',
  ];
  const lg = Number(track.loudGain);
  if (Number.isFinite(lg) && Math.abs(lg) >= 0.1) {
    decArgs.push('-af', 'volume=' + lg.toFixed(1) + 'dB');
  }
  decArgs.push(
    '-f', 's16le',
    '-ar', String(CFG.sampleRate),
    '-ac', '2',
    '-threads', '1',
    'pipe:1'
  );
  const dec = spawn(CFG.ffmpegPath, decArgs);
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

  let waitingForWriter = null;

  dec.stdout.on('data', chunk => {
    if (myId !== switchId) return;
    const w = fifoWriter;
    if (!w || w.destroyed) {
      try { dec.kill('SIGKILL'); } catch (e) {}
      return;
    }
    if (w !== waitingForWriter) waitingForWriter = null;
    const ok = w.write(chunk);
    if (!ok) {
      dec.stdout.pause();
      waitingForWriter = w;
      const stallAt = Date.now();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(guard);

        const stallMs = Date.now() - stallAt;
        statLastStallMs = stallMs;
        if (stallMs >= STALL_WARN_MS) statWriteStalls++;
        if (waitingForWriter === w) waitingForWriter = null;
        try { dec.stdout.resume(); } catch (e) {}
      };
      w.once('drain', release);

      const guard = setTimeout(() => {
        if (fifoWriter === w && !w.destroyed) return;
        release();
      }, 1000);
    }
  });
  dec.stdout.on('end', () => onEnd(null));
  dec.on('exit', (code, sig) => {
    if (myId !== switchId) return;
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

const PLAYLIST_PATH = () => path.join(CFG.hlsDir, 'stream.m3u8');

let plCache = null;
let plCacheAt = 0;
const PL_CACHE_MS = 500;

function parsePlaylist(text) {
  if (!text) return null;
  const lines = text.split('\n');
  let targetDur = 0;
  let lastSegStart = null;
  let lastSegDur = 0;

  let pendDur = null;
  let pendPdt = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (ln.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDur = parseFloat(ln.slice(22)) || 0;
    } else if (ln.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const ms = Date.parse(ln.slice(25));
      if (!isNaN(ms)) pendPdt = ms;
    } else if (ln.startsWith('#EXTINF:')) {
      pendDur = parseFloat(ln.slice(8)) || 0;
    } else if (ln.charAt(0) !== '#') {

      if (pendDur != null) {

        const start = pendPdt != null
          ? pendPdt
          : (lastSegStart != null ? lastSegStart + lastSegDur * 1000 : null);
        if (start != null) { lastSegStart = start; lastSegDur = pendDur; }
      }
      pendDur = null;
      pendPdt = null;
    }
  }
  if (lastSegStart == null) return null;
  return { lastSegStart, lastSegDur, targetDur };
}

function readPlaylist(now) {
  if (plCache && now - plCacheAt < PL_CACHE_MS) return plCache;
  let txt = null;
  try {
    txt = fs.readFileSync(PLAYLIST_PATH(), 'utf8');
  } catch (e) {

    return plCache;
  }
  const parsed = parsePlaylist(txt);
  if (parsed) { plCache = parsed; plCacheAt = now; }
  return plCache;
}

const SEG_POLL_MS = 250;
const TRACK_START_LATENCY_MS = 280;

const driftSamples = [];
let driftLastSig = null;
let driftMs = null;

const clientReports = [];

function medianOf(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function noteSegmentClosed() {
  const now = Date.now();
  const pl = readPlaylist(now);
  if (!pl) return;

  const sig = pl.lastSegStart;
  if (sig === driftLastSig) return;
  driftLastSig = sig;
  const segDur = pl.lastSegDur || CFG.hlsTime || 2;

  const edgePdt = pl.lastSegStart + segDur * 1000;
  const sample = edgePdt - now;

  if (sample > -SEG_POLL_MS * 2 && sample < 30000) {
    driftSamples.push(sample);
    if (driftSamples.length > 60) driftSamples.shift();
    driftMs = medianOf(driftSamples);
  }
}

setInterval(noteSegmentClosed, SEG_POLL_MS).unref();

function feedClockOffset() {
  return driftMs == null ? 0 : driftMs;
}

function getClientTrack() {
  if (feedTimeline.length === 0) return null;
  const now = Date.now();
  const drift = feedClockOffset();
  const count = Number(CFG.liveSyncDurationCount) > 0 ? Number(CFG.liveSyncDurationCount) : 2;

  let cutoff = now - CFG.streamDelay * 1000;
  const dbg = { now, mode: 'fallback', streamDelay: CFG.streamDelay || 0, driftMs: drift };

  const pl = readPlaylist(now);
  if (pl) {
    const segDur = pl.lastSegDur || CFG.hlsTime || 2;

    const tDur = pl.targetDur > 0 ? pl.targetDur : segDur;
    const fresh = now
      - count * tDur * 1000
      - segDur * 500
      - (CFG.streamDelay || 0) * 1000;
    if (fresh > 0 && fresh <= now && fresh >= now - 600000) {
      cutoff = fresh;
      dbg.mode = 'smooth';
      dbg.segDur = segDur;
      dbg.targetDur = tDur;
      dbg.leadMs = now - fresh;

      dbg.edgeLagMs = pl.lastSegStart + segDur * 1000 - now;
    }
  }

  let chosen = null;
  for (let i = feedTimeline.length - 1; i >= 0; i--) {
    if (feedTimeline[i].t + TRACK_START_LATENCY_MS <= cutoff) { chosen = feedTimeline[i]; break; }
  }
  if (!chosen) {
    const first = feedTimeline[0];
    return { entry: first, elapsed: 0, dbg, originPdt: first.t + drift + TRACK_START_LATENCY_MS };
  }
  dbg.cutoff = cutoff;
  dbg.chosenT = chosen.t;
  dbg.cutoffMinusChosen = cutoff - chosen.t;
  return {
    entry: chosen,

    elapsed: Math.max(0, (cutoff - chosen.t - TRACK_START_LATENCY_MS) / 1000),
    dbg,

    originPdt: chosen.t + drift + TRACK_START_LATENCY_MS,
  };
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

const STATE_PAGE_DEFAULT = 50;
const STATE_PAGE_MAX = 500;

function pageParam(url, name, def, max) {
  const raw = url && url.searchParams.get(name);
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n < 0) return def;
  return Math.min(n, max);
}

function healthSnapshot() {
  const mem = process.memoryUsage();
  return {
    ok: true,
    healthy: !!mainFF,
    uptime: Math.round(process.uptime()),
    mainFfmpeg: !!mainFF,
    ffmpegRestarts: statFfmpegRestarts,
    writeStalls: statWriteStalls,
    lastStallMs: statLastStallMs,
    librarySize: tracks.length,
    listeners: getUserList().length,
    current: current ? current.id : null,
    rssMB: Math.round(mem.rss / 1048576),
    loudness: { active: loudState.active, done: loudState.done, total: loudState.total },
  };
}

function buildState(url) {
  const d = getClientTrack();
  const pageSize = Math.max(1, pageParam(url, 'limit', STATE_PAGE_DEFAULT, STATE_PAGE_MAX));
  const qOff = pageParam(url, 'qOffset', 0, Number.MAX_SAFE_INTEGER);
  const hOff = pageParam(url, 'hOffset', 0, Number.MAX_SAFE_INTEGER);

  const slim = t => ({ id: t.id, title: t.title, artist: t.artist });

  const hist = playHistory.slice().reverse();
  const queuePage = queue.slice(qOff, qOff + pageSize).map(slim);
  const histPage = hist.slice(hOff, hOff + pageSize).map(slim);
  const listeners = getUserList();

  return {
    ok: true,
    current: current ? {
      id: current.id, title: current.title, artist: current.artist, duration: current.duration,
    } : null,
    clientTrack: d ? {
      title: d.entry.track.title, artist: d.entry.track.artist, elapsed: Math.max(0, Math.floor(d.elapsed)),
    } : null,
    queue: queuePage,
    queueTotal: queue.length,
    queueOffset: qOff,
    history: histPage,
    historyTotal: hist.length,
    historyOffset: hOff,
    listeners: listeners,
    pageSize: pageSize,
    librarySize: tracks.length,
    scanning: libState.scanning,
    notice: noticeData.text,
    noticeUpdatedAt: noticeData.updatedAt,
    health: healthSnapshot(),
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
.health{margin-bottom:16px;padding:12px 14px;background:#131316;border:1px solid #1e1e22;border-radius:6px;font-size:12px;color:#888;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center}
.health .k{color:#555;margin-right:5px}
.health .v{color:#ddd}
.health .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}
.health .dot.on{background:#4c9}
.health .dot.off{background:#e53}
.health .spacer{flex:1;min-width:8px}
.health button{padding:3px 10px;font-size:11px}
.health .bar{display:inline-block;width:64px;height:5px;background:#242429;border-radius:3px;overflow:hidden;vertical-align:middle;margin-left:7px}
.health .bar i{display:block;height:100%;background:#4c9}
.health-raw{margin:-8px 0 16px;padding:12px 14px;background:#101013;border:1px solid #1e1e22;border-radius:6px;color:#8fbfa8;font:11px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
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
<div class="health" id="health"></div>
<pre class="health-raw" id="healthRaw" hidden></pre>
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
var listEl=$(name);
var pagerEl=$(name+'Pager');
var countEl=$(name+'Count');

if(name==='listeners'){
var ltotal=dataCache.listeners.length;
if(!ltotal)listEl.innerHTML='<div class="empty">空</div>';
else listEl.innerHTML=renderItems('listeners',dataCache.listeners);
if(countEl)countEl.textContent=ltotal+' 人';
pagerEl.innerHTML='';
return;
}

var items=dataCache[name]||[];
var total=dataCache[name+'Total']||0;
var pages=Math.max(1,Math.ceil(total/pageSize));
if(pageState[name]>pages)pageState[name]=pages;
if(pageState[name]<1)pageState[name]=1;
if(!items.length)listEl.innerHTML='<div class="empty">空</div>';
else listEl.innerHTML=renderItems(name,items);
if(countEl)countEl.textContent=total+' 条';
if(pages<=1){pagerEl.innerHTML='';return}
pagerEl.innerHTML=
'<button data-name="'+name+'" data-page="'+(pageState[name]-1)+'"'+(pageState[name]<=1?' disabled':'')+'>上一页</button>'+
'<span class="num">'+pageState[name]+' / '+pages+'</span>'+
'<button data-name="'+name+'" data-page="'+(pageState[name]+1)+'"'+(pageState[name]>=pages?' disabled':'')+'>下一页</button>';
}

var rawOpen=false;

function fmtUptime(s){
s=Math.max(0,Math.floor(s||0));
var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
if(d)return d+' 天 '+h+' 小时';
if(h)return h+' 小时 '+m+' 分';
if(m)return m+' 分';
return s+' 秒';
}

function renderHealth(h){
var el=$('health');
if(!h){el.innerHTML='<span class="v" style="color:#555">无健康数据</span>';return}
var ok=!!h.mainFfmpeg;
var lo=h.loudness||{};
var p=[];
p.push('<span><span class="dot '+(ok?'on':'off')+'"></span><span class="k">主编码器</span><span class="v">'+(ok?'正常':'已停')+'</span></span>');
p.push('<span><span class="k">运行</span><span class="v">'+esc(fmtUptime(h.uptime))+'</span></span>');
p.push('<span><span class="k">重启</span><span class="v">'+(h.ffmpegRestarts||0)+'</span></span>');
p.push('<span><span class="k">写阻塞</span><span class="v">'+(h.writeStalls||0)+(h.lastStallMs?' / '+h.lastStallMs+'ms':'')+'</span></span>');
p.push('<span><span class="k">内存</span><span class="v">'+(h.rssMB||0)+' MB</span></span>');
p.push('<span><span class="k">听众</span><span class="v">'+(h.listeners||0)+'</span></span>');
if(lo.total&&lo.done<lo.total){
var pct=Math.round(lo.done/lo.total*100);
p.push('<span><span class="k">响度补测</span><span class="v">'+lo.done+' / '+lo.total+'</span><span class="bar"><i style="width:'+pct+'%"></i></span></span>');
}else{
p.push('<span><span class="k">响度</span><span class="v">'+(lo.active?'进行中':'已完成')+'</span></span>');
}
p.push('<span class="spacer"></span><button id="rawToggle" type="button">'+(rawOpen?'收起 /healthz':'查看 /healthz')+'</button>');
el.innerHTML=p.join('');
}

async function toggleRaw(){
rawOpen=!rawOpen;
var pre=$('healthRaw');
if(!rawOpen){pre.hidden=true;refresh();return}
pre.hidden=false;
pre.textContent='拉取中…';
try{
var r=await fetch('/healthz',{cache:'no-store'});
if(!r.ok)throw new Error('HTTP '+r.status);
pre.textContent=JSON.stringify(await r.json(),null,2);
}catch(e){
pre.textContent='拉取 /healthz 失败：'+e.message;
}
refresh();
}

function render(st){
var now=st.clientTrack?(esc(st.clientTrack.title)+' <span class="a">'+esc(st.clientTrack.artist)+'</span>'):'<span style="color:#555">无</span>';
var srv=st.current?(esc(st.current.title)+' <span class="a">'+esc(st.current.artist)+'</span>'):'<span style="color:#555">无</span>';
var lib=st.librarySize||0;
if(st.scanning)lib+=' 首（扫描中）';else lib+=' 首';
$('status').innerHTML='听众：'+esc(st.listeners.length)+' ｜ 曲库：'+esc(lib)+' ｜ 服务端曲目：<span class="now">'+srv+'</span> ｜ 客户端正听：<span class="now">'+now+'</span>';
renderHealth(st.health);
dataCache.queue=st.queue||[];
dataCache.queueTotal=st.queueTotal||0;
dataCache.history=st.history||[];
dataCache.historyTotal=st.historyTotal||0;
dataCache.listeners=st.listeners||[];
renderPage('queue');
renderPage('history');
renderPage('listeners');
var ta=$('noticeText');
if(document.activeElement!==ta&&ta.value!==(st.notice||'')){
ta.value=st.notice||'';
}
}

function stateUrl(){
var q=(pageState.queue-1)*pageSize;
var h=(pageState.history-1)*pageSize;
return '/api/state?limit='+pageSize+'&qOffset='+Math.max(0,q)+'&hOffset='+Math.max(0,h);
}

async function refresh(){
try{
var s=await api(stateUrl());
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
if(t.id==='rawToggle'){toggleRaw();return}
if(t.tagName==='BUTTON'&&t.dataset&&t.dataset.name&&t.dataset.page){
pageState[t.dataset.name]=parseInt(t.dataset.page,10);
refresh();
}
});

$('pageSize').addEventListener('change',function(){
pageSize=parseInt(this.value,10);
pageState={queue:1,history:1,listeners:1};
try{localStorage.setItem('radio_ctrl_pagesize',String(pageSize))}catch(e){}
refresh();
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

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'no-cache';
const CACHE_COVER = 'public, max-age=86400';

function head(res, code, type, cacheControl, extraHeaders) {
  const headers = {
    'Content-Type': type || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheControl || CACHE_REVALIDATE,
  };
  if (extraHeaders) {
    for (const k of Object.keys(extraHeaders)) {
      if (extraHeaders[k] !== undefined && extraHeaders[k] !== null) headers[k] = extraHeaders[k];
    }
  }
  res.writeHead(code, headers);
  return headers;
}
function sendText(res, code, type, body, cacheControl) {
  head(res, code, type, cacheControl);
  res.end(body);
}
function sendJson(res, code, obj) {
  sendText(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

function etagOf(buf) {
  return '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
}
function notModified(req, etag) {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;

  return inm.split(',').some(v => v.trim() === etag);
}

function sendFile(req, res, file, type, cacheControl) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    if (notModified(req, etag)) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': cacheControl || CACHE_REVALIDATE,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': st.size,
      'ETag': etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'Cache-Control': cacheControl || CACHE_REVALIDATE,
      'Access-Control-Allow-Origin': '*',
    });
    const rs = fs.createReadStream(file);
    rs.on('error', () => { try { res.destroy(); } catch (e) {} });
    rs.pipe(res);
  });
}

function findTrack(id) {
  if (current && current.id === id) return current;
  for (const t of queue) if (t.id === id) return t;
  return tracksById.get(id) || null;
}

const hlsPlCache = new Map();
function sendPlaylist(req, res, file) {
  const ttl = Math.max(0, CFG.playlistCacheMs | 0);
  const serve = (buf, etag) => {
    if (notModified(req, etag)) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': CACHE_REVALIDATE,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end();
    }
    head(res, 200, 'application/vnd.apple.mpegurl', CACHE_REVALIDATE, {
      'ETag': etag,
      'Content-Length': String(buf.length),
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  };
  const hit = hlsPlCache.get(file);
  const now = Date.now();
  if (hit && now - hit.at <= ttl) return serve(hit.buf, hit.etag);
  return fs.promises.readFile(file).then(buf => {
    const etag = etagOf(buf);
    hlsPlCache.set(file, { at: Date.now(), buf: buf, etag: etag });
    if (hlsPlCache.size > 8) {
      for (const k of hlsPlCache.keys()) { if (k !== file) { hlsPlCache.delete(k); break; } }
    }
    serve(buf, etag);
  }).catch(() => sendText(res, 404, 'text/plain; charset=utf-8', 'not found'));
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
    return sendJson(res, 200, buildState(u));
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

  let u, p;
  try {
    u = new URL(req.url, 'http://x');
    p = decodeURIComponent(u.pathname);
  } catch (e) {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }

  if (p.includes('\0')) {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'bad request');
  }

  try {
    if (CTRL_BASE && (p === CTRL_BASE || p.startsWith(CTRL_BASE + '/'))) {
      return await handleControl(req, res, p, u);
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

        syncCount: Number(CFG.liveSyncDurationCount) > 0 ? Number(CFG.liveSyncDurationCount) : 2,

        originPdt: d.originPdt || 0,
        track: d.entry.track,
        notice: noticeHtml,
      });
    }

    if (p === '/status-json.xsl' || p === '/status-json') {
      const d = getClientTrack();

      const kbps = (String(CFG.bitrate || '192k').match(/^(\d+)/) || [0, 192])[1];
      const source = d && d.entry ? {
        audio_info: 'bitrate=' + kbps + ';samplerate=' + CFG.sampleRate + ';channels=2',
        bitrate: Number(kbps),
        genre: '',
        'ice-bitrate': Number(kbps),
        listener_peak: activeCount(),
        listeners: activeCount(),
        server_description: '',
        server_name: 'Kokona-Radio',
        server_type: 'audio/mpeg',
        server_url: '',
        source_ip: '127.0.0.1',
        stream_start: new Date(currentStart || Date.now()).toUTCString(),
        stream_start_iso8601: new Date(currentStart || Date.now()).toISOString(),
        title: (d.entry.track.artist ? d.entry.track.artist + ' - ' : '') + d.entry.track.title,
      } : null;
      return sendJson(res, 200, {
        icestats: {
          admin: 'Kokona-Radio',
          host: req.headers.host || '',
          location: '',
          server_id: 'Kokona-Radio',
          server_start: new Date(Date.now() - process.uptime() * 1000).toUTCString(),
          server_start_iso8601: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          source: source || [],
        },
      });
    }

    if (p === '/healthz') {
      return sendJson(res, 200, healthSnapshot());
    }

    if (p === '/api/debug') {
      const d = getClientTrack();
      return sendJson(res, 200, {
        serverNow: Date.now(),
        streamDelay: CFG.streamDelay || 0,
        syncCount: Number(CFG.liveSyncDurationCount) > 0 ? Number(CFG.liveSyncDurationCount) : 2,
        hlsTime: CFG.hlsTime,

        driftMs: driftMs == null ? null : Math.round(driftMs),
        driftSamples: driftSamples.length,
        driftSpreadMs: driftSamples.length > 1
          ? Math.round(Math.max(...driftSamples) - Math.min(...driftSamples))
          : null,
        lastDriftSig: driftLastSig,
        trackStartLatencyMs: TRACK_START_LATENCY_MS,

        dbg: (d && d.dbg) || null,
        elapsed: d ? Number(d.elapsed.toFixed(3)) : null,
        originPdt: (d && d.originPdt) || null,
        track: d ? d.entry.track : null,

        clientReports: clientReports.slice(-12),
      });
    }

    if (p === '/api/debug/report') {
      const num = k => {
        const v = Number(u.searchParams.get(k));
        return Number.isFinite(v) ? v : null;
      };
      clientReports.push({
        at: Date.now(),
        trackId: (u.searchParams.get('tid') || '').slice(0, 32),
        originPdt: num('org'),
        fragPdt: num('pdt'),
        fragStart: num('st'),
        currentTime: num('cur'),
        srvElapsed: num('se'),
        pdtElapsed: num('pe'),
        shownElapsed: num('sh'),
        audioLagMs: num('lag'),
        readyState: num('rs'),
      });
      if (clientReports.length > 60) clientReports.shift();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (p.startsWith('/stream/')) {
      const rel = p.slice('/stream/'.length);
      if (!rel || rel.includes('..') || rel.includes('/')) return sendText(res, 400, 'text/plain', 'bad');
      const file = path.join(CFG.hlsDir, rel);
      const ext = path.extname(file).toLowerCase();

      if (ext === '.m3u8') return sendPlaylist(req, res, file);
      return sendFile(req, res, file, MIME[ext] || 'application/octet-stream', CACHE_IMMUTABLE);
    }

    if (p.startsWith('/cover-blur/')) {
      const id = p.slice('/cover-blur/'.length);
      const t = findTrack(id);
      if (!t) return sendText(res, 404, 'text/plain', 'no track');
      const b = await getBlurCover(t);
      if (!b) return sendText(res, 404, 'text/plain', 'no cover');
      const btag = etagOf(b);
      if (notModified(req, btag)) {
        res.writeHead(304, {
          'ETag': btag,
          'Cache-Control': CACHE_COVER,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end();
      }
      head(res, 200, 'image/jpeg', CACHE_COVER,
        { 'ETag': btag, 'Content-Length': String(b.length) });
      return res.end(b);
    }

    if (p.startsWith('/cover/')) {
      const id = p.slice('/cover/'.length);
      const t = findTrack(id);
      if (!t) return sendText(res, 404, 'text/plain', 'no track');
      const c = await getCover(t);
      if (!c) return sendText(res, 404, 'text/plain', 'no cover');
      const etag = etagOf(c.buf);
      if (notModified(req, etag)) {
        res.writeHead(304, {
          'ETag': etag,
          'Cache-Control': CACHE_COVER,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end();
      }
      head(res, 200, 'image/jpeg', CACHE_COVER,
        { 'ETag': etag, 'Content-Length': String(c.buf.length) });
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
      return sendFile(req, res, file, MIME[ext] || 'application/octet-stream', CACHE_IMMUTABLE);
    }

    if (p !== '/' && p !== '/index.html' &&
        /\.(png|jpe?g|gif|svg|ico|webp|css|js|woff2?|ttf|otf|json|txt|map)$/i.test(p)) {
      const rel = p.replace(/^\/+/, '');
      if (rel.includes('..')) return sendText(res, 400, 'text/plain', 'bad');
      const file = path.join(CFG.publicDir, rel);
      const ext = path.extname(file).toLowerCase();

      const cc = /\.(json|txt)$/i.test(ext) ? CACHE_REVALIDATE : CACHE_IMMUTABLE;
      return sendFile(req, res, file, MIME[ext] || 'application/octet-stream', cc);
    }

    if (p === '/' || p === '/index.html') {
      return sendFile(req, res, path.join(CFG.publicDir, 'index.html'), MIME['.html'], CACHE_REVALIDATE);
    }

    sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
  } catch (e) {

    console.error('[http] ' + req.method + ' ' + p + ' -> ' + (e && e.stack || e));
    if (!res.headersSent) {
      try { sendText(res, 500, 'text/plain; charset=utf-8', 'server error'); } catch (e2) {}
    } else {
      try { res.destroy(); } catch (e2) {}
    }
  }
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

  ensureFile(CFG.noticePath, JSON.stringify({ text: '', updatedAt: 0 }, null, 2));
  ensureFile(CFG.cachePath, JSON.stringify({ version: 1, files: {} }));

  loadNotice();
  loadMetaCache();

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
  server.on('error', err => {
    console.error('[fatal] 监听 ' + CFG.port + ' 失败: ' + err.message);
    process.exit(1);
  });

  ensureFifo();
  mainFF = startMainFFmpeg();
  openFifoWriter();

  setTimeout(() => {
    reloadLibrary().then(() => {
      feedNext();
      setInterval(() => reloadLibrary().catch(() => {}), CFG.scanInterval).unref();
    }).catch(err => {
      console.error('[fatal] 初始化失败:', err);
      process.exit(1);
    });
  }, 800);
})();

function gracefulExit(sig) {
  if (shutdown) return;
  shutdown = true;
  console.log('[signal] ' + sig + ' received, shutting down');
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  try { if (currentDecoder) currentDecoder.kill('SIGTERM'); } catch (e) {}

  for (const p of loudProcs) { try { p.kill('SIGKILL'); } catch (e) {} }
  loudProcs.clear();
  try { if (mainFF) mainFF.kill('SIGTERM'); } catch (e) {}
  try { if (fifoWriter && !fifoWriter.destroyed) fifoWriter.end(); } catch (e) {}

  const saving = Promise.resolve(saveMetaCache()).catch(() => {});
  Promise.race([saving, new Promise(r => setTimeout(r, 800))]).then(() => {
    try { server.close(); } catch (e) {}

    setTimeout(() => {
      try { if (currentDecoder) currentDecoder.kill('SIGKILL'); } catch (e) {}
      try { if (mainFF) mainFF.kill('SIGKILL'); } catch (e) {}
      try {
        if (process.platform === 'linux' && fs.existsSync(CFG.fifoPath)) fs.unlinkSync(CFG.fifoPath);
      } catch (e) {}
      process.exit(0);
    }, 500);
  });
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));
