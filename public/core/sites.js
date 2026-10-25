/** TVBox 配置解析（移植自安卓版 Site.java：注释剥离 / 控制字符清洗 / 尾逗号修复 / 宽松回退） */

function stripComments(raw) {
  const out = [];
  let inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out.push(c);
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') { inStr = true; out.push(c); }
      else if (c === '/' && i + 1 < raw.length && raw[i + 1] === '/') {
        while (i < raw.length && raw[i] !== '\n') i++;
      } else out.push(c);
    }
  }
  return out.join('');
}

function sanitize(raw) {
  const out = [];
  let inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out.push(c);
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') { inStr = true; out.push(c); }
      else if (c.charCodeAt(0) < 0x20) { /* 丢弃控制字符 */ }
      else if (c === ',') {
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j])) j++;
        if (j < raw.length && (raw[j] === '}' || raw[j] === ']')) continue;
        out.push(c);
      }
      else out.push(c);
    }
  }
  return out.join('');
}

function looksLikeConfig(raw) {
  if (!raw) return false;
  const c = stripComments(raw);
  return c.includes('"sites"') && (c.includes('"key"') || c.includes('"api"'));
}

function siteFromJson(o) {
  const jar = (o.jar && String(o.jar)) || (o.spider && String(o.spider)) || '';
  return {
    key: String(o.key || ''),
    name: String(o.name || o.key || ''),
    type: parseInt(o.type || '0', 10) || 0,
    api: String(o.api || ''),
    jar,
    searchable: (parseInt(o.searchable === undefined ? 1 : o.searchable, 10) || 0) === 1
  };
}

function collectSites(root) {
  const out = [];
  const skipped = { jar: 0, spider: 0 };
  const arr = root && root.sites;
  if (!Array.isArray(arr)) return { sites: out, skipped };
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const s = siteFromJson(o);
    if (!s.key || !s.api) continue;
    if (s.jar) { skipped.jar++; continue; }        // jar 爬虫源：网页版无法运行 Java 爬虫
    if (s.type !== 1) { skipped.spider++; continue; } // 仅支持苹果CMS type=1
    out.push(s);
  }
  return { sites: out, skipped };
}

/** 收集配置里的直播源 lives：[{name, url}]（url 指向 txt/m3u 地址） */
function collectLives(root) {
  const out = [];
  const arr = root && root.lives;
  if (!Array.isArray(arr)) return out;
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const url = String(o.url || o.link || '').trim();
    if (!url) continue;
    out.push({ name: String(o.name || o.title || '直播源'), url });
  }
  return out;
}

/** 完整解析：站点 + 直播源 */
function parseConfig(raw) {
  const parseRoot = (txt) => {
    try { return JSON.parse(sanitize(stripComments(txt))); }
    catch (e) {
      try {
        let cleaned = sanitize(stripComments(txt).trim());
        const brace = cleaned.indexOf('{');
        if (brace > 0) cleaned = cleaned.substring(brace);
        return JSON.parse(cleaned);
      } catch (e2) { return null; }
    }
  };
  const root = parseRoot(raw);
  if (!root) return { sites: [], lives: [], skipped: { jar: 0, spider: 0 } };
  const r = collectSites(root);
  return { sites: r.sites, lives: collectLives(root), skipped: r.skipped };
}

function parseAll(raw) {
  return parseConfig(raw).sites;
}

/* ============ 多仓解析（FongMi dc / room 等格式） ============
 * 两种形态：
 *  1) JSON：{"urls":[{"name":"xx","url":"http://..."}, ...]} 或直接 [{name,url}, ...]
 *     （xhztv 的 DC.txt 也是这种 JSON，只是带 // 注释头）
 *  2) TXT 每行：`名字,地址` / `名字$地址` / `名字|地址`，支持 // 与 # 注释行
 */
function looksLikeMulti(raw) {
  if (!raw) return false;
  if (stripComments(raw).includes('"urls"')) return true;
  // 行格式探测（用原始行：stripComments 会把 URL 的 // 误当注释，不能用于行格式）
  return String(raw).split(/\r?\n/).some((l) => {
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) return false;
    // 整行形如 名字,http://...（名字部分不含逗号/引号/大括号，避免误判普通单仓 JSON）
    return /^[^,{}"']+[,|$]\s*https?:\/\//i.test(t);
  });
}

