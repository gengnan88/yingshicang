/** 苹果CMS V10 接口客户端（移植自安卓版 Repo/Video：列表/搜索/详情/缺图补拉/分享页解析） */

const UA_BROWSER = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

class CmsClient {
  constructor(net) {
    this.net = net; // { fetch(url, ua), fetchText(url) }
  }

  async fetchJson(url, ua) {
    const r = await this.net.fetch(url, ua || UA_BROWSER);
    if (!r || !r.body) throw new Error('空响应');
    return JSON.parse(r.body);
  }

  apiUrl(site, ac) {
    let base = site.api || '';
    if (!base.endsWith('/') && !base.endsWith('=')) base += '/';
    if (!base.includes('ac=')) base += (base.includes('?') ? '&' : '?') + 'ac=' + ac;
    return base;
  }

  async categories(site) {
    const d = await this.fetchJson(this.apiUrl(site, 'list'));
    const list = Array.isArray(d.class) ? d.class : [];
    return list.map((c) => ({ id: String(c.type_id || ''), name: String(c.type_name || '') }))
      .filter((c) => c.id);
  }

  async list(site, typeId, page) {
    let url = this.apiUrl(site, 'detail') + '&pg=' + (page || 1);
    if (typeId) url += '&t=' + encodeURIComponent(typeId);
    const d = await this.fetchJson(url);
    const videos = (Array.isArray(d.list) ? d.list : []).map(videoFromJson);
    await this.fillMissingPics(site, videos);
    return videos;
  }

  async search(site, kw) {
    const url = this.apiUrl(site, 'detail') + '&wd=' + encodeURIComponent(kw);
    const d = await this.fetchJson(url);
    const videos = (Array.isArray(d.list) ? d.list : []).map(videoFromJson);
    await this.fillMissingPics(site, videos);
    return videos;
  }

  async detail(site, vodId) {
    const url = this.apiUrl(site, 'detail') + '&ids=' + encodeURIComponent(vodId);
    const d = await this.fetchJson(url);
    const arr = Array.isArray(d.list) ? d.list : [];
    return arr.length ? videoFromJson(arr[0]) : null;
  }

  /** 列表接口不返回 vod_pic 的源（如非凡资源）：用 ids 批量补拉详情海报 */
  async fillMissingPics(site, videos) {
    if (!videos || !videos.length) return;
    const ids = [];
    for (const v of videos) {
      if ((!v.pic || !v.pic.trim()) && v.id && ids.length < 20 && !ids.includes(v.id)) ids.push(v.id);
    }
    if (!ids.length) return;
    try {
      const url = this.apiUrl(site, 'detail') + '&ids=' + encodeURIComponent(ids.join(','));
      const d = await this.fetchJson(url);
      const map = {};
      for (const v of (Array.isArray(d.list) ? d.list : [])) {
        if (v.vod_pic && String(v.vod_pic).trim()) map[String(v.vod_id)] = String(v.vod_pic);
      }
      for (const v of videos) {
        if ((!v.pic || !v.pic.trim()) && map[v.id]) v.pic = map[v.id];
      }
    } catch (e) { /* 静默跳过 */ }
  }

  /** 分享页地址解析：真实 m3u8 藏在 const url = "xxx.m3u8" 里 */
  async resolvePlayUrl(url) {
    const lower = (url || '').toLowerCase();
    if (/\.(m3u8|mp4|flv|mkv|ts)(\?|$)/.test(lower)) return url;
    try {
      const r = await this.net.fetch(url, UA_BROWSER);
      const ct = (r.contentType || '').toLowerCase();
      if (ct && !ct.includes('text/html') && !ct.includes('xhtml')) return url;
      const head = (r.body || '').slice(0, 64 * 1024);
      const m = head.match(/url\s*[:=]\s*["']([^"']*\.m3u8[^"']*)["']/);
      if (m) return absolutize(m[1], url);
    } catch (e) { /* fallthrough */ }
    return url;
  }
}

function absolutize(inner, baseUrl) {
  try {
    if (inner.startsWith('//')) return 'https:' + inner;
    if (inner.startsWith('/')) {
      const b = new URL(baseUrl);
      return b.protocol + '//' + b.host + inner;
    }
    if (!/^https?:/.test(inner)) {
      const b = new URL(baseUrl);
      const dir = b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1) || '/';
      return b.protocol + '//' + b.host + dir + inner;
    }
  } catch (e) { /* ignore */ }
  return inner;
}

function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function videoFromJson(o) {
  return {
    id: String(o.vod_id || ''),
    name: String(o.vod_name || ''),
    pic: String(o.vod_pic || ''),
    remarks: String(o.vod_remarks || ''),
    typeName: String(o.type_name || ''),
    year: String(o.vod_year || ''),
    area: String(o.vod_area || ''),
    actor: String(o.vod_actor || ''),
    director: String(o.vod_director || ''),
    content: stripHtml(o.vod_content || ''),
    playFrom: String(o.vod_play_from || ''),
    playUrl: String(o.vod_play_url || '')
  };
}

/** 解析播放列表：vod_play_url 格式 集名$URL#集名$URL$$$分组 */
function parseEpisodes(playUrl) {
  const groups = [];
  if (!playUrl) return groups;
  for (const block of String(playUrl).split('$$$')) {
    const eps = [];
    for (let ep of block.split('#')) {
      ep = ep.trim();
      if (!ep) continue;
      const d = ep.indexOf('$');
      if (d > 0) eps.push({ name: ep.substring(0, d), url: ep.substring(d + 1) });
      else eps.push({ name: ep, url: ep });
    }
    if (eps.length) groups.push(eps);
  }
  return groups;
}

const CmsApi = { CmsClient, parseEpisodes, videoFromJson, stripHtml, UA_BROWSER };
if (typeof module !== 'undefined' && module.exports) module.exports = CmsApi;
if (typeof window !== 'undefined') window.YSC_Cms = CmsApi;
