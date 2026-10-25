/**
 * 多维筛选：浏览器侧的状态与 URL 组合（纯函数，不碰 DOM）。
 *
 * 两个页面共用：
 *   - 影视仓 dyrs.html：筛选值来自上游页面解析出来的 href
 *   - 主库   index.html：筛选值来自 /api/facets 的静态词表
 *
 * 为什么要单独一个文件：
 *   上游（wzzycc 模板）给的筛选链接**只带一个参数**（`?area=美国`），
 *   照抄就会「点地区 → 已选的分类被清掉」，永远只能单维筛选。
 *   这里把「点击某一轴的值」实现成**只改这一轴、其它轴继承**，
 *   才真正把上游那 7 行筛选变成可组合的筛选面板。
 *
 * 测试：test/facets.test.ts 直接 import 这个文件，读 globalThis.DSHFacets。
 */
(function (root) {
  'use strict';

  /** 影视仓的筛选轴（顺序 = 上游筛选行的顺序） */
  var SITE_KEYS = ['class', 'area', 'year', 'sort_field', 'line', 'ban'];

  /** 主库的筛选轴 */
  var MAC_KEYS = ['area', 'year', 'lang'];

  /**
   * 上游 href 上的参数名 → 我们的参数名。
   * 上游把「线路筛选」叫 `origin`，我们在 API 里已经用 origin 表示线路，
   * 所以入参统一叫 `line`，这里做一次换算。
   */
  var UPSTREAM_KEY_MAP = {
    class: 'class',
    area: 'area',
    year: 'year',
    sort_field: 'sort_field',
    origin: 'line',
    ban: 'ban',
  };

  /** 从 URLSearchParams 读出已选筛选 */
  function readFacets(params, keys) {
    var list = keys || SITE_KEYS.concat(MAC_KEYS);
    var out = {};
    for (var i = 0; i < list.length; i++) {
      var v = params.get(list[i]);
      if (v) out[list[i]] = v;
    }
    return out;
  }

  /** 同轴单选：点已选中的值 = 取消；点别的值 = 替换；value 为空 = 取消该轴 */
  function toggleFacet(facets, key, value) {
    var next = {};
    for (var k in facets) {
      if (Object.prototype.hasOwnProperty.call(facets, k)) next[k] = facets[k];
    }
    if (!value || next[key] === value) delete next[key];
    else next[key] = value;
    return next;
  }

  /** 该选项当前是否被选中 */
  function isActive(facets, key, value) {
    var cur = facets[key] || '';
    return cur === (value || '');
  }

  /**
   * 把 facets 写进 URLSearchParams 字符串。
   * @param facets 已选筛选
   * @param extra  额外参数（如 ch / page），会覆盖同名的 facet
   */
  function composeQuery(facets, extra) {
    var q = new URLSearchParams();
    var ex = extra || {};
    var keys = Object.keys(facets);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      // extra 里给了同名键就以 extra 为准（例如预设频道要强制 ch）
      if (Object.prototype.hasOwnProperty.call(ex, k)) continue;
      if (facets[k]) q.set(k, facets[k]);
    }
    var ekeys = Object.keys(ex);
    for (var j = 0; j < ekeys.length; j++) {
      var v = ex[ekeys[j]];
      if (v === undefined || v === null || v === '') continue;
      q.set(ekeys[j], String(v));
    }
    return q.toString();
  }

  /** 生成站内地址：`base?ch=..&class=..` */
  function composeHref(base, facets, extra) {
    var s = composeQuery(facets, extra);
    return s ? base + '?' + s : base;
  }

  /**
   * 把上游筛选行的 href 归一成「该轴 + 该值」。
   *
   * 输入样例：
   *   `/dianying.html?year=2024`            → { key: 'year', value: '2024' }
   *   `/dianying.html?origin=王者TV蓝光`     → { key: 'line', value: '王者TV蓝光' }
   *   `/dianying.html`（「全部」）           → { key: null, value: '' }
   *
   * 浏览器里用 `new URL(href, location.origin)`；测试里传 baseUrl。
   */
  function upstreamOption(href, baseUrl) {
    var u;
    try {
      u = new URL(href, baseUrl || 'http://x.local');
    } catch (e) {
      return { key: null, value: '' };
    }
    var names = Object.keys(UPSTREAM_KEY_MAP);
    for (var i = 0; i < names.length; i++) {
      var up = names[i];
      var v = u.searchParams.get(up);
      if (v) return { key: UPSTREAM_KEY_MAP[up], value: v };
    }
    return { key: null, value: '' };
  }

  /** 从 URL 里抠频道名（`/dianying.html` → `dianying`） */
  function channelFromHref(href, baseUrl) {
    try {
      var u = new URL(href, baseUrl || 'http://x.local');
      var m = u.pathname.match(/^\/([a-z]+)\.html$/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  /** 已选条件 → chips 数据（值本身就是中文，直接当文案） */
  function chips(facets) {
    var out = [];
    var keys = Object.keys(facets);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!facets[k]) continue;
      out.push({ key: k, value: facets[k] });
    }
    return out;
  }

  /** 清空（返回新对象） */
  function clearAll() {
    return {};
  }

  var api = {
    SITE_KEYS: SITE_KEYS,
    MAC_KEYS: MAC_KEYS,
    UPSTREAM_KEY_MAP: UPSTREAM_KEY_MAP,
    readFacets: readFacets,
    toggleFacet: toggleFacet,
    isActive: isActive,
    composeQuery: composeQuery,
    composeHref: composeHref,
    upstreamOption: upstreamOption,
    channelFromHref: channelFromHref,
    chips: chips,
    clearAll: clearAll,
  };

  root.DSHFacets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
