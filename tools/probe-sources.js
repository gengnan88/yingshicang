#!/usr/bin/env node
/**
 * 影视仓 Web 版 - 源全量探测工具（在目标网络环境运行，如路由器）
 *
 * 用法：node tools/probe-sources.js [--out /tmp/probe_full.json] [--concurrency 6]
 *
 * 阶段1：拉取全部源配置（内置 5 + 推荐单仓 33 + 推荐多仓 8 展开），
 *        收集去重后的 type=1 站点 API（jar/spider 跳过）
 * 阶段2：逐个探测站点：分类数 / 列表条数 / 搜索命中 / 播放地址可抽取性 / 响应耗时
 * 阶段3：探测 17 个推荐直播源：频道数 / 样本
 * 输出：完整结果 JSON + 控制台摘要 + 本地聚合源候选 local_candidate.json
 *
 * 探测用的就是 app 同款解析内核（core/sites.js + core/cms.js）与浏览器 UA，
 * 结果与网页端实际体验一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL, domainToASCII } = require('url');

const Sites = require(path.join(__dirname, '..', 'public', 'core', 'sites.js'));
const CmsApi = require(path.join(__dirname, '..', 'public', 'core', 'cms.js'));

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const OUT = argOf('--out', '/tmp/probe_full.json');
const CONCURRENCY = parseInt(argOf('--concurrency', '6'), 10) || 6;
const TIMEOUT = 12000;

const UA_BROWSER = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
const UA_APP = 'okhttp/4.12.0';
const SEARCH_KEYWORDS = ['庆余年', '斗罗大陆']; // 常见词，依次尝试直到有命中

/* ============ 网络（与 server.js 同款：punycode + gzip + 重定向 + 双 UA） ============ */
function netFetch(targetUrl, ua, redirects = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('非法 URL')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: domainToASCII(u.hostname) || u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({
        'User-Agent': ua,
        'Accept': '*/*',
        'Accept-Encoding': 'gzip',
        'Connection': 'close'
      }, extraHeaders),
      timeout: TIMEOUT
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(netFetch(new URL(res.headers.location, targetUrl).toString(), ua, redirects + 1, extraHeaders));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if ((res.headers['content-encoding'] || '').includes('gzip')) {
          try { buf = zlib.gunzipSync(buf); } catch (e) { /* 非 gzip 原样 */ }
        }
        resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', buf });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function decodeSmart(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) {
    try { return new TextDecoder('gbk').decode(buf); }
    catch (_) { return buf.toString('utf8'); }
  }
}

