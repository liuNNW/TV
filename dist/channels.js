/**
 * 频道分层：把采集站的一堆细碎分类归到 电影/电视剧/综艺/动漫/体育/解说 等频道下。
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
];
/** 结尾规则：放在专有词之后判断 */
const SUFFIX_RULES = [
    { channel: '电影', test: /(片|电影|院线)$/ },
    { channel: '电视剧', test: /(剧|电视)$/ },
];
/**
 * 判断一个分类属于哪个频道。
 * 优先用 CHANNEL_OVERRIDES 手工指定，其次走名称规则，都不中归入「其他」。
 */
export function classifyChannel(name) {
    const n = (name ?? '').trim();
    if (!n)
        return '其他';
    const override = CHANNEL_OVERRIDES[n];
    if (override)
        return override;
    // 1) 频道专有词（综艺片/动漫片 这类要先于「片」结尾判断）
    for (const r of CONTAINS_RULES) {
        if (r.test.test(n))
            return r.channel;
    }
    // 2) 结尾兜底：「喜剧片」→电影，「国产剧」→电视剧
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
    const groups = new Map();
    for (const c of categories) {
        if (c.total < minTotal)
            continue;
        const ch = classifyChannel(c.name);
        const arr = groups.get(ch);
        if (arr)
            arr.push(c);
        else
            groups.set(ch, [c]);
    }
    return [...groups.entries()]
        .map(([name, cats]) => ({
        name,
        total: cats.reduce((n, c) => n + c.total, 0),
        categories: cats.sort((a, b) => b.total - a.total),
    }))
        .sort((a, b) => channelRank(a.name) - channelRank(b.name));
}
