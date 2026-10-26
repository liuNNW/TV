/** 采集站原始条目（macCMS 字段，只声明用得到的） */
export interface RawVod {
  vod_id: number | string;
  vod_name: string;
  vod_sub?: string;
  vod_year?: string;
  vod_area?: string;
  vod_lang?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_pic?: string;
  vod_content?: string;
  vod_remarks?: string;
  vod_score?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  type_name?: string;
}

/** 采集站响应包装 */
export interface RawResponse {
  code: number;
  msg?: string;
  page?: number;
  pagecount?: number;
  limit?: string | number;
  total?: number;
  list?: RawVod[];
  /**
   * 分类树。`ac=list` 的响应几乎都会带（苹果CMS 标准字段）。
   *
   * 这是**一次请求就能拿到全部分类**的关键：以前我们靠 `t=1..40` 逐个探测，
   * 8 个源要 320 次请求（实测 57.8 秒），而且 id>40 的分类直接漏掉
   * （lziapi 的短剧=46、AI漫剧=52 就是这么丢的）。
   */
  class?: RawCategory[];
}

/** 分类树节点（字段来自 macCMS 标准） */
export interface RawCategory {
  type_id: number | string;
  type_name: string;
  /** 父分类 id；部分源没有这个字段（实测 hongniu / sdzy 只给 id+name） */
  type_pid?: number | string;
}

/** 单集 */
export interface Episode {
  /** 集名，如「第01集」 */
  name: string;
  /** 播放地址（可能是 m3u8 直链，也可能是需二次解析的地址） */
  url: string;
}

/** 一条播放线路 */
export interface PlayLine {
  /** 线路名，如 lzm3u8 / 量子资源 */
  name: string;
  episodes: Episode[];
  /**
   * 是否可直接播放。
   *
   * 采集站有些「线路」给的是网页分享页（如 v.lzcdn27.com/share/xxx），
   * 需要 JS 渲染才能拿到真实地址，播放器直接用会拿到 HTML。
   * 这类线路标为 false，前端会提示并且不会被自动选中。
   */
  playable: boolean;
  /**
   * 这条线路来自哪个采集站。
   *
   * 详情页现在会**跨源聚合**同一部片的所有线路（实测《嫁金钗》被搜索去重后
   * 只剩 lziapi 的 2 条，而 5 个源一共有 9 条），合并后必须知道每条线路的出处：
   * 前端要显示「lzm3u8 · lziapi」，排查时也要能一眼看出是哪家抽了。
   */
  source?: string;
  sourceName?: string;
}

/** 归一化后的片目 */
export interface Item {
  id: string;
  name: string;
  sub?: string;
  year?: string;
  area?: string;
  lang?: string;
  actor?: string;
  director?: string;
  pic?: string;
  content?: string;
  remarks?: string;
  score?: string;
  typeName?: string;
  /** 来自哪个片源站 */
  source: string;
  sourceName: string;
}

/** 详情 = 片目 + 线路 */
export interface ItemDetail extends Item {
  lines: PlayLine[];
}

/** 带限流的响应包装 */
export interface ListResult {
  items: Item[];
  page: number;
  pageCount: number;
  total: number;
  source: string;
}

export interface DetailResult {
  detail: ItemDetail | null;
  source: string;
}