async function fetchText(url) {
  let lastErr = null;
  for (const ua of [UA_APP, UA_BROWSER]) {
    try {
      const r = await netFetch(url, ua);
      if (r.status === 200 && r.buf && r.buf.length) return decodeSmart(r.buf);
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('获取失败');
}

const net = {
  fetch: async (url, ua) => {
    const r = await netFetch(url, ua || UA_BROWSER);
    return { status: r.status, contentType: r.contentType, body: decodeSmart(r.buf) };
  },
  fetchText
};
const cms = new CmsApi.CmsClient(net);

/* ============ 工具 ============ */
const normApi = (api) => {
  try {
    const u = new URL(api.trim());
    return (u.protocol + '//' + u.host + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (e) { return api.trim(); }
};
const cleanName = (name) => {
  const m = String(name || '').match(/[\u4e00-\u9fa5A-Za-z0-9]+/g);
  return m ? m.join('') : String(name || '');
};
const isDirectApi = (url) => /provide\/vod|api\.php/i.test(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { error: String(e && e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ============ 阶段1：收集全部源配置 → 去重站点 ============ */
async function collectSources() {
  const queue = [
    ...Sites.BUILTIN_SOURCES.map((s) => ({ ...s, from: '内置' })),
    ...Sites.RECOMMEND_SINGLE.map((s) => ({ ...s, from: '推荐单仓' })),
    ...Sites.RECOMMEND_MULTI.map((s) => ({ ...s, from: '推荐多仓' }))
  ];
  const siteMap = new Map(); // normApi -> { api, names:Set, from:Set }
  const lives = [];
  const sourceReport = [];
  const seenConfig = new Set();

  const addSite = (s, from) => {
    if (!s || !s.api || !/^https?:\/\//i.test(s.api)) return;
    if (s.jar) return;
    const key = normApi(s.api);
    if (!siteMap.has(key)) siteMap.set(key, { api: s.api, names: new Set(), from: new Set(), searchable: s.searchable !== false });
    const e = siteMap.get(key);
    if (s.name) e.names.add(String(s.name));
    e.from.add(from);
  };

  let processed = 0;
  while (queue.length && processed < 120) {
    const src = queue.shift();
    processed++;
    const rep = { name: src.name, url: src.url, from: src.from, status: '', sites: 0, lives: 0, skipped: 0, note: '' };
    sourceReport.push(rep);
    try {
      if (isDirectApi(src.url)) {
        addSite({ name: src.name, api: src.url }, src.name);
        rep.status = '直连接口';
        rep.sites = 1;
        continue;
      }
      const txt = await fetchText(src.url);
      if (Sites.looksLikeMulti(txt)) {
        const subs = Sites.parseMulti(txt);
        rep.status = '多仓';
        rep.note = subs.length + ' 个子仓';
        for (const sub of subs) {
          if (queue.length + processed < 120) queue.push({ ...sub, from: src.name });
        }
        continue;
      }
      const parsed = Sites.parseConfig(txt);
      const usable = parsed.sites.filter((s) => s.type === 1 && !s.jar);
      usable.forEach((s) => addSite(s, src.name));
      parsed.lives.forEach((l) => lives.push({ ...l, from: src.name }));
      rep.status = usable.length ? 'OK' : '无可用站点';
      rep.sites = usable.length;
      rep.lives = parsed.lives.length;
      rep.skipped = (parsed.skipped.jar || 0) + (parsed.skipped.spider || 0);
      if (!usable.length && !parsed.lives.length) rep.note = '解析失败或加密';
    } catch (e) {
      rep.status = '不可达';
      rep.note = String(e && e.message || e).slice(0, 60);
    }
    console.log('[配置] %s (%s) -> %s %s', src.name, src.from, rep.status, rep.note || '');
  }
  return { siteMap, lives, sourceReport };
}

/* ============ 阶段2：站点探测 ============ */
async function probeSite(entry) {
  const site = { key: 'probe', name: [...entry.names][0] || entry.api, api: entry.api, searchable: true };
  const r = { api: entry.api, names: [...entry.names], from: [...entry.from], cats: 0, list: 0, search: 0, play: '', ms: 0, err: '' };
  const t0 = Date.now();
  try {
    const cats = await cms.categories(site);
    r.cats = cats.length;
    if (!cats.length) throw new Error('无分类');
    const page1 = await cms.list(site, cats[0].id, 1);
    r.list = page1.length;
    if (!page1.length) throw new Error('列表为空');
    // 播放地址抽取（详情接口）
    try {
      const d = await cms.detail(site, page1[0].id);
      if (d && d.playUrl) {
        const first = String(d.playUrl).split(/\$\$\$|\n|\r/).filter(Boolean)[0] || '';
        const m = first.match(/https?:\/\/\S+/);
        if (m) r.play = m[0];
      }
    } catch (e) { /* 详情失败不影响主判定 */ }
    // 搜索（常见词依次尝试）
    for (const kw of SEARCH_KEYWORDS) {
      try {
        const sres = await cms.search(site, kw);
        if (sres.length) { r.search = sres.length; r.searchKw = kw; break; }
      } catch (e) { /* 继续下一个词 */ }
    }
  } catch (e) {
    r.err = String(e && e.message || e).slice(0, 80);
  }
  r.ms = Date.now() - t0;
  return r;
}

/* ============ 阶段3：直播源探测 ============ */
async function probeLive(live) {
  const r = { name: live.name, url: live.url, from: live.from, channels: 0, sample: '', err: '' };
  try {
    const txt = await fetchText(live.url);
    const isM3u = /#EXTINF/i.test(txt.slice(0, 4000));
    let chs = 0;
    if (isM3u) {
      chs = (txt.match(/#EXTINF/g) || []).length;
      const m = txt.match(/^https?:\/\/\S+$/m);
      r.sample = m ? m[0] : '';
    } else {
      const lines = txt.split(/\r?\n/).filter((l) => /,https?:\/\//i.test(l.trim()) || /\$https?:\/\//i.test(l.trim()));
      chs = lines.length;
      r.sample = lines.length ? (lines[0].match(/https?:\/\/\S+/) || [''])[0] : '';
    }
    r.channels = chs;
    if (!chs) r.err = '未解析到频道';
  } catch (e) {
    r.err = String(e && e.message || e).slice(0, 80);
  }
  return r;
}

/* ============ 主流程 ============ */
(async () => {
  console.log('=== 阶段1：收集源配置 ===');
  const { siteMap, lives, sourceReport } = await collectSources();
  const entries = [...siteMap.values()];
  console.log('\n共 %d 个源配置，去重后 %d 个唯一站点，直播源 %d 条\n', sourceReport.length, entries.length, lives.length);

  console.log('=== 阶段2：探测站点（并发 %d） ===', CONCURRENCY);
  let done = 0;
  const probes = await pool(entries, CONCURRENCY, async (entry) => {
    const r = await probeSite(entry);
    done++;
    if (done % 10 === 0 || done === entries.length) console.log('  进度 %d/%d', done, entries.length);
    return r;
  });

  console.log('\n=== 阶段3：探测直播源 ===');
  const liveProbes = await pool(lives, 4, probeLive);

  /* ============ 汇总输出 ============ */
  const usable = probes.filter((p) => !p.err && p.list > 0);
  const withSearch = usable.filter((p) => p.search > 0);
  const withPlay = usable.filter((p) => p.play);
  console.log('\n===== 探测结果 =====');
  console.log('唯一站点 %d：可用(列表) %d，其中可搜索 %d，可抽取播放地址 %d',
    probes.length, usable.length, withSearch.length, withPlay.length);
  console.log('直播源 %d：可用 %d', liveProbes.length, liveProbes.filter((l) => l.channels > 0).length);

  const result = { generatedAt: new Date().toISOString(), sourceReport, probes, liveProbes };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log('完整结果已写入 %s', OUT);

  // 本地聚合源候选：可搜索 > 播放地址 > 分类数 > 列表条数 > 速度；同宿主最多 2 个
  const scored = usable
    .map((p) => ({
      p,
      score: (p.search > 0 ? 1000 : 0) + (p.play ? 500 : 0) + Math.min(p.cats, 60) * 3
        + Math.min(p.list, 30) * 2 + Math.min(p.search, 20) * 5 - p.ms / 50
    }))
    .sort((a, b) => b.score - a.score);
  const hostCount = {};
  const picked = [];
  for (const { p } of scored) {
    let host = '';
    try { host = new URL(p.api).host; } catch (e) { /* ignore */ }
    hostCount[host] = (hostCount[host] || 0) + 1;
    if (hostCount[host] > 2) continue;
    picked.push(p);
    if (picked.length >= 14) break;
  }
  const bestLive = liveProbes.filter((l) => l.channels > 0).sort((a, b) => b.channels - a.channels)[0];

  const localSites = picked.map((p, i) => {
    const name = cleanName([...p.names].sort((a, b) => a.length - b.length)[0]) || ('站点' + (i + 1));
    return {
      key: 'local_' + (i + 1),
      name,
      type: 1,
      api: p.api,
      searchable: 1,
      ext: null
    };
  });
  const localCfg = {
    sites: localSites,
    lives: bestLive ? [{ name: '直播(' + bestLive.name + ')', type: 0, url: bestLive.url }] : []
  };
  const localPath = path.join(path.dirname(OUT), 'local_candidate.json');
  fs.writeFileSync(localPath, JSON.stringify(localCfg, null, 2));
  console.log('\n===== 本地聚合源候选（%d 站点 + %d 直播） =====', localSites.length, localCfg.lives.length);
  localSites.forEach((s, i) => {
    const p = picked[i];
    console.log('%2d. %-12s 分类%-3d 列表%-3d 搜索%-3d %s %sms',
      i + 1, s.name, p.cats, p.list, p.search, p.play ? '播放✓' : '播放✗', p.ms);
  });
  if (bestLive) console.log('直播: %s（%d 频道）', bestLive.name, bestLive.channels);
  console.log('候选已写入 %s', localPath);

  // 不可达源摘要（供报告）
  const bad = sourceReport.filter((s) => s.status === '不可达');
  console.log('\n不可达源配置 %d 个：%s', bad.length, bad.map((b) => b.name).join('、'));
})();
