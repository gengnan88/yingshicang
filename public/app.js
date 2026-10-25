/* 影视仓 网页版 - 前端主逻辑（数据经本地服务 /api/* 代理，规避浏览器 CORS） */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // ===== 本地服务适配层：浏览器 fetch 走同源 /api 代理 =====
  window.ysc = {
    log: (...args) => { try { console.log('[ysc]', ...args); } catch (e) { /* ignore */ } },
    fetch: async (url, ua, referer) => {
      let q = '/api/fetch?url=' + encodeURIComponent(url) + '&ua=' + encodeURIComponent(ua || '');
      if (referer) q += '&ref=' + encodeURIComponent(referer);
      const r = await fetch(q);
      const body = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') || '', body };
    },
    fetchText: async (url) => {
      // 同源本地配置（如 /local.json 本地聚合源）：浏览器直取，不走代理
      if (url && url.startsWith('/')) {
        const r0 = await fetch(url);
        if (!r0.ok) throw new Error('本地配置读取失败 ' + r0.status);
        return r0.text();
      }
      const r = await fetch('/api/fetchText?url=' + encodeURIComponent(url));
      if (!r.ok) {
        // 透传服务端的明确错误（如 HTTP 451 / 超时），不要只报 "代理请求失败 502"
        let msg = '代理请求失败 ' + r.status;
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      return r.text();
    },
    // 图片走服务端代理（绕过防盗链），直接返回可当 src/背景用的路径
    image: async (url) => '/api/image?url=' + encodeURIComponent(url)
  };
  const net = {
    fetch: (url, ua, referer) => window.ysc.fetch(url, ua, referer),
    fetchText: (url) => window.ysc.fetchText(url)
  };
  // 播放流：浏览器直连视频 CDN。
  // 视频流量不经过路由器——外网访问时不会消耗路由器上传带宽（规避 PCDN 误判）。
  // hls.js 会自动把 m3u8 内部的相对地址解析为绝对地址；视频 CDN 均带 Access-Control-Allow-Origin: *。
  const streamUrl = (u) => u;
  const cms = new YSC_Cms.CmsClient(net);
  const Douban = YSC_Douban;
  const Store = YSC_Store;

  const state = {
    sources: [],        // 可选数据源 [{name, url}]
    curSource: null,    // 当前数据源
    sites: [],          // 配置解析出的站点
    site: null,         // 当前工作站点
    categories: [],
    homeCat: '',
    homePage: 0,
    homeDone: false,
    homeLoading: false,
    // ===== 首页数据源：'douban'（豆瓣榜单，默认）或 'site'（指定站点列表） =====
    homeMode: 'douban',
    homeSiteKey: '',    // site 模式下使用的站点 key（'' = 当前工作站点）
    homeSite: null,     // site 模式下实际使用的站点对象
    doubanCat: 'movie_hot_gaia',
    doubanVideos: [],
    bannerIdx: 0,
    bannerTimer: null,
    searchResults: [],
    searchSources: [],  // 搜索用的源 [{key,name,api}]
    imgCache: new Map(),
    player: null,       // 点播 {site, video, groups, g, e, hls} 或 直播 {live, lines, curLine}
    // ===== 直播 =====
    lives: [],          // 当前数据源配置里的直播源地址 [{name,url}]
    liveGroups: [],     // 解析后的分组 [{name, channels:[{name, lines:[{label,url}]}]}]
    liveGroup: '',      // 当前选中的分组名（'' = 第一个）
    liveLoaded: false,
    liveLoading: false
  };

  // ===== 工具 =====
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.display = 'none'; }, ms);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** 秒 → mm:ss 或 h:mm:ss */
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  /** 片名归一化：去掉【】[]（）() 括号内容、年份、"第X季/部"、清晰度/来源标记、标点空白后小写化，
   *  用于跨源同名匹配（不同源常带 [清晰度]（2023） 之类尾巴） */
  function normalizeName(name) {
    return String(name || '')
      .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）/g, ' ')
      .replace(/第\s*\d+\s*[季部]/g, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ')
      .replace(/(?:4k|8k|1080p|720p|480p|hd|sd|bd|dvd|bluray|web-dl|webrip|hdtv|ts版|枪版|抢先版)/gi, ' ')
      .replace(/(?:解说|预告|花絮|彩蛋|幕后|特辑|抢先看|完整版|未删减|高清|蓝光|国语|粤语|中字|字幕|全集|正片|首发|独播|自制|修复|画质|版本|独家)/g, ' ')
      .replace(/[\s·・\-—~～_,，。.!！?？:：;；'"“”‘’()（）\[\]【】]+/g, '')
      .trim()
      .toLowerCase();
  }

  async function loadImage(url) {
    if (!url) return null;
    if (state.imgCache.has(url)) return state.imgCache.get(url);
    try {
      const proxy = await window.ysc.image(url);
      state.imgCache.set(url, proxy);
      return proxy;
    } catch (e) { return null; }
  }

  // 懒加载：容器内海报进入视口后再取图
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      io.unobserve(el);
      const url = el.dataset.src;
      if (!url) continue;
      loadImage(url).then((d) => { if (d) el.style.backgroundImage = 'url(' + d + ')'; });
    }
  }, { root: null, rootMargin: '200px' });

  function observePosters(container) {
    container.querySelectorAll('[data-src]').forEach((el) => io.observe(el));
  }

  // ===== Tab 切换 =====
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      $('tab-' + el.dataset.tab).classList.add('active');
      if (el.dataset.tab === 'fav') renderFav();
      if (el.dataset.tab === 'mine') renderMine();
      if (el.dataset.tab === 'live') ensureLive();
    });
  });

  // ===== 启动：豆瓣首页不依赖数据源，先出首页；数据源后台解析 =====
  async function boot() {
    window.ysc.log('boot: start');
    const customs = Store.getSources();
    state.sources = YSC_Sites.BUILTIN_SOURCES.concat(customs);
    const curName = Store.getCurrentSource();
    state.curSource = state.sources.find((s) => s.name === curName) || state.sources[0];
    state.homeMode = Store.getHomeMode() || 'douban';
    state.homeSiteKey = Store.getHomeSite() || '';
    renderSourceChip();
    renderHomeChip();
    // 豆瓣榜单模式先渲染（与数据源解耦）；数据源解析完后再按需刷新
    await loadHome(true);
    // 记住的数据源可能已失效：失败则依次尝试其它源，保证一定能落到可用源上
    if (await switchSource(state.curSource, true)) return;
    for (const s of state.sources.slice(0, 6)) {
      if (s === state.curSource) continue;
      window.ysc.log('boot: fallback 尝试 ' + s.name);
      if (await switchSource(s, true)) { toast('已自动切换到可用源：' + s.name); return; }
    }
    window.ysc.log('boot: 所有源均失败（豆瓣首页不受影响）');
  }

  /** 切换数据源；返回 true=成功，false=失败（失败时整体回滚到上一个可用源） */
  async function switchSource(src, first = false) {
    if (!src) return false;
    // 保存旧状态：加载失败时整体回滚，保证顶栏显示、搜索、换源与实际数据源一致
    const prev = {
      curSource: state.curSource,
      site: state.site,
      categories: state.categories,
      searchSources: state.searchSources,
      lives: state.lives,
      liveGroups: state.liveGroups,
      liveLoaded: state.liveLoaded
    };
    const prevName = prev.curSource ? prev.curSource.name : '';
    state.curSource = src;
    Store.setCurrentSource(src.name);
    renderSourceChip();
    renderMine();
    $('topbar-status').textContent = '正在解析数据源…';
    window.ysc.log('switchSource: ' + src.name + ' ' + src.url);
    try {
      let sites = [];
      let lives = [];
      if (/provide\/vod|api\.php/i.test(src.url)) {
        sites = [{ key: src.name, name: src.name, type: 1, api: src.url, searchable: true }];
      } else {
        const raw = await net.fetchText(src.url);
        // 多仓（FongMi dc / room / DC.txt）：展开为多个单仓后切换过去
        if (YSC_Sites.looksLikeMulti(raw)) {
          const subs = YSC_Sites.parseMulti(raw);
          if (subs.length) {
            let added = 0;
            for (const s of subs) if (Store.addSource(s.name, s.url)) added++;
            state.sources = YSC_Sites.BUILTIN_SOURCES.concat(Store.getSources());
            renderMine();
            toast('多仓已展开：' + subs.length + ' 个单仓' + (added ? '（新增 ' + added + ' 个）' : ''));
            const firstSub = state.sources.find((s) => s.url === subs[0].url);
            if (firstSub && firstSub.url !== src.url) {
              // 子仓也走完整的 switchSource（含回滚）；
              // 子仓失败时把多仓本身也标记为失败，由外层回滚到之前的可用源
              const ok = await switchSource(firstSub, first);
              if (!ok) throw new Error('多仓「' + src.name + '」内的子仓均不可用');
              return true;
            }
            throw new Error('多仓内没有可切换的单仓');
          }
        }
        if (!YSC_Sites.looksLikeConfig(raw)) throw new Error('该地址不是有效的 TVBox 配置');
        const cfg = YSC_Sites.parseConfig(raw);
        sites = cfg.sites;
        lives = cfg.lives;
        const skipN = (cfg.skipped.jar || 0) + (cfg.skipped.spider || 0);
        if (!sites.length) {
          throw new Error(skipN
            ? '该配置有 ' + skipN + ' 个站点，但均为 jar/爬虫类型（网页版暂不支持）'
            : '未解析到可用站点（仅支持苹果CMS type=1 接口）');
        }
        if (skipN) toast('已跳过 ' + skipN + ' 个不支持的站点（jar/爬虫）');
      }
      state.sites = sites;
      state.lives = lives;
      state.liveGroups = [];
      state.liveLoaded = false;
      window.ysc.log('switchSource: got ' + sites.length + ' sites, ' + lives.length + ' lives, probing…');
      // 探测第一个可用站点
      let working = null;
      let tried = 0;
      for (const s of sites) {
        if (tried >= 12) break;
        tried++;
        try {
          const cats = await cms.categories(s);
          const firstPage = await cms.list(s, '', 1);
          window.ysc.log('probe ' + s.name + ': cats=' + cats.length + ' page1=' + firstPage.length);
          if (firstPage.length) { working = { site: s, categories: cats, firstPage }; break; }
        } catch (e) { window.ysc.log('probe ' + s.name + ' ERROR: ' + (e.message || e)); }
      }
      if (!working) throw new Error('所有站点均不可用，请更换数据源');
      window.ysc.log('working site: ' + working.site.name);
      state.site = working.site;
      state.categories = working.categories;
      // 本地聚合源 12 个站点均实测可用，全部参与搜索；外部大仓仍限 12 防并发爆炸
      state.searchSources = sites.filter((s) => s.searchable !== false).slice(0, 12);
      renderSearchSourceChips();
      $('topbar-status').textContent = '';
      // 站点列表模式：数据源就绪后刷新首页；豆瓣模式已在 boot 时加载，无需重拉
      if (state.homeMode === 'site') await loadHome(true);
      return true;
    } catch (e) {
      window.ysc.log('switchSource ERROR: ' + (e && e.message || e));
      // ===== 整体回滚到上一个可用源：搜索/换源继续用旧数据，顶栏同步显示旧源名 =====
      state.curSource = prev.curSource;
      state.site = prev.site;
      state.categories = prev.categories;
      state.searchSources = prev.searchSources;
      state.lives = prev.lives;
      state.liveGroups = prev.liveGroups;
      state.liveLoaded = prev.liveLoaded;
      Store.setCurrentSource(prevName);
      renderSourceChip();
      renderMine();
      $('topbar-status').textContent = '';
      // 数据源失败不清空豆瓣首页（豆瓣榜单与数据源解耦）
      if (state.homeMode === 'site') {
        $('home-grid').innerHTML = '';
        $('banner-track').innerHTML = '';
      } else if (!state.doubanVideos.length) {
        await loadHome(true);
      }
      toast('数据源「' + src.name + '」加载失败：' + (e.message || e) +
        (prev.site && prevName ? '，已停留在「' + prevName + '」' : '') +
        (state.homeMode === 'douban' ? '（首页仍为豆瓣榜单）' : ''), 4200);
      return false;
    }
  }

  // ===== 直播 =====
  /** 进入直播页：确保源已加载 */
  async function ensureLive() {
    if (state.liveLoading) return;
    if (state.liveLoaded) { renderLiveGroups(); renderLiveGrid(); return; }
    const custom = ($('live-url-input').value || '').trim();
    let urls = [];
    if (custom) {
      urls = custom.split(/[,;\s]+/).filter(Boolean);
    } else if (state.lives.length) {
      urls = state.lives.map((l) => l.url);
    }
    if (!urls.length) {
      state.liveGroups = [];
      state.liveLoaded = true;
      renderLiveGroups();
      renderLiveGrid();
      $('live-empty').style.display = 'block';
      $('live-empty').textContent = '当前数据源没有直播配置，可在上方粘贴 m3u / txt 直播源地址';
      return;
    }
    state.liveLoading = true;
    $('live-loading').style.display = 'block';
    $('live-empty').style.display = 'none';
    window.ysc.log('live: loading ' + urls.length + ' urls');
    try {
      const all = [];
      for (const u of urls.slice(0, 6)) {
        try {
          const txt = await net.fetchText(u);
          const base = u.substring(0, u.lastIndexOf('/') + 1);
          const gs = YSC_Live.parseLiveText(txt, base);
          window.ysc.log('live: ' + u + ' → ' + gs.length + ' groups');
          all.push(gs);
        } catch (e) {
          window.ysc.log('live: ' + u + ' ERROR ' + (e.message || e));
        }
      }
      state.liveGroups = YSC_Live.mergeGroups(all);
      state.liveLoaded = true;
      state.liveGroup = '';
      renderLiveGroups();
      renderLiveGrid();
      if (!state.liveGroups.length) {
        $('live-empty').style.display = 'block';
        $('live-empty').textContent = '未解析到频道，请检查直播源地址';
      }
    } finally {
      state.liveLoading = false;
      $('live-loading').style.display = 'none';
    }
  }

  function liveChannels() {
    const kw = ($('live-search-input').value || '').trim().toLowerCase();
    let groups = state.liveGroups;
    if (state.liveGroup) groups = groups.filter((g) => g.name === state.liveGroup);
    if (!kw) return groups;
    return groups
      .map((g) => ({ ...g, channels: g.channels.filter((c) => c.name.toLowerCase().includes(kw)) }))
      .filter((g) => g.channels.length);
  }

  function renderLiveGroups() {
    const box = $('live-group-chips');
    if (!state.liveGroups.length) { box.innerHTML = ''; return; }
    const names = state.liveGroups.map((g) => g.name);
    box.innerHTML = names.map((n) =>
      '<div class="chip' + (n === state.liveGroup ? ' active' : '') + '" data-g="' + esc(n) + '">' + esc(n) + '</div>'
    ).join('');
    box.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => {
        state.liveGroup = state.liveGroup === el.dataset.g ? '' : el.dataset.g;
        renderLiveGroups();
        renderLiveGrid();
      });
    });
  }

  function renderLiveGrid() {
    const box = $('live-grid');
    const groups = liveChannels();
    const empty = !groups.length;
    $('live-empty').style.display = empty ? 'block' : 'none';
    if (empty && state.liveGroups.length) $('live-empty').textContent = '没有匹配的频道';
    box.innerHTML = '';
    for (const g of groups) {
      for (const ch of g.channels) {
        const el = document.createElement('div');
        el.className = 'live-ch';
        el.innerHTML = esc(ch.name) + (ch.lines.length > 1 ? '<span class="lc-n">' + ch.lines.length + '线</span>' : '');
        el.addEventListener('click', () => openLivePlayer(ch));
        box.appendChild(el);
      }
    }
  }

  $('live-load-btn').addEventListener('click', () => {
    state.liveLoaded = false;
    state.liveGroups = [];
    ensureLive();
  });
  $('live-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('live-load-btn').click(); });
  $('live-search-input').addEventListener('input', renderLiveGrid);

  /** 打开直播播放 */
  function openLivePlayer(channel) {
    const p = { live: channel, curLine: 0, hls: null };
    state.player = p;
    $('player-page').style.display = 'flex';
    // 直播模式：隐藏点播专用元素
    $('p-desc').style.display = 'none';
    $('p-current-source').style.display = 'none';
    $('p-groups').style.display = 'none';
    $('p-eps').innerHTML = '';
    $('p-eps').style.display = 'none';
    $('p-source-btn').style.display = 'none';
    $('p-fav-btn').style.display = 'none';
    $('p-live-lines').style.display = 'flex';
    $('p-title').textContent = channel.name;
    $('p-meta').textContent = channel.lines.length > 1 ? channel.lines.length + ' 条线路，失败自动切换' : '直播';
    renderLiveLines();
    playLiveLine(0);
  }

  function renderLiveLines() {
    const p = state.player;
    if (!p || !p.live) return;
    const box = $('p-live-lines');
    box.innerHTML = p.live.lines.map((l, i) =>
      '<div class="chip' + (i === p.curLine ? ' active' : '') + '" data-l="' + i + '">' + esc(l.label) + '</div>'
    ).join('');
    box.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => playLiveLine(+el.dataset.l));
    });
  }

  function playLiveLine(i) {
    const p = state.player;
    if (!p || !p.live) return;
    if (i < 0 || i >= p.live.lines.length) return;
    p.curLine = i;
    $('p-title').textContent = p.live.name + ' · ' + p.live.lines[i].label;
    renderLiveLines();
    attachVideo(p.live.lines[i].url);
  }

  function renderSourceChip() {
    $('source-name').textContent = state.curSource ? state.curSource.name : '未选择';
    $('source-chip').onclick = async () => {
      // 循环切换到下一个源
      const i = state.sources.indexOf(state.curSource);
      const next = state.sources[(i + 1) % state.sources.length];
      await switchSource(next);
    };
  }

  // ===== 首页数据源切换（豆瓣榜单 / 站点列表） =====
  function homeLabel() {
    if (state.homeMode === 'douban') {
      const c = Douban.categories.find((x) => x.id === state.doubanCat);
      return '豆瓣 · ' + (c ? c.name : '榜单');
    }
    const s = homeSite();
    return s ? (s.name || s.key) : '站点';
  }

  function renderHomeChip() {
    $('home-name').textContent = homeLabel();
    $('home-chip').onclick = showHomePicker;
  }

  async function setHomeMode(mode, siteKey) {
    state.homeMode = mode;
    state.homeSiteKey = siteKey || '';
    Store.setHomeMode(mode);
    Store.setHomeSite(siteKey || '');
    renderHomeChip();
    await loadHome(true);
  }

  function showHomePicker() {
    const dlg = document.createElement('div');
    dlg.className = 'ysc-dlg-mask';
    const box = document.createElement('div');
    box.className = 'ysc-dlg';
    box.innerHTML = '<h3>首页数据源</h3><p class="ysc-dlg-tip">豆瓣榜单按评分/热度排序；站点列表用所选仓的首页数据。点击卡片时会自动在当前仓搜索同名影片播放。</p>';
    const mkRow = (label, sub, active, fn) => {
      const row = document.createElement('div');
      row.className = 'source-row' + (active ? ' cur' : '');
      row.style.cursor = 'pointer';
      row.innerHTML = '<span class="sr-name">' + esc(label) + '</span>' +
        '<span class="sr-url">' + esc(sub || '') + '</span>' +
        (active ? '<span class="sr-tag">当前</span>' : '');
      row.addEventListener('click', () => { dlg.remove(); fn(); });
      return row;
    };
    box.appendChild(mkRow('豆瓣榜单', '默认 · 热播/高分/新片', state.homeMode === 'douban', () => setHomeMode('douban')));
    // 站点列表
    if (state.sites.length) {
      box.appendChild(mkRow('站点列表 · ' + (homeSite() ? (homeSite().name || '') : ''), '用所选仓的首页数据',
        state.homeMode === 'site' && !state.homeSiteKey, () => setHomeMode('site', '')));
      for (const s of state.sites.slice(0, 30)) {
        box.appendChild(mkRow(s.name || s.key, s.api, state.homeMode === 'site' && state.homeSiteKey === s.key,
          () => setHomeMode('site', s.key)));
      }
    }
    dlg.appendChild(box);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
    document.body.appendChild(dlg);
  }

  /** 豆瓣条目：按片名在当前仓各源并发搜索，归一化匹配后直接播放 */
  async function searchAndPlay(v) {
    const targets = (state.searchSources && state.searchSources.length ? state.searchSources : (state.site ? [state.site] : [])).slice(0, 4);
    if (!targets.length) { toast('当前数据源不可用，请先切换数据源'); return; }
    toast('正在当前仓查找《' + v.name + '》…');
    const kw = v.name;
    const kwNorm = normalizeName(kw);
    const jobs = targets.map(async (s) => {
      try {
        const list = await cms.search(s, kw);
        const hit = (kwNorm && list.find((x) => normalizeName(x.name) === kwNorm)) ||
                    list.find((x) => x.name === kw);
        return hit ? { site: s, video: hit } : null;
      } catch (e) { return null; }
    });
    const hits = (await Promise.all(jobs)).filter(Boolean);
    if (!hits.length) {
      toast('当前仓未收录《' + v.name + '》，试试切换数据源');
      return;
    }
    if (hits.length > 1) {
      // 多个源都有：弹层选择
      const dlg = document.createElement('div');
      dlg.className = 'ysc-dlg-mask';
      const box = document.createElement('div');
      box.className = 'ysc-dlg';
      box.innerHTML = '<h3>《' + esc(v.name) + '》· 选择播放源</h3>';
      for (const h of hits) {
        const row = document.createElement('div');
        row.className = 'source-row';
        row.style.cursor = 'pointer';
        row.innerHTML = '<span class="sr-name">' + esc(h.site.name) + '</span><span class="sr-url">' + esc(h.video.remarks || '') + '</span>';
        row.addEventListener('click', () => { dlg.remove(); openPlayer(h.site, h.video); });
        box.appendChild(row);
      }
      const close = document.createElement('button');
      close.className = 'p-btn';
      close.textContent = '取消';
      close.style.marginTop = '12px';
      close.addEventListener('click', () => dlg.remove());
      box.appendChild(close);
      dlg.appendChild(box);
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
      document.body.appendChild(dlg);
      return;
    }
    openPlayer(hits[0].site, hits[0].video);
  }

  // ===== 首页 =====
  /** site 模式使用的站点：用户指定的优先，否则当前工作站点 */
  function homeSite() {
    if (state.homeSiteKey) {
      const s = state.sites.find((x) => x.key === state.homeSiteKey);
      if (s) return s;
    }
    return state.site;
  }

  async function loadHome(reset) {
    if (reset) {
      state.homePage = 0;
      state.homeDone = false;
      state.homeVideos = [];
      state.doubanVideos = [];
      state.homeCat = '';
      $('home-grid').innerHTML = '';
      renderChips();
      $('home-loading').style.display = 'none';
      $('home-end').style.display = 'none';
    }
    if (state.homeLoading || state.homeDone) return;
    state.homeLoading = true;
    $('home-loading').style.display = 'block';
    try {
      if (state.homeMode === 'douban') {
        const cat = state.doubanCat || Douban.categories[0].id;
        const r = await Douban.list(net, cat, state.homePage * Douban.pageSize, Douban.pageSize);
        const videos = r.items;
        window.ysc.log('loadHome(douban): cat=' + cat + ' page=' + state.homePage + ' got=' + videos.length);
        if (videos.length) {
          state.homePage++;
          state.doubanVideos = state.doubanVideos.concat(videos);
          appendCards($('home-grid'), videos);
          if (state.homePage === 1) renderBanner(videos);
          if (r.total && state.doubanVideos.length >= r.total) {
            state.homeDone = true;
            $('home-end').style.display = 'block';
          }
        } else {
          state.homeDone = true;
          $('home-end').style.display = 'block';
        }
        return;
      }
      const site = homeSite();
      if (!site) { toast('当前数据源没有可用站点'); state.homeDone = true; return; }
      const page = state.homePage + 1;
      const videos = await cms.list(site, state.homeCat, page);
      window.ysc.log('loadHome: site=' + site.name + ' page=' + page + ' got=' + videos.length);
      if (videos.length) {
        state.homePage = page;
        state.homeVideos = state.homeVideos.concat(videos);
        appendCards($('home-grid'), videos);
        if (page === 1) renderBanner(videos);
      } else {
        state.homeDone = true;
        $('home-end').style.display = 'block';
      }
    } catch (e) {
      toast('列表加载失败：' + (e.message || e));
      state.homeDone = true;
    } finally {
      state.homeLoading = false;
      $('home-loading').style.display = 'none';
    }
  }

  function renderChips() {
    const box = $('home-chips');
    let cats;
    let cur;
    if (state.homeMode === 'douban') {
      cats = Douban.categories.map((c) => ({ id: c.id, name: c.name }));
      cur = state.doubanCat;
    } else {
      cats = [{ id: '', name: '全部' }].concat(state.categories);
      cur = state.homeCat;
    }
    box.innerHTML = cats.map((c) =>
      '<div class="chip' + (c.id === cur ? ' active' : '') + '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</div>'
    ).join('');
    box.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', async () => {
        const id = el.dataset.cat;
        if (id === cur) return;
        if (state.homeMode === 'douban') state.doubanCat = id;
        else state.homeCat = id;
        renderChips();
        await loadHome(true);
      });
    });
  }

  function renderBanner(videos) {
    const withPic = videos.filter((v) => v.pic).slice(0, 5);
    const track = $('banner-track');
    const dots = $('banner-dots');
    if (!withPic.length) { $('banner').style.display = 'none'; return; }
    $('banner').style.display = 'block';
    track.innerHTML = withPic.map((v, i) =>
      '<div class="banner-slide" data-i="' + i + '">' +
      '<div class="banner-caption"><h2>' + esc(v.name) + '</h2>' +
      '<div class="banner-remarks">' + esc(v._douban ? (v.remarks || v.year || '') : (v.remarks || '')) + '</div></div></div>'
    ).join('');
    dots.innerHTML = withPic.map((_, i) => '<div class="banner-dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '"></div>').join('');
    // 后台取图
    withPic.forEach((v, i) => {
      loadImage(v.pic).then((d) => {
        if (!d) return;
        const slide = track.querySelector('[data-i="' + i + '"]');
        if (slide) slide.style.backgroundImage = 'url(' + d + ')';
      });
    });
    track.querySelectorAll('.banner-slide').forEach((el) => {
      el.addEventListener('click', () => {
        const v = withPic[+el.dataset.i];
        if (v._douban) searchAndPlay(v);
        else openPlayer(v._site || state.site, v);
      });
    });
    dots.querySelectorAll('.banner-dot').forEach((el) => {
      el.addEventListener('click', () => showBanner(+el.dataset.i));
    });
    state.bannerIdx = 0;
    clearInterval(state.bannerTimer);
    state.bannerTimer = setInterval(() => {
      showBanner((state.bannerIdx + 1) % withPic.length);
    }, 4500);
  }

  function showBanner(i) {
    state.bannerIdx = i;
    $('banner-track').style.transform = 'translateX(-' + i * 100 + '%)';
    $('banner-dots').querySelectorAll('.banner-dot').forEach((d, di) => {
      d.classList.toggle('active', di === i);
    });
  }

  function appendCards(container, videos, sourceLabel) {
    const frag = document.createDocumentFragment();
    for (const v of videos) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-poster" data-src="' + esc(v.pic || '') + '">' +
        (sourceLabel ? '<div class="card-source">' + esc(sourceLabel(v)) + '</div>' : '') +
        (v.remarks ? '<div class="card-remarks">' + esc(v.remarks) + '</div>' : '') +
        '</div><div class="card-body"><div class="card-title">' + esc(v.name) + '</div></div>';
      card.addEventListener('click', () => {
        if (v._douban) { searchAndPlay(v); return; }
        const src = v._site || state.site;
        openPlayer(src, v);
      });
      frag.appendChild(card);
    }
    container.appendChild(frag);
    observePosters(container);
  }

  // 首页滚动加载
  $('main').addEventListener('scroll', () => {
    const m = $('main');
    if (m.scrollTop + m.clientHeight > m.scrollHeight - 300) loadHome(false);
  });

  // ===== 搜索 =====
  function renderSearchSourceChips() {
    const box = $('search-source-chips');
    const all = [{ key: '__all__', name: '全部源' }].concat(
      state.searchSources.map((s) => ({ key: s.key, name: s.name, api: s.api, _site: s }))
    );
    box.innerHTML = all.map((s, i) =>
      '<div class="chip' + (i === 0 ? ' active' : '') + '" data-key="' + esc(s.key) + '">' + esc(s.name) + '</div>'
    ).join('');
    box.querySelectorAll('.chip').forEach((el) => {
      el.addEventListener('click', () => {
        box.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        el.classList.add('active');
        doSearch();
      });
    });
  }

  async function doSearch() {
    const kw = $('search-input').value.trim();
    if (!kw) { toast('请输入搜索关键词'); return; }
    const grid = $('search-grid');
    grid.innerHTML = '';
    $('search-empty').style.display = 'none';
    $('search-loading').style.display = 'block';
    const activeChip = $('search-source-chips').querySelector('.chip.active');
    const key = activeChip ? activeChip.dataset.key : '__all__';
    let targets = state.searchSources;
    if (key !== '__all__') targets = state.searchSources.filter((s) => s.key === key);
    const jobs = targets.map(async (s) => {
      try {
        const list = await cms.search(s, kw);
        return list.map((v) => { v._site = s; return v; });
      } catch (e) { return []; }
    });
    const results = (await Promise.all(jobs)).reduce((a, b) => a.concat(b), []);
    state.searchResults = results;
    $('search-loading').style.display = 'none';
    if (!results.length) { $('search-empty').style.display = 'block'; return; }
    appendCards(grid, results, (v) => (v._site && v._site.name) || '');
  }

  $('search-btn').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // ===== 收藏 =====
  function renderFav() {
    const grid = $('fav-grid');
    const favs = Store.getFavs();
    grid.innerHTML = '';
    $('fav-empty').style.display = favs.length ? 'none' : 'block';
    const frag = document.createDocumentFragment();
    for (const f of favs) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="card-poster" data-src="' + esc(f.pic || '') + '">' +
        (f.remarks ? '<div class="card-remarks">' + esc(f.remarks) + '</div>' : '') +
        '</div><div class="card-body"><div class="card-title">' + esc(f.name) + '</div></div>';
      card.addEventListener('click', () => openPlayerByRef(f));
      frag.appendChild(card);
    }
    grid.appendChild(frag);
    observePosters(grid);
  }

  // 收藏/历史条目可能没有完整 playUrl：先按引用拉详情
  async function openPlayerByRef(ref) {
    const site = { key: ref.siteKey, name: ref.siteName || ref.siteKey, type: 1, api: ref.siteApi, searchable: true };
    toast('加载详情…');
    try {
      const v = await cms.detail(site, ref.vodId);
      if (v) openPlayer(site, v, ref.episode || null);
      else toast('详情获取失败');
    } catch (e) { toast('详情获取失败：' + (e.message || e)); }
  }

  // ===== 我的 =====
  /** 推荐源面板：单仓 / 多仓 / 直播源 三类社区常用地址，一键添加 */
  function renderRecommend() {
    const box = $('recommend-list');
    if (!box) return;
    const customs = Store.getSources();
    const has = (url) => customs.some((c) => c.url === url);
    const mkSection = (title, tip, items, kind) => {
      const det = document.createElement('details');
      det.className = 'rec-sec';
      det.open = kind === 'single';
      det.innerHTML = '<summary>' + esc(title) + '<span class="rec-count">' + items.length + '</span></summary>' +
        '<div class="rec-tip">' + esc(tip) + '</div>';
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'source-row rec-row';
        const added = has(it.url);
        row.innerHTML =
          '<span class="sr-name">' + esc(it.name) + '</span>' +
          '<span class="sr-url" title="' + esc(it.url) + '">' + esc(it.url) + '</span>' +
          (added ? '<span class="sr-tag">已添加</span>' : '');
        const btn = document.createElement('button');
        btn.textContent = kind === 'live' ? '使用' : (added ? '添加' : '添加');
        if (added && kind !== 'live') btn.disabled = true;
        btn.addEventListener('click', async () => {
          if (kind === 'live') {
            $('live-url-input').value = it.url;
            document.querySelector('.nav-item[data-tab="live"]').click();
            state.liveLoaded = false;
            state.liveGroups = [];
            ensureLive();
            return;
          }
          if (kind === 'multi') {
            btn.disabled = true;
            btn.textContent = '展开中…';
            try {
              const raw = await net.fetchText(it.url);
              const subs = YSC_Sites.looksLikeMulti(raw) ? YSC_Sites.parseMulti(raw) : [];
              if (!subs.length) { toast('未从该多仓解析到单仓地址'); btn.textContent = '添加'; btn.disabled = false; return; }
              let addedN = 0;
              Store.addSource(it.name, it.url); // 多仓本身也记录，便于重复展开与「已添加」标记
              for (const s of subs) if (Store.addSource(s.name, s.url)) addedN++;
              state.sources = YSC_Sites.BUILTIN_SOURCES.concat(Store.getSources());
              toast('已展开 ' + subs.length + ' 个单仓（新增 ' + addedN + '）');
              renderRecommend();
              renderMine();
            } catch (e) {
              toast('多仓获取失败：' + (e.message || e));
              btn.textContent = '添加';
              btn.disabled = false;
            }
            return;
          }
          // 单仓：直接加入
          if (Store.addSource(it.name, it.url)) {
            state.sources.push({ name: it.name, url: it.url });
            toast('已添加 ' + it.name);
          } else toast('该源已存在');
          renderRecommend();
          renderMine();
        });
        row.appendChild(btn);
        det.appendChild(row);
      }
      return det;
    };
    box.innerHTML = '';
    box.appendChild(mkSection('推荐单仓', '苹果CMS 接口，点击「添加」后到数据源管理中「使用」。jar/爬虫类型站点网页版暂不支持。', YSC_Sites.RECOMMEND_SINGLE, 'single'));
    box.appendChild(mkSection('推荐多仓', '一个地址包含多个单仓，添加后自动展开全部子仓。', YSC_Sites.RECOMMEND_MULTI, 'multi'));
    box.appendChild(mkSection('推荐直播源', 'm3u / txt 格式，点击「使用」立即加载到直播页。', YSC_Sites.RECOMMEND_LIVES, 'live'));
  }

  function renderMine() {
    const box = $('source-list');
    box.innerHTML = '';
    for (const s of state.sources) {
      const row = document.createElement('div');
      row.className = 'source-row' + (s === state.curSource ? ' cur' : '');
      const isCustom = Store.getSources().some((c) => c.url === s.url);
      row.innerHTML =
        '<span class="sr-name">' + esc(s.name) + '</span>' +
        '<span class="sr-url">' + esc(s.url) + '</span>' +
        (s === state.curSource ? '<span class="sr-tag">当前</span>' : '') +
        '<button data-act="use">使用</button>' +
        (isCustom ? '<button data-act="del">删除</button>' : '');
      row.querySelector('[data-act="use"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await switchSource(s);
        renderMine();
      });
      const del = row.querySelector('[data-act="del"]');
      if (del) del.addEventListener('click', (e) => {
        e.stopPropagation();
        Store.removeSource(s.url);
        state.sources = state.sources.filter((x) => x !== s);
        renderMine();
        renderRecommend();
        toast('已删除 ' + s.name);
      });
      box.appendChild(row);
    }
    renderRecommend();
    // 历史
    const hbox = $('history-list');
    const hist = Store.getHistory();
    hbox.innerHTML = '';
    $('history-empty').style.display = hist.length ? 'none' : 'block';
    for (const h of hist) {
      const row = document.createElement('div');
      row.className = 'history-row';
      const prog = (h.pos || 0) > 10 ? ' · 看到 ' + fmtTime(h.pos) : '';
      row.innerHTML =
        '<div class="h-thumb" data-src="' + esc(h.pic || '') + '"></div>' +
        '<div class="h-info"><div class="h-name">' + esc(h.name) + '</div>' +
        '<div class="h-sub">' + esc(h.siteName || h.siteKey || '') + ' · ' + esc(h.episode || '') + esc(prog) + '</div></div>' +
        '<button data-act="del">✕</button>';
      row.addEventListener('click', () => openPlayerByRef(h));
      row.querySelector('[data-act="del"]').addEventListener('click', (e) => {
        e.stopPropagation();
        Store.removeHistory(h.siteKey, h.vodId);
        renderMine();
      });
      hbox.appendChild(row);
    }
    observePosters(hbox);
  }

  $('add-source-btn').addEventListener('click', async () => {
    const name = $('new-source-name').value.trim();
    const url = $('new-source-url').value.trim();
    if (!url) { toast('请输入配置地址'); return; }
    if (Store.addSource(name, url)) {
      state.sources.push({ name: name || url, url });
      toast('已添加 ' + (name || url));
      $('new-source-name').value = '';
      $('new-source-url').value = '';
      renderMine();
    } else {
      toast('该源已存在');
    }
  });

  // ===== 数据备份：导出 / 导入 =====
  $('export-btn').addEventListener('click', () => {
    const data = Store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '影视仓备份_' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 ' + data.sources.length + ' 个源 / ' + data.favs.length + ' 条收藏 / ' + data.history.length + ' 条历史');
  });

  $('import-btn').addEventListener('click', () => $('import-file').click());

  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); } catch (_) { toast('备份文件解析失败'); return; }
    if (!json || typeof json !== 'object' || !Array.isArray(json.sources)) { toast('不是有效的备份文件'); return; }
    // 弹层：合并 or 覆盖
    const dlg = document.createElement('div');
    dlg.className = 'ysc-dlg-mask';
    const box = document.createElement('div');
    box.className = 'ysc-dlg';
    box.innerHTML = '<h3>导入备份</h3>' +
      '<p class="ysc-dlg-tip">备份包含 ' +
      (json.sources || []).length + ' 个源、' + (json.favs || []).length + ' 条收藏、' + (json.history || []).length + ' 条历史。' +
      '合并会与现有数据去重叠加；覆盖会清空现有全部数据。</p>';
    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.className = 'p-btn' + (primary ? ' p-btn-primary' : '');
      b.textContent = label;
      return b;
    };
    const mergeBtn = mkBtn('合并导入', true);
    const replaceBtn = mkBtn('覆盖导入');
    const cancelBtn = mkBtn('取消');
    const done = async (mode) => {
      dlg.remove();
      try {
        Store.importAll(json, mode);
        toast(mode === 'replace' ? '已覆盖导入' : '已合并导入');
        // 刷新界面：收藏 / 源列表，并重新加载当前源
        renderFav();
        const curName = Store.getCurrentSource();
        const src = Store.getSources().find((s) => s.name === curName) || Store.getSources()[0];
        if (src) await switchSource(src, true);
        renderMine();
      } catch (err) { toast('导入失败：' + (err && err.message ? err.message : err)); }
    };
    mergeBtn.addEventListener('click', () => done('merge'));
    replaceBtn.addEventListener('click', () => done('replace'));
    cancelBtn.addEventListener('click', () => dlg.remove());
    const row = document.createElement('div');
    row.className = 'backup-bar';
    row.style.marginTop = '4px';
    row.append(mergeBtn, replaceBtn, cancelBtn);
    box.appendChild(row);
    dlg.appendChild(box);
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.remove(); });
    document.body.appendChild(dlg);
  });

  // ===== 播放页 =====
  async function openPlayer(site, video, resumeEp) {
    if (!video) return;
    const p = {
      site, video,
      groups: YSC_Cms.parseEpisodes(video.playUrl),
      g: 0, e: 0, hls: null, resumePos: 0
    };
    state.player = p;
    if (!p.groups.length) {
      // 列表数据可能不带播放地址，补拉详情
      toast('加载播放地址…');
      try {
        const d = await cms.detail(site, video.id);
        if (d && d.playUrl) { video.playUrl = d.playUrl; video.content = d.content || video.content; p.groups = YSC_Cms.parseEpisodes(d.playUrl); }
      } catch (e) { /* ignore */ }
      if (!p.groups.length) { toast('该影片暂无可播放的集数'); return; }
    }
    // 未指定集数时，从历史里恢复上次看到的集与进度
    if (!resumeEp) {
      const h = Store.getHistory().find((x) => x.siteKey === site.key && x.vodId === video.id);
      if (h && h.episode && (h.pos || 0) > 10) resumeEp = h.episode;
    }
    if (resumeEp) {
      const eps = p.groups[0];
      for (let i = 0; i < eps.length; i++) if (eps[i].name === resumeEp) { p.e = i; break; }
      const h = Store.getHistory().find((x) => x.siteKey === site.key && x.vodId === video.id);
      if (h && h.episode === resumeEp && (h.pos || 0) > 10) p.resumePos = h.pos;
    }
    $('player-page').style.display = 'flex';
    // 恢复点播模式的界面元素（上次可能是直播模式）
    $('p-desc').style.display = '';
    $('p-current-source').style.display = '';
    $('p-source-btn').style.display = '';
    $('p-fav-btn').style.display = '';
    $('p-eps').style.display = '';
    $('p-live-lines').style.display = 'none';
    $('p-live-lines').innerHTML = '';
    const spd = window.__yscSpeed || 1;
    $('p-speed-btn').textContent = '倍速 ' + (String(spd).replace(/0+$/, '').replace(/\.$/, '.0') || '1.0') + 'x';
    renderPlayerInfo();
    playEp(0, p.e);
    updateFavBtn();
  }

  function renderPlayerInfo() {
    const p = state.player;
    const v = p.video;
    $('p-title').textContent = v.name;
    const meta = [v.year, v.area, v.typeName || '影视', v.remarks].filter(Boolean).join(' · ');
    $('p-meta').textContent = meta;
    $('p-desc').textContent = v.content || '暂无简介';
    $('p-current-source').textContent = '当前源：' + (p.site.name || p.site.key);
    // 分组
    const gbox = $('p-groups');
    if (p.groups.length > 1) {
      gbox.style.display = 'flex';
      gbox.innerHTML = p.groups.map((g, i) =>
        '<div class="chip' + (i === p.g ? ' active' : '') + '" data-g="' + i + '">播放源' + (i + 1) + '</div>'
      ).join('');
      gbox.querySelectorAll('.chip').forEach((el) => {
        el.addEventListener('click', () => { p.g = +el.dataset.g; p.e = 0; renderPlayerInfo(); playEp(p.g, 0); });
      });
    } else gbox.style.display = 'none';
    // 选集
    const ebox = $('p-eps');
    const eps = p.groups[p.g] || [];
    ebox.innerHTML = eps.map((ep, i) =>
      '<div class="ep-btn' + (i === p.e ? ' active' : '') + '" data-e="' + i + '">' + esc(ep.name) + '</div>'
    ).join('');
    ebox.querySelectorAll('.ep-btn').forEach((el) => {
      el.addEventListener('click', () => playEp(p.g, +el.dataset.e));
    });
  }

  async function playEp(g, e) {
    const p = state.player;
    if (!p || !p.groups.length) return;
    const eps = p.groups[g] || p.groups[0];
    if (e < 0) e = 0;
    if (e >= eps.length) { toast('已经是最后一集了'); return; }
    p.g = g; p.e = e;
    renderPlayerInfo();
    // 历史续看
    Store.addHistory({
      siteKey: p.site.key, siteApi: p.site.api, siteName: p.site.name,
      vodId: p.video.id, name: p.video.name, pic: p.video.pic,
      remarks: p.video.remarks, episode: eps[e].name
    });
    let url = eps[e].url;
    if (!/^https?:/.test(url)) url = 'https://' + url;
    $('p-title').textContent = p.video.name + ' · ' + eps[e].name + '（解析中…）';
    try {
      url = await cms.resolvePlayUrl(url);
    } catch (err) { /* 用原地址 */ }
    $('p-title').textContent = p.video.name;
    attachVideo(url);
  }

  function attachVideo(url, opts = {}) {
    const video = $('video');
    const p = state.player;
    if (p && p.hls) { try { p.hls.destroy(); } catch (e) {} p.hls = null; }
    // 清理上一集的续播状态，避免带错位置
    if (p) { delete video.dataset.resumed; p.curUrl = url; }
    if (window.Hls && window.Hls.isSupported() && /\.m3u8/i.test(url)) {
      const hls = new Hls({ enableWorker: true });
      if (p) p.hls = hls;
      hls.loadSource(streamUrl(url));
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        // 直播：当前线路挂了就自动换下一条
        if (p && p.live && data.fatal && typeof p.curLine === 'number' && p.curLine < p.live.lines.length - 1) {
          toast('当前线路播放失败，切换到' + p.live.lines[p.curLine + 1].label);
          playLiveLine(p.curLine + 1);
          return;
        }
        if (data.fatal) toast('播放失败：' + (data.details || '流媒体错误'));
      });
    } else {
      video.src = streamUrl(url);
      // 直播直链失败也尝试换线
      video.onerror = () => {
        if (p && p.live && typeof p.curLine === 'number' && p.curLine < p.live.lines.length - 1) {
          toast('当前线路播放失败，切换到' + p.live.lines[p.curLine + 1].label);
          playLiveLine(p.curLine + 1);
        }
      };
    }
    // 保持用户选择的倍速
    if (window.__yscSpeed && window.__yscSpeed !== 1) {
      const apply = () => { try { video.playbackRate = window.__yscSpeed; } catch (e) {} };
      apply();
      video.addEventListener('loadedmetadata', apply, { once: true });
    }
    // ===== 断点续播：元数据就绪后跳到上次位置 =====
    if (p && p.resumePos > 10) {
      const pos = p.resumePos;
      const resume = () => {
        if (video.dataset.resumed) return;
        video.dataset.resumed = '1';
        try {
          // 直播流或未知时长不跳转
          if (isFinite(video.duration) && video.duration > 0 && pos < video.duration - 5) {
            video.currentTime = pos;
            toast('已续播 ' + fmtTime(pos));
          }
        } catch (e) { /* ignore */ }
      };
      video.addEventListener('loadedmetadata', resume, { once: true });
    }
    // ===== 进度节流保存（每 5 秒）+ 播放完毕保存一次（直播不记录） =====
    if (p && p.site) {
      let lastSave = 0;
      video.ontimeupdate = () => {
        const now = Date.now();
        if (now - lastSave < 5000) return;
        lastSave = now;
        Store.saveProgress(p.site.key, p.video.id, video.currentTime, video.duration);
      };
      video.onended = () => {
        Store.saveProgress(p.site.key, p.video.id, video.currentTime, video.duration);
        autoNext(p);
      };
    } else {
      video.ontimeupdate = null;
      video.onended = null;
    }
  }

  /** 自动连播：当前分组下一集 */
  function autoNext(p) {
    if (!p || !p.groups.length) return;
    const eps = p.groups[p.g] || p.groups[0];
    if (p.e < eps.length - 1) {
      const next = eps[p.e + 1];
      toast('自动播放下一集：' + next.name);
      p.resumePos = 0;
      playEp(p.g, p.e + 1);
    } else {
      toast('已播放完最后一集');
    }
  }

  $('player-back').addEventListener('click', closePlayer);
  function closePlayer() {
    const p = state.player;
    if (p) {
      const v = $('video');
      Store.saveProgress(p.site.key, p.video.id, v.currentTime, v.duration);
    }
    if (p && p.hls) { try { p.hls.destroy(); } catch (e) {} p.hls = null; }
    $('video').pause();
    $('video').removeAttribute('src');
    $('video').load();
    $('player-page').style.display = 'none';
    state.player = null;
  }

  function updateFavBtn() {
    const p = state.player;
    if (!p) return;
    const fav = Store.isFav(p.site.key, p.video.id);
    const btn = $('p-fav-btn');
    btn.textContent = fav ? '♥ 已收藏' : '♡ 收藏';
    btn.classList.toggle('faved', fav);
  }

  $('p-fav-btn').addEventListener('click', () => {
    const p = state.player;
    if (!p) return;
    Store.toggleFav({
      siteKey: p.site.key, siteApi: p.site.api, siteName: p.site.name,
      vodId: p.video.id, name: p.video.name, pic: p.video.pic, remarks: p.video.remarks
    });
    updateFavBtn();
    toast(Store.isFav(p.site.key, p.video.id) ? '已收藏' : '已取消收藏');
  });

  // 倍速切换：1.0 → 1.25 → 1.5 → 2.0 → 0.75 循环
  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
  $('p-speed-btn').addEventListener('click', () => {
    const video = $('video');
    const cur = video.playbackRate || 1;
    const next = SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length];
    video.playbackRate = next;
    window.__yscSpeed = next;
    $('p-speed-btn').textContent = '倍速 ' + next.toFixed(2).replace(/0+$/, '').replace(/\.$/, '.0') + 'x';
    toast('播放速度 ' + next + 'x');
  });

  // 外部播放：网页版无桌面播放器，提供"复制地址"与"新窗口打开"（可拖入 PotPlayer/VLC/mpv）
  $('p-ext-btn').addEventListener('click', async () => {
    const p = state.player;
    const url = p && p.curUrl;
    if (!url) { toast('当前没有可播放的地址'); return; }
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) { /* ignore */ }
        ta.remove();
      }
      toast('播放地址已复制，可粘贴到 PotPlayer / VLC / mpv 播放');
    };
    // 弹层：复制 or 新窗口
    const dlg = document.createElement('div');
    dlg.className = 'ysc-dlg-mask';
    const box = document.createElement('div');
    box.className = 'ysc-dlg';
    box.innerHTML = '<h3>外部播放</h3><p class="ysc-dlg-tip">复制下面的地址，粘贴到本地播放器（PotPlayer / VLC / mpv 均支持直接打开网络流）：</p>' +
      '<div class="ysc-dlg-url">' + esc(url) + '</div>';
    const row = document.createElement('div');
    row.className = 'ysc-dlg-actions';
    const b1 = document.createElement('button');
    b1.className = 'p-btn p-btn-primary';
    b1.textContent = '复制地址';
    b1.addEventListener('click', () => { dlg.remove(); copy(); });
    const b2 = document.createElement('button');
    b2.className = 'p-btn';
    b2.textContent = '新窗口打开';
    b2.addEventListener('click', () => { window.open(url, '_blank'); dlg.remove(); });
    const b3 = document.createElement('button');
    b3.className = 'p-btn';
    b3.textContent = '取消';
    b3.addEventListener('click', () => dlg.remove());
    row.append(b1, b2, b3);
    box.appendChild(row);
    dlg.appendChild(box);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
    document.body.appendChild(dlg);
  });

  // 换源：并发搜索其它源同名影片
  $('p-source-btn').addEventListener('click', async () => {
    const p = state.player;
    if (!p) return;
    if (!state.searchSources.length) { toast('当前数据源不可用，请先切换数据源'); return; }
    const others = state.searchSources.filter((s) => s.key !== p.site.key).slice(0, 6);
    if (!others.length) {
      // 单站点仓（如 provide/vod 直连续）没有可换的播放源，给出明确指引
      toast(state.searchSources.length <= 1
        ? '当前仓只有 1 个站点，没有可换的源；切换到多站点数据源（如推荐源里的仓）后再试'
        : '其它源未找到同名影片');
      return;
    }
    toast('正在搜索其它源…');
    const kw = p.video.name;
    const kwNorm = normalizeName(kw);
    const jobs = others.map(async (s) => {
      try {
        const list = await cms.search(s, kw);
        // 优先归一化片名匹配（兼容【】/（）/年份/清晰度等差异），退化原名精确匹配
        const hit = (kwNorm && list.find((v) => normalizeName(v.name) === kwNorm)) ||
                    list.find((v) => v.name === kw);
        return hit ? { site: s, video: hit } : null;
      } catch (e) { return null; }
    });
    const hits = (await Promise.all(jobs)).filter(Boolean);
    if (!hits.length) { toast('其它源未找到同名影片'); return; }
    // 简单选择器：用弹层列表
    const dlg = document.createElement('div');
    dlg.className = 'ysc-dlg-mask';
    const box = document.createElement('div');
    box.className = 'ysc-dlg';
    box.innerHTML = '<h3>切换到其它源</h3>';
    for (const h of hits) {
      const row = document.createElement('div');
      row.className = 'source-row';
      row.style.cursor = 'pointer';
      row.innerHTML = '<span class="sr-name">' + esc(h.site.name) + '</span><span class="sr-url">' + esc(h.video.remarks || '') + '</span>';
      row.addEventListener('click', () => {
        dlg.remove();
        closePlayer();
        openPlayer(h.site, h.video);
      });
      box.appendChild(row);
    }
    const close = document.createElement('button');
    close.className = 'p-btn';
    close.textContent = '取消';
    close.style.marginTop = '12px';
    close.addEventListener('click', () => dlg.remove());
    box.appendChild(close);
    dlg.appendChild(box);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.remove(); });
    document.body.appendChild(dlg);
  });

  // 键盘快捷键（播放页打开时生效）
  document.addEventListener('keydown', (e) => {
    const video = $('video');
    if ($('player-page').style.display === 'none') return;
    // 输入框聚焦时不拦截
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    switch (e.key) {
      case 'Escape':
        // 全屏时先退出全屏，再按才关闭播放页
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else closePlayer();
        break;
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        if (video.paused) video.play().catch(() => {}); else video.pause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
        video.muted = false;
        toast('音量 ' + Math.round(video.volume * 100) + '%');
        break;
      case 'ArrowDown':
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
        toast('音量 ' + Math.round(video.volume * 100) + '%');
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen();
        else video.requestFullscreen().catch(() => {});
        break;
      case 'm':
      case 'M':
        video.muted = !video.muted;
        toast(video.muted ? '已静音' : '已取消静音');
        break;
    }
  });

  // ===== 启动 =====
  renderSearchSourceChips();
  boot();
})();
