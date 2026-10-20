/**
 * 片源站点配置。
 *
 * 加新站只需往 SOURCES 里加一行，不需要改任何逻辑。
 * 这些都是 macCMS（苹果CMS）标准的采集接口。
 */

export interface SourceConfig {
  /** 内部标识，会出现在 API 响应里 */
  id: string;
  /** 展示名 */
  name: string;
  /** 采集接口根地址，必须以 / 结尾 */
  base: string;
}

export const SOURCES: SourceConfig[] = [
  {
    id: 'lziapi',
    name: '量子资源',
    base: 'https://cj.lziapi.com/api.php/provide/vod/',
  },
  {
    id: 'wujinapi',
    name: '无尽资源',
    base: 'https://api.wujinapi.me/api.php/provide/vod/',
  },
  {
    id: 'ffzy',
    name: '非凡资源',
    base: 'https://cj.ffzyapi.com/api.php/provide/vod/',
  },
  {
    id: 'bfzy',
    name: '暴风资源',
    base: 'https://bfzyapi.com/api.php/provide/vod/',
  },
  {
    id: 'tyyszy',
    name: '天涯资源',
    base: 'https://tyyszy.com/api.php/provide/vod/',
  },
  {
    id: 'zy360',
    name: '360资源',
    base: 'https://360zy.com/api.php/provide/vod/',
  },
  {
    id: 'sdzy',
    name: '闪电资源',
    base: 'http://sdzyapi.com/api.php/provide/vod/',
  },
  {
    id: 'hongniu',
    name: '红牛资源',
    base: 'https://hongniuzy3.com/api.php/provide/vod/',
  },
  {
    id: 'mdzy',
    name: '魔都资源',
    base: 'https://www.mdzyapi.com/api.php/provide/vod/',
  },
  {
    id: 'jinying',
    name: '金鹰资源',
    base: 'http://jyzyapi.com/api.php/provide/vod/',
  },
  {
    id: 'dytt',
    name: '电影天堂',
    base: 'http://caiji.dyttzyapi.com/api.php/provide/vod/',
  },
  // 2026-10 实测验证后加入：闪电 / 红牛(hongniuzy3) / 魔都 / 金鹰 / 电影天堂。
  // 同期实测不可用（连接失败或返回 JS 挑战页），勿重复尝试：
  //   collect.wolongzyw.com（Cloudflare 挑战）、www.hongniuzy2.com、
  //   api.guangsuapi.com、caiji.dbzy.tv、caiji.moduapi.cc、jinyingzy.com、
  //   api.wujinapi.com、feisuzy.com、api.ukuapi88.com、p2100.net、
  //   api.apibdzy.com、m3u8.bdxzyapi.com、m3u8.apiyhzy.com、ikunzyapi.com。
  // 注：dyrs.me 的上游 yzzy（api.yzzyapi.com）只输出 XML 且不返回播放地址，
  // 接入后无法播放，故不配置。XML 解析能力已内置（src/sources/maccms.ts），
  // 以后遇到给全 m3u8 的 XML 源，往 SOURCES 加一行即可。
];

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * 监听地址。
 * NAS / 服务器部署需要局域网设备能访问，默认绑 0.0.0.0；
 * 若只在个人电脑上跑，可用环境变量 HOST=127.0.0.1 收回。
 */
export const HOST = process.env.HOST ?? '0.0.0.0';
export const PORT = Number(process.env.PORT ?? 8848);

/** 上游请求超时（毫秒） */
export const FETCH_TIMEOUT = 8000;

/** 单个源失败后的重试次数 */
export const FETCH_RETRIES = 1;

/**
 * 分类 id → 名称。
 * 注意：macCMS 的分类 id 各站完全不同，这张表仅作展示兜底，
 * 真正可用的分类靠 discoverCategories() 探测。
 */
export const TYPE_MAP: Record<string, string> = {
  '1': '电影',
  '2': '电视剧',
  '3': '综艺',
  '4': '动漫',
};

/* ---------------- 频道分层 ---------------- */

/** 频道顺序，前端顶栏按这个顺序渲染 */
export const CHANNEL_ORDER = [
  '电影',
  '电视剧',
  '综艺',
  '动漫',
  '体育',
  '解说',
  '其他',
] as const;

export type ChannelName = (typeof CHANNEL_ORDER)[number];

/**
 * 僵尸分类阈值。
 * 实测采集站有一批只有 1~4 部的占位分类（电影片/连续剧/综艺片/动漫片），
 * 它们混在真实分类里会占满界面却点进去没内容，必须过滤掉。
 */
export const MIN_CATEGORY_TOTAL = 50;

/**
 * 分类名 → 频道 的手工覆盖。
 * 名称规则判断不了的特例写在这里，不用改代码逻辑。
 */
export const CHANNEL_OVERRIDES: Record<string, ChannelName> = {
  // 例：'电影解说': '解说',
};

/* ---------------- 列表取封面 ---------------- */

/** 批量取详情时每次最多带多少个 id（避免 URL 过长） */
export const ID_BATCH_SIZE = 50;

/**
 * 取封面的超时。
 * 实测采集站这个接口会抖动（同一次请求 4.2s ~ 8s+），
 * 用默认的 8s 会经常被 abort，所以单独放宽。
 */
export const COVER_FETCH_TIMEOUT = 20_000;

/** 首页/列表页缓存 */
export const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
export const CACHE_MAX_PAGES = 200;

/** 代理并发与限流 */
export const PROXY_MAX_CONCURRENCY = 12;
export const PROXY_RATE_PER_SEC = 40;

/**
 * 数据目录（收藏/历史）。
 * 默认取项目根下的 data/，可用环境变量 DATA_DIR 指到 NAS 的持久化目录。
 */
const _here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(_here, '..', 'data');
