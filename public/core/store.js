/** 本地存储：数据源 / 收藏 / 历史（localStorage 持久化，对应安卓版 Prefs + Store） */

const KEY_SOURCES = 'ysc_sources';      // 自定义源 [{name, url}]
const KEY_CUR_SOURCE = 'ysc_cur_source'; // 当前源名
const KEY_HOME_MODE = 'ysc_home_mode';   // 首页数据源：'douban' | 'site'
const KEY_HOME_SITE = 'ysc_home_site';   // site 模式下使用的站点 key
const KEY_FAVS = 'ysc_favs';
const KEY_HISTORY = 'ysc_history';

function read(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : def;
  } catch (e) { return def; }
}
function write(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

const Store = {
  // ===== 数据源 =====
  getSources() { return read(KEY_SOURCES, []); },
  addSource(name, url) {
    const list = this.getSources();
    if (list.some((s) => s.url === url)) return false;
    list.push({ name: name || url, url });
    write(KEY_SOURCES, list);
    return true;
  },
  removeSource(url) {
    write(KEY_SOURCES, this.getSources().filter((s) => s.url !== url));
  },
  getCurrentSource() { return read(KEY_CUR_SOURCE, null); },
  setCurrentSource(name) { write(KEY_CUR_SOURCE, name); },

  // ===== 首页数据源（douban=豆瓣榜单，site=指定站点） =====
  getHomeMode() { return read(KEY_HOME_MODE, 'douban'); },
  setHomeMode(mode) { write(KEY_HOME_MODE, mode === 'site' ? 'site' : 'douban'); },
  getHomeSite() { return read(KEY_HOME_SITE, ''); },
  setHomeSite(key) { write(KEY_HOME_SITE, key || ''); },

  // ===== 收藏 =====
  getFavs() { return read(KEY_FAVS, []); },
  isFav(siteKey, vodId) { return this.getFavs().some((f) => f.siteKey === siteKey && f.vodId === vodId); },
  toggleFav(item) {
    let list = this.getFavs();
    const i = list.findIndex((f) => f.siteKey === item.siteKey && f.vodId === item.vodId);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({ ...item, ts: Date.now() });
    write(KEY_FAVS, list);
    return i < 0;
  },

  // ===== 历史（续看） =====
  getHistory() { return read(KEY_HISTORY, []); },
  addHistory(item) {
    let list = this.getHistory();
    const i = list.findIndex((h) => h.siteKey === item.siteKey && h.vodId === item.vodId);
    if (i >= 0) list.splice(i, 1);
    list.unshift({ ...item, ts: Date.now() });
    if (list.length > 100) list = list.slice(0, 100);
    write(KEY_HISTORY, list);
  },
  removeHistory(siteKey, vodId) {
    write(KEY_HISTORY, this.getHistory().filter((h) => !(h.siteKey === siteKey && h.vodId === vodId)));
  },
  /** 记录某部片子的播放进度（不改变历史排序位置） */
  saveProgress(siteKey, vodId, pos, dur) {
    if (!(pos > 0)) return;
    const list = this.getHistory();
    const h = list.find((x) => x.siteKey === siteKey && x.vodId === vodId);
    if (!h) return;
    h.pos = Math.round(pos);
    if (dur && isFinite(dur) && dur > 0) h.dur = Math.round(dur);
    write(KEY_HISTORY, list);
  },
  getProgress(siteKey, vodId) {
    const h = this.getHistory().find((x) => x.siteKey === siteKey && x.vodId === vodId);
    return h && h.pos > 0 ? { pos: h.pos, dur: h.dur || 0 } : null;
  },

  // ===== 备份导出 / 导入 =====
  exportAll() {
    return {
      app: 'yingshicang-pc', version: 1, exportedAt: new Date().toISOString(),
      sources: this.getSources(),
      currentSource: this.getCurrentSource(),
      homeMode: this.getHomeMode(),
      homeSite: this.getHomeSite(),
      favs: this.getFavs(),
      history: this.getHistory()
    };
  },
  /**
   * 导入备份。mode: 'merge' 合并（按 url/siteKey+vodId 去重）| 'replace' 覆盖
   * 返回 {sources, favs, history} 各新增条数
   */
  importAll(json, mode) {
    const src = Array.isArray(json.sources) ? json.sources : [];
    const fav = Array.isArray(json.favs) ? json.favs : [];
    const his = Array.isArray(json.history) ? json.history : [];
    if (mode === 'replace') {
      write(KEY_SOURCES, src);
      write(KEY_FAVS, fav);
      write(KEY_HISTORY, his);
      if (json.currentSource) write(KEY_CUR_SOURCE, json.currentSource);
      if (json.homeMode) this.setHomeMode(json.homeMode);
      if (json.homeSite !== undefined) this.setHomeSite(json.homeSite);
      return { sources: src.length, favs: fav.length, history: his.length };
    }
    // merge
    let sl = this.getSources();
    let ns = 0;
    for (const s of src) {
      if (s && s.url && !sl.some((x) => x.url === s.url)) { sl.push(s); ns++; }
    }
    write(KEY_SOURCES, sl);
    let fl = this.getFavs();
    let nf = 0;
    for (const f of fav) {
      if (f && !fl.some((x) => x.siteKey === f.siteKey && x.vodId === f.vodId)) { fl.unshift(f); nf++; }
    }
    write(KEY_FAVS, fl);
    let hl = this.getHistory();
    let nh = 0;
    for (const h of his) {
      const i = hl.findIndex((x) => x.siteKey === h.siteKey && x.vodId === h.vodId);
      if (i >= 0) {
        // 已有：保留进度更大的
        if ((h.pos || 0) > (hl[i].pos || 0)) { hl[i] = h; nh++; }
      } else { hl.unshift(h); nh++; }
    }
    write(KEY_HISTORY, hl);
    return { sources: ns, favs: nf, history: nh };
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = Store;
if (typeof window !== 'undefined') window.YSC_Store = Store;
