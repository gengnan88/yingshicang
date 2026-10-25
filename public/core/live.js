/** 直播源解析：TVBox lives 地址 → txt(#genre#) / m3u 两种格式 → 分组频道树 */

function absolutize(url, base) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  try { return new URL(url, base).toString(); } catch (e) { return url; }
}

/**
 * 解析直播文本。
 * 返回 [{ name: 分组名, channels: [{ name, lines: [{ label, url }] }] }]
 * - txt 格式：`分组名,#genre#` 开新组；`频道名,地址` 一行一线；同名频道多行 = 多线路
 * - m3u 格式：`#EXTINF:-1 group-title="X",名` + 下一行地址；`#EXTGRP:X` 指定分组
 * - 也容忍 `频道名$地址`（部分源用 $ 分隔）与 rtsp/rtmp 等协议
 */
function parseLiveText(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let curGroup = null;
  const groupOf = (name) => {
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, channels: [] }; groups.push(g); }
    return g;
  };
  const addChannel = (g, name, url, label) => {
    if (!name || !url) return;
    let ch = g.channels.find((c) => c.name === name);
    if (!ch) { ch = { name, lines: [] }; g.channels.push(ch); }
    const u = absolutize(url.trim(), baseUrl);
    if (!ch.lines.some((l) => l.url === u)) ch.lines.push({ label: label || ('线路' + (ch.lines.length + 1)), url: u });
  };

  let pending = null; // m3u 的 #EXTINF 信息
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    // ===== m3u =====
    if (line.startsWith('#EXTM3U')) continue;
    if (/^#EXTINF/i.test(line)) {
      const m = line.match(/,(.*)$/);
      const name = m ? m[1].trim() : '';
      const g = line.match(/group-title="([^"]*)"/i);
      const grp = line.match(/#EXTGRP:(.*)$/i);
      pending = {
        name,
        group: (g && g[1] ? g[1].trim() : '') || (grp ? grp[1].trim() : '') || '默认分组'
      };
      continue;
    }
    if (line.startsWith('#')) continue; // 其它 # 指令忽略（EXTVLCOPT 等）

    // ===== m3u 模式：#EXTINF 之后的当前行就是地址 =====
    if (pending) {
      addChannel(groupOf(pending.group), pending.name, line, '');
      pending = null;
      continue;
    }

    // ===== txt：分组行 =====
    const genre = line.match(/^(.*?)\s*,\s*#genre#\s*$/i);
    if (genre) {
      curGroup = groupOf(genre[1].trim() || '默认分组');
      pending = null;
      continue;
    }

    // ===== 频道行 =====
    let name = '', url = '', label = '';
    const comma = line.split(',');
    if (comma.length >= 2 && /^(https?|rtmp|rtsp|p2p|webrtc):/i.test(comma[comma.length - 1].trim())) {
      // 频道名[,标签],地址（地址在最后）
      url = comma.pop().trim();
      name = comma[0].trim();
      label = comma.length > 1 ? comma.slice(1).join(',').trim() : '';
    } else {
      const dollar = line.split('$');
      if (dollar.length >= 2 && /^(https?|rtmp|rtsp|p2p|webrtc):/i.test(dollar[dollar.length - 1].trim())) {
        url = dollar.pop().trim();
        name = dollar[0].trim();
        label = dollar.length > 1 ? dollar.slice(1).join('$').trim() : '';
      } else {
        continue; // 不是频道行
      }
    }
    if (!/^(https?|rtmp|rtsp|p2p|webrtc):/i.test(url)) continue;
    const g = pending ? groupOf(pending.group) : (curGroup || groupOf('默认分组'));
    const chName = (pending && pending.name) || name;
    addChannel(g, chName, url, pending ? '' : label);
    pending = null;
  }
  return groups;
}

/** 合并多个源解析出的分组（同名分组合并，同名频道多线路合并） */
function mergeGroups(list) {
  const out = [];
  for (const groups of list) {
    for (const g of groups) {
      let dst = out.find((x) => x.name === g.name);
      if (!dst) { dst = { name: g.name, channels: [] }; out.push(dst); }
      for (const ch of g.channels) {
        let c = dst.channels.find((x) => x.name === ch.name);
        if (!c) { c = { name: ch.name, lines: [] }; dst.channels.push(c); }
        for (const l of ch.lines) {
          if (!c.lines.some((x) => x.url === l.url)) c.lines.push(l);
        }
      }
    }
  }
  return out;
}

const LiveApi = { parseLiveText, mergeGroups, absolutize };
if (typeof module !== 'undefined' && module.exports) module.exports = LiveApi;
if (typeof window !== 'undefined') window.YSC_Live = LiveApi;