function parseMulti(raw) {
  const out = [];
  const push = (name, url) => {
    url = String(url || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (out.some((x) => x.url === url)) return;
    out.push({ name: String(name || '').trim() || url, url });
  };
  const cleaned = sanitize(stripComments(raw));
  // 1) JSON 形态
  let root = null;
  try { root = JSON.parse(cleaned); } catch (e) {
    try {
      let s = cleaned.trim();
      const i = s.indexOf('{');
      if (i > 0) s = s.substring(i);
      root = JSON.parse(s);
    } catch (e2) { root = null; }
  }
  if (root && typeof root === 'object') {
    let arr = null;
    if (Array.isArray(root)) arr = root;
    else if (Array.isArray(root.urls)) arr = root.urls;
    else if (Array.isArray(root.sites)) arr = root.sites;
    if (arr) {
      for (const o of arr) {
        if (!o || typeof o !== 'object') continue;
        push(o.name || o.title || '', o.url || o.link || o.api || '');
      }
      return out;
    }
  }
  // 2) 行格式（用原始行：URL 里的 // 不能被当注释剥掉）
  for (const line of String(raw).split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('//') || l.startsWith('#') || l.startsWith('{') || l.startsWith('[')) continue;
    const m = l.match(/^(.+?)\s*[,|$]\s*(https?:\/\/\S+)\s*$/i);
    if (m) push(m[1], m[2]);
  }
  return out;
}

