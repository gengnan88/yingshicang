/** 豆瓣榜单（rexxar 移动端 API）：热播电影 / 热播剧集 / Top250 / 热播综艺 / 新片速递
 *  说明：豆瓣 PC 端 search_subjects 接口已被 sec.douban.com 风控，
 *  改用 m.douban.com rexxar subject_collection（需带浏览器 UA + Referer）。 */

const DOUBAN_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

const DOUBAN_CATEGORIES = [
  { id: 'movie_hot_gaia', name: '热播电影', referer: 'https://m.douban.com/movie/' },
  { id: 'tv_hot', name: '热播剧集', referer: 'https://m.douban.com/tv/' },
  { id: 'movie_top250', name: '豆瓣Top250', referer: 'https://m.douban.com/movie/' },
  { id: 'show_hot', name: '热播综艺', referer: 'https://m.douban.com/tv/' },
  { id: 'movie_latest', name: '新片速递', referer: 'https://m.douban.com/movie/' }
];

const DOUBAN_PAGE = 30;

function doubanItemFromJson(o) {
  const rating = (o.rating && (o.rating.value || o.rating.value === 0)) ? Number(o.rating.value) : 0;
  return {
    id: String(o.id || ''),
    name: String(o.title || ''),
    pic: (o.cover && o.cover.url) || String(o.cover_url || ''),
    remarks: rating ? rating.toFixed(1) + '分' : '',
    year: String(o.year || ''),
    info: String(o.info || ''),
    sub: String(o.card_subtitle || ''),
    url: String(o.url || ''),
    _douban: true
  };
}

/** 拉取一个豆瓣榜单分页。start 从 0 开始。返回 {items, total} */
async function doubanList(net, catId, start, count) {
  const cat = DOUBAN_CATEGORIES.find((c) => c.id === catId) || DOUBAN_CATEGORIES[0];
  const url = 'https://m.douban.com/rexxar/api/v2/subject_collection/' + encodeURIComponent(cat.id) +
    '/items?start=' + Math.max(0, start | 0) + '&count=' + (count || DOUBAN_PAGE);
  const r = await net.fetch(url, DOUBAN_UA, cat.referer);
  if (!r || !r.body) throw new Error('豆瓣接口无响应');
  let d;
  try { d = JSON.parse(r.body); } catch (e) { throw new Error('豆瓣接口返回异常'); }
  const arr = Array.isArray(d.subject_collection_items) ? d.subject_collection_items : [];
  return { items: arr.map(doubanItemFromJson), total: Number(d.total || arr.length) };
}

const DoubanApi = { categories: DOUBAN_CATEGORIES, pageSize: DOUBAN_PAGE, list: doubanList, itemFromJson: doubanItemFromJson, UA: DOUBAN_UA };
if (typeof module !== 'undefined' && module.exports) module.exports = DoubanApi;
if (typeof window !== 'undefined') window.YSC_Douban = DoubanApi;
