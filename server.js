#!/usr/bin/env node
/**
 * 影视仓 网页版 - 本地服务（路由器部署版）
 * 功能：
 *  1. 静态托管 public/（界面）
 *  2. /api/fetch      透传第三方接口（JSON/文本），跟随重定向、gzip 解压，支持 ref 参数带 Referer
 *  3. /api/fetchText  双 UA + UTF-8/GBK 智能解码（直播 txt 常见 GBK）
 *  4. /api/image      图片代理（带 Referer，绕过防盗链）
 *  5. /api/stream     302 重定向到真实视频地址——视频流量由浏览器直连 CDN，
 *                     不经过本服务（外网访问时不占用路由器上传带宽，规避 PCDN 误判）
 * 说明：netFetch 会把中文域名（如 www.饭太硬.com）转 punycode 后再发起请求。
 * 用法：node server.js  →  http://localhost:8080（PORT 环境变量可改端口）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL, domainToASCII } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = path.join(__dirname, 'public');

const UA_BROWSER = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';
const UA_APP = 'okhttp/4.12.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
};

/* ============ 网络核心：跟随重定向 + gzip ============ */
function netFetch(targetUrl, ua, redirects = 0, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('非法 URL: ' + targetUrl)); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': ua,
      'Accept': '*/*',
      'Accept-Encoding': 'gzip',
      'Connection': 'close'
    }, extraHeaders);
    const req = mod.request({
      // 中文域名（如 www.饭太硬.com）转 punycode 后再请求，否则 DNS 解析失败
      hostname: domainToASCII(u.hostname) || u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: 20000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).toString();
        return resolve(netFetch(next, ua, redirects + 1, extraHeaders));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if ((res.headers['content-encoding'] || '').includes('gzip')) {
          try { buf = zlib.gunzipSync(buf); } catch (e) { /* 非 gzip 则原样 */ }
        }
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          headers: res.headers,
          buf
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** UTF-8 严格优先，失败回退 GBK（国内直播 txt/接口常见） */
function decodeSmart(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (_) {
    try { return new TextDecoder('gbk').decode(buf); }
    catch (_) { return buf.toString('utf8'); }
  }
}

/* ============ 静态文件（流式读取，避免大文件占内存） ============ */
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(file).toLowerCase();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      // html/js/css 不缓存（保证升级立即生效），图片等静态资源缓存 1 小时
      'Cache-Control': ['.html', '.js', '.mjs', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ============ 服务 ============ */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(u.pathname);

  // 同源即可，开放 CORS 方便调试
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/fetch') {
        const target = u.searchParams.get('url');
        const ua = u.searchParams.get('ua') || UA_BROWSER;
        const ref = u.searchParams.get('ref') || '';
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少 url 参数' })); return; }
        const r = await netFetch(target, ua, 0, ref ? { Referer: ref } : {});
        res.writeHead(r.status, { 'Content-Type': r.contentType || 'application/json; charset=utf-8' });
        res.end(r.buf);
        return;
      }

      if (pathname === '/api/fetchText') {
        const target = u.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少 url 参数' })); return; }
        let text = '';
        let lastStatus = 0;
        let lastErr = null;
        // okhttp UA 首发（部分 CMS 只认 App UA）；失败或非 200 再回退浏览器 UA
        try {
          const r = await netFetch(target, UA_APP);
          lastStatus = r.status;
          if (r.status === 200 && r.buf && r.buf.length) text = decodeSmart(r.buf);
        } catch (e) { lastErr = e; }
        if (!text.trim()) {
          try {
            const r2 = await netFetch(target, UA_BROWSER);
            lastStatus = r2.status;
            if (r2.status === 200 && r2.buf && r2.buf.length) text = decodeSmart(r2.buf);
          } catch (e2) { lastErr = e2; }
        }
        if (!text.trim()) {
          // 两次都拿不到有效内容：返回明确原因（HTTP 状态码或网络错误），
          // 避免上层把「HTTP 451 地区限制」误报成「不是有效的 TVBox 配置」
          const msg = lastErr ? String(lastErr.message || lastErr) : ('HTTP ' + (lastStatus || '错误'));
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '配置获取失败（' + msg + '）' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
        return;
      }

      if (pathname === '/api/image') {
        const target = u.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少 url 参数' })); return; }
        let referer = '';
        try {
          const t2 = new URL(target);
          referer = t2.protocol + '//' + (domainToASCII(t2.hostname) || t2.hostname) + '/';
        } catch (_) { /* 空 Referer */ }
        const r = await netFetch(target, UA_BROWSER, 0, { Referer: referer });
        const ct = (r.contentType || 'image/jpeg').split(';')[0];
        res.writeHead(r.status, {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(r.buf);
        return;
      }

      if (pathname === '/api/stream') {
        const target = u.searchParams.get('url');
        if (!target) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少 url 参数' })); return; }
        // 视频流量一律不经过路由器：302 指向真实地址，由浏览器直连视频 CDN。
        // 这样即使从外网访问，路由器也不会产生持续上传流量（规避运营商 PCDN 误判封宽带）。
        let t = null;
        try { t = new URL(target); } catch (_) { t = null; }
        if (!t || !/^https?:$/.test(t.protocol)) { res.writeHead(400); res.end('仅支持 http/https'); return; }
        // 用规范化后的 href：中文/特殊字符会被 percent-encode，避免 writeHead 抛错
        res.writeHead(302, { Location: t.href, 'Cache-Control': 'no-cache' });
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知接口' }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('影视仓 网页版已启动: http://localhost:' + PORT);
  console.log('局域网访问: http://' + (require('os').networkInterfaces() && Object.values(require('os').networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal) || {}).address + ':' + PORT);
});