/** 内置源（与安卓版一致） */
const BUILTIN_SOURCES = [
  // 本地聚合源：tools/probe-sources.js 在路由器网络实测生成（12 个可用站点 + 游魂直播），同源加载永不失效
  { name: '本地聚合源', url: '/local.json' },
  { name: '影视仓官方', url: 'http://www.影视仓.com/' },
  { name: '光速资源', url: 'https://api.guangsuapi.com/api.php/provide/vod/' },
  { name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod/' },
  { name: '索尼资源', url: 'https://suoniapi.com/api.php/provide/vod/' },
  { name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod/' }
];

/** 推荐源清单（社区常用，按用户提供的地址整理；可达性因本地网络而异，添加前可先测试） */
const RECOMMEND_SINGLE = [
  { name: '饭太硬', url: 'http://www.饭太硬.com/tv' },
  { name: '肥猫', url: 'http://肥猫.com' },
  { name: '神秘哥哥们备用', url: 'http://fty.xxooo.cf/tv' },
  { name: '毒盒', url: 'https://毒盒.com/tv/' },
  { name: '摸鱼儿', url: 'http://我不是.摸鱼儿.com' },
  { name: 'OK影视内部', url: 'http://ok321.top/tv' },
  { name: 'OK影视公开', url: 'http://ok321.top/ok' },
  { name: '王小二放牛娃', url: 'http://tvbox.王二小放牛娃.top' },
  { name: '动漫城', url: 'https://www.yingm.cc/dm/dm.json' },
  { name: '俊佬', url: 'http://home.jundie.top:81/top98.json' },
  { name: '巧记', url: 'http://cdn.qiaoji8.com/tvbox.json' },
  { name: '道长', url: 'https://cdn.gitmirror.com/bb/xduo/libs/master/index.json' },
  { name: 'T4', url: 'https://gitee.com/free-kingdom/dc/raw/main/T4.json' },
  { name: '南风', url: 'https://raw.githubusercontent.com/yoursmile66/TVBox/main/XC.json' },
  { name: '菜妮丝', url: 'https://tv.菜妮丝.top' },
  { name: 'HG', url: 'https://api.hgyx.vip/hgyx.json' },
  { name: 'dxawi', url: 'https://dxawi.github.io/0/0.json' },
  { name: '小米', url: 'http://www.mitvbox.xyz/小米/DEMO.json' },
  { name: '小盒子单仓', url: 'http://xhztv.top/xhz' },
  { name: '小盒子4K', url: 'http://xhztv.top/4k.json' },
  { name: '潇洒', url: 'https://9877.kstore.space/AnotherD/api.json' },
  { name: '香雅情', url: 'https://raw.githubusercontent.com/xyq254245/xyqonlinerule/main/XYQTVBox.json' },
  { name: '小苹果', url: 'https://bitbucket.org/xduo/duoapi/raw/master/xpg.json' },
  { name: '宝盒VIP', url: 'https://raw.githubusercontent.com/guot55/YGBH/main/vip2.json' },
  { name: '欧歌', url: 'http://tv.nxog.top/m/111.php?ou=%E5%85%AC%E4%BC%97%E5%8F%B7%E6%AC%A7%E6%AD%8Capp&mz=all&jar=all&b=%E6%AC%A7%E6%AD%8C' },
  { name: '哪吒', url: 'https://哪吒.live/' },
  { name: '真心', url: 'http://www.252035.xyz/z/FongMi.json' },
  { name: '喵影视', url: 'http://www.meowtv.vip/tvbox.json' },
  { name: '驸马', url: 'http://fmys.top/fmys.json' },
  { name: '高天流云', url: 'https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json' },
  { name: '青龙', url: 'https://gitee.com/yiwu369/6758/raw/master/%E9%9D%92%E9%BE%99/1.json' },
  { name: '分享', url: 'https://raw.githubusercontent.com/maoystv/6/main/000.json' },
  { name: '短剧', url: 'https://cnb.cool/fish2018/duanju/-/git/raw/main/tvbox.json' }
];

const RECOMMEND_MULTI = [
  { name: '游魂多仓', url: 'https://www.iyouhun.com/tv/dc' },
  { name: '游魂多仓（备）', url: 'https://www.iyouhun.com/tv/yh' },
  { name: '潇洒多仓', url: 'https://9877.kstore.space/AnotherDS/api.json' },
  { name: '小盒子多仓', url: 'http://xhztv.top/dc/' },
  { name: '小盒子多仓（备）', url: 'http://xhztv.top/DC.txt' },
  { name: '多多影音', url: 'https://bitbucket.org/xduo/cool/raw/main/room.json' },
  { name: '七星宝盒', url: 'https://qixing.myhkw.com/DC.txt' },
  { name: '拾光多仓', url: 'http://xmbjm.fh4u.org/dc.txt' }
];

const RECOMMEND_LIVES = [
  { name: '游魂直播源', url: 'https://www.iyouhun.com/tv/zb' },
  { name: '直播电视IPV4', url: 'https://live.zbds.top/tv/iptv4.txt' },
  { name: '宝盒直播', url: 'https://3043.kstore.space/bhvip/bhzb.txt' },
  { name: '潇洒AI直播（txt）', url: 'https://raw.githubusercontent.com/PizazzGY/TV/master/output/user_result.txt' },
  { name: '潇洒AI直播（m3u）', url: 'https://raw.githubusercontent.com/PizazzGY/TV/master/output/user_result.m3u' },
  { name: 'IPTV默认源', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u' },
  { name: 'IPTV IPv4', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/ipv4/result.m3u' },
  { name: 'IPTV IPv6', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/ipv6/result.m3u' },
  { name: 'myIPTV IPv4', url: 'https://raw.githubusercontent.com/suxuang/myIPTV/refs/heads/main/ipv4.m3u' },
  { name: 'myIPTV IPv6', url: 'https://raw.githubusercontent.com/suxuang/myIPTV/refs/heads/main/ipv6.m3u' },
  { name: 'M3U直播源（带台标EPG）', url: 'https://live.zbds.top/tv/iptv4.m3u' },
  { name: 'BurningC4', url: 'https://raw.githubusercontent.com/BurningC4/Chinese-IPTV/master/TV-IPV4.m3u' },
  { name: '茶客源', url: 'https://raw.githubusercontent.com/vamoschuck/TV/main/M3U' },
  { name: '范明明直播源', url: 'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u' },
  { name: '范明明国内镜像', url: 'https://live.fanmingming.cn/tv/m3u/ipv6.m3u' },
  { name: 'YueChan直播源', url: 'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u' },
  { name: 'gitee综合源', url: 'https://gitee.com/xxy002/zhiboyuan/raw/master/dsy' }
];

const SitesApi = {
  stripComments, sanitize, looksLikeConfig, parseAll, parseConfig, collectLives,
  looksLikeMulti, parseMulti,
  BUILTIN_SOURCES, RECOMMEND_SINGLE, RECOMMEND_MULTI, RECOMMEND_LIVES
};
if (typeof module !== 'undefined' && module.exports) module.exports = SitesApi;
if (typeof window !== 'undefined') window.YSC_Sites = SitesApi;
