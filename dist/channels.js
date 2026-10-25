/**
 * 频道分层：把采集站的一堆细碎分类归到 电影/电视剧/短剧/综艺/纪录片/动漫/体育/解说 等频道下。
 *
 * 为什么不用采集站的 type_id_1：
 * 实测 type_id_1（1=电影 2=电视剧 4=动漫 36=体育）**只在 ac=detail 里返回**，
 * 而 ac=detail 逐分类探测一个剧集分类就要 33 秒，不可接受。
 *
 * 分类名本身规则性很强（动作片/国产剧/日韩动漫/足球…），所以用名称规则判断，
 * 判断不了的特例走 config 里的 CHANNEL_OVERRIDES。
 */
import { CHANNEL_ORDER, CHANNEL_OVERRIDES } from './config.js';
/**
 * 名称规则表。
 *
 * 顺序很重要，且必须区分「含」与「结尾」：
 *   「喜剧片」「剧情片」都含「剧」字，但它们是电影。
 *   所以频道专有词先判，最后才用「片 / 剧」的**结尾**来兜底。
 */
const CONTAINS_RULES = [
    { channel: '体育', test: /(体育|足球|篮球|网球|斯诺克|台球|乒乓|羽毛球|排球|棒球|高尔夫|赛车|搏击|拳击|电竞)/ },
    { channel: '动漫', test: /(动漫|动画|番剧|国漫|日漫)/ },
    { channel: '综艺', test: /(综艺|真人秀|脱口秀|晚会|访谈)/ },
    { channel: '解说', test: /(解说|速看|混剪|盘点)/ },
    // 「短剧」必须先于「以剧结尾」的兜底规则，否则会被并进电视剧，和长剧混在一起。
    // 采集站的短剧分类常见写法：短剧 / 微短剧 / 竖屏剧 / 小程序剧 / 短剧片。
    { channel: '短剧', test: /(短剧|微短剧|竖屏剧|小程序剧)/ },
    // 注意用「纪录」不用「记录」：采集站里「记录片」是正经电影分类（老写法），
    // 单测锁着它必须仍是电影，别把两边混成一个词。
    { channel: '纪录片', test: /(纪录|纪实|BBC)/ },
];
/** 结尾规则：放在专有词之后判断 */
const SUFFIX_RULES = [
    { channel: '电影', test: /(片|电影|院线)$/ },
    { channel: '电视剧', test: /(剧|电视)$/ },
];
/**
 * 父分类名 → 频道。
 *
 * 苹果CMS 的分类是**一棵树**（`class` 字段里的 `type_pid`）：电影片 → 动作片/喜剧片…，
 * 连续剧 → 国产剧/欧美剧…。直接读父节点比按名字猜准确得多，
 * 也顺手解决「古装仙侠」「NBA」这类名字规则判不出来的分类。
 */
export const PARENT_CHANNEL = {
    电影片: '电影',
    电影: '电影',
    连续剧: '电视剧',
    电视剧: '电视剧',
    综艺片: '综艺',
    综艺: '综艺',
    动漫片: '动漫',
    动漫: '动漫',
    体育: '体育',
    体育赛事: '体育',
    短剧: '短剧',
    爽文短剧: '短剧',
    AI漫剧: '短剧',
    漫剧: '短剧',
};
/**
 * 同义分类归并：不同采集站对同一个分类用不同叫法。
 *
 * 实测 8 个源的 `class` 一共 104 个不同名字，其中大量同义：
 *   「电视剧」频道原本会平铺 15 个分类，光港剧就占了 4 个（香港剧/港剧/港澳剧/港台剧）。
 * 归并后同一含义只留一条，点进去仍按 refs 里的源 id 精确取。
 */
export const CATEGORY_ALIAS = {
    // 剧集
    内地剧: '国产剧',
    港剧: '香港剧',
    港澳剧: '香港剧',
    港台剧: '香港剧',
    日剧: '日本剧',
    韩剧: '韩国剧',
    台剧: '台湾剧',
    泰剧: '泰国剧',
    马泰剧: '泰国剧',
    // 大小写不统一：tyyszy 写 `ai短剧`，其它源写 `AI漫剧`
    ai短剧: 'AI漫剧',
    // 动漫
    中国动漫: '国产动漫',
    日本动漫: '日韩动漫',
    日漫: '日韩动漫',
    漫剧: '日韩动漫',
    // 纪录 / 解说
    记录片: '纪录片',
    影视解说: '电影解说',
    // 成人向：6 个近义条目并成一条，避免分类行被它们占满
    伦理: '伦理片',
    韩国伦理: '伦理片',
    日本伦理: '伦理片',
    西方伦理: '伦理片',
    港台三级: '伦理片',
    // 体育
    体育赛事: '体育',
    其他赛事: '体育',
};
/**
 * 不是「影视分类」的条目，直接不展示。
 *
 * `演员` 是人物库（实测 0 部）；`新闻资讯/电影资讯/娱乐新闻` 是资讯；
 * `未分类/科普学习/两性课堂/写真热舞` 点进去不是片子，混在分类行里只会让人以为分类坏了。
 */
export const CATEGORY_BLOCK = new Set([
    '演员',
    '新闻资讯',
    '电影资讯',
    '娱乐新闻',
    '未分类',
    '科普学习',
    '两性课堂',
    '写真热舞',
]);
/** 分类名归一：同义词合并成标准名（没在表里就原样返回） */
export function canonicalName(raw) {
    const n = (raw ?? '').trim();
    if (!n)
        return '';
    return CATEGORY_ALIAS[n] ?? n;
}
/**
 * 短剧的子类型名。
 *
 * 短剧在源站里是**一层子分类**（爽文短剧 → 成长逆袭/反转爽剧/古装仙侠/现代都市…），
 * 有 `type_pid` 的源能靠父节点认出来，但实测 `hongniu / jinying / sdzy` 只给 id+name，
 * 这些名字里又不含「短剧」二字，光靠正则全会掉进「其他」。
 *
 * 所以这里显式列出来（全部来自实测的 104 个分类名），宁可列名单也别用「穿越/重生」
 * 这种模糊词去猜 —— 那些词在电视剧里也常见，猜错就把长剧塞进短剧。
 */
const SHORT_DRAMA_NAMES = new Set([
    '短剧',
    '微短剧',
    '竖屏剧',
    '小程序剧',
    '爽文短剧',
    'AI漫剧',
    '漫剧',
    '擦边短剧',
    '成长逆袭',
    '反转爽剧',
    '古装仙侠',
    '年代穿越',
    '穿越年代',
    '女频恋爱',
    '脑洞悬疑',
    '现代都市',
    '言情总裁',
    '重生民国',
]);
/**
 * 「伞形」分类名：它们自己是父节点，不是给人点的分类。
 *
 * 有的源会给 `type_pid`（能自动认出容器），但实测 `tyyszy / sdzy / hongniu / jinying`
 * 只给 id+name —— 于是 `电影` / `电视剧` / `动漫` 这些根节点会和叶子一起出现在分类行。
 * 这里按名字兜一道；如果某个频道**只剩容器**（没有叶子），groupByChannel 会把它放回来。
 */
export const CONTAINER_NAMES = new Set([
    '电影',
    '电影片',
    '电视剧',
    '连续剧',
    '综艺',
    '综艺片',
    '动漫',
    '动漫片',
    '体育',
]);
/**
 * 判断一个分类属于哪个频道。
 *
 * 优先级：手工覆盖 → **短剧子类型名单** → 父分类（源站层级）→ 名称规则 → 其他。
 *
 * 短剧名单排在父分类**前面**是有原因的：实测有源把「短剧」挂在「连续剧」下面，
 * 先看父节点就会把它塞进电视剧 —— 而这类名字本身就是无歧义的，名字说了算。
 * 反过来 `NBA`/`古装仙侠` 这种名字不带关键词的，就得靠父节点。
 */
export function classifyChannel(name, parentName) {
    const n = (name ?? '').trim();
    const p = (parentName ?? '').trim();
    if (!n)
        return '其他';
    const canonical = canonicalName(n);
    const override = CHANNEL_OVERRIDES[n] ?? CHANNEL_OVERRIDES[canonical];
    if (override)
        return override;
    // 1) 短剧子类型（无歧义的名字优先于父节点）
    if (SHORT_DRAMA_NAMES.has(canonical))
        return '短剧';
    // 2) 源站自己的层级
    if (p) {
        const byParent = PARENT_CHANNEL[p] ?? PARENT_CHANNEL[canonicalName(p)];
        if (byParent)
            return byParent;
    }
    // 3) 频道专有词（综艺片/动漫片 这类要先于「片」结尾判断）
    for (const r of CONTAINS_RULES) {
        if (r.test.test(n))
            return r.channel;
    }
    // 4) 结尾兜底：「喜剧片」→电影，「国产剧」→电视剧
    for (const r of SUFFIX_RULES) {
        if (r.test.test(n))
            return r.channel;
    }
    return '其他';
}
/** 按 CHANNEL_ORDER 给出排序权重，未知频道排最后 */
export function channelRank(channel) {
    const i = CHANNEL_ORDER.indexOf(channel);
    return i >= 0 ? i : CHANNEL_ORDER.length;
}
/**
 * 把扁平分类列表按频道分组。
 *
 * - 丢弃僵尸分类（total < minTotal），它们点进去没内容
 * - 分组内按条数降序，保证默认落到的第一个是内容最多的
 * - 分组按 CHANNEL_ORDER 排序
 */
export function groupByChannel(categories, minTotal = 1) {
    // 容器和叶子分开收：正常只用叶子，某个频道只剩容器时才退回容器
    const normal = new Map();
    const containers = new Map();
    const push = (m, ch, c) => {
        const arr = m.get(ch);
        if (arr)
            arr.push(c);
        else
            m.set(ch, [c]);
    };
    for (const c of categories) {
        // 条数未知（total=0 且没采集过）时不做阈值过滤，否则整排分类会被误杀
        const known = c.total > 0;
        if (known && c.total < minTotal)
            continue;
        const ch = classifyChannel(c.name, c.parent ?? null);
        push(c.container ? containers : normal, ch, c);
    }
    return [...new Set([...normal.keys(), ...containers.keys()])]
        .map((name) => {
        const cats = normal.get(name) ?? containers.get(name) ?? [];
        return {
            name,
            total: cats.reduce((n, c) => n + c.total, 0),
            // 条数全为 0 时保持源站顺序（sort 是稳定的），不会被打乱
            categories: cats.sort((a, b) => b.total - a.total),
        };
    })
        .sort((a, b) => channelRank(a.name) - channelRank(b.name));
}
