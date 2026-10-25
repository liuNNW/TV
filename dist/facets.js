/**
 * 多维筛选（facet）：词表、取值映射、查询参数拼装。
 *
 * 背景（2026-10-25 实测）：
 *   macCMS 采集接口其实**支持服务端按地区 / 年份 / 语言过滤**，只是没人传过。
 *   拿 lziapi 的动作片（t=6）做对照：
 *     基线 4978 → `area=美国` 1454 → `+year=2024` 252 → `+lang=国语` 1458（单独）
 *   分页也稳（area=美国 每页 total 恒 1454、共 73 页，逐页内容不同）。
 *
 *   **但取值必须用短写法**：`大陆 / 香港 / 台湾` 生效，
 *   `中国大陆 / 中国香港 / 中国台湾` 会被上游直接忽略（返回全量基线 4978）。
 *   这就是本文件里 MAC_AREA 那套短词表、以及 AREA_ALIAS 存在的原因。
 *
 * 本文件只放**主库（macCMS）**的词表。影视仓（wzzycc）的分类/地区/年份
 * 是上游页面实时给的（`parseFilters()`），不能也不该在这里硬编码。
 */
/**
 * macCMS 地区词表。
 *
 * **display 用源站写法，value 用 macCMS 认的短写法**：
 * 源站（wzzycc 那套）的筛选行写的是「中国大陆 / 中国香港 / 中国台湾」，
 * 而 macCMS 的 `area` 参数只认「大陆 / 香港 / 台湾」（传长写法会被**静默忽略、返回全量**）。
 * 所以 label 跟源站对齐，value 保持能真正生效的短词。
 *
 * 已实测生效：大陆 香港 台湾 美国 韩国 日本 英国 法国 泰国 印度 加拿大
 *             澳大利亚 意大利 新加坡 马来西亚 其它
 * 待复测：德国 西班牙 俄罗斯
 * 故意不放：新西兰 / 阿联酋（前者实测被忽略，后者返回 0 部，放进来只会换来空结果）
 */
export const MAC_AREA = [
    { value: '', label: '全部' },
    { value: '大陆', label: '中国大陆' },
    { value: '香港', label: '中国香港' },
    { value: '台湾', label: '中国台湾' },
    { value: '美国', label: '美国' },
    { value: '韩国', label: '韩国' },
    { value: '日本', label: '日本' },
    { value: '英国', label: '英国' },
    { value: '法国', label: '法国' },
    { value: '德国', label: '德国' },
    { value: '意大利', label: '意大利' },
    { value: '西班牙', label: '西班牙' },
    { value: '俄罗斯', label: '俄罗斯' },
    { value: '加拿大', label: '加拿大' },
    { value: '澳大利亚', label: '澳大利亚' },
    { value: '泰国', label: '泰国' },
    { value: '新加坡', label: '新加坡' },
    { value: '马来西亚', label: '马来西亚' },
    { value: '印度', label: '印度' },
    { value: '其它', label: '其它' },
];
/**
 * macCMS 语言词表。
 *
 * 注意：上游数据里写的是「汉语普通话」「英语,法语,意大利语」这种长写法，
 * 但**筛选参数只认短词表**（`汉语普通话` 只命中 109 条，`国语` 命中 1458 条）。
 */
export const MAC_LANG = [
    { value: '', label: '全部' },
    { value: '国语', label: '国语' },
    { value: '粤语', label: '粤语' },
    { value: '英语', label: '英语' },
    { value: '日语', label: '日语' },
    { value: '韩语', label: '韩语' },
];
/** 年份：近 27 年 + 年代。实测 `1994`、`2024`、`90年代` 都生效。 */
const CURRENT_YEAR = new Date().getFullYear();
export const MAC_YEAR = [
    { value: '', label: '全部' },
    ...Array.from({ length: 27 }, (_, i) => {
        const y = String(CURRENT_YEAR - i);
        return { value: y, label: y };
    }),
    { value: '2020年代', label: '2020年代' },
    { value: '2010年代', label: '2010年代' },
    { value: '2000年代', label: '2000年代' },
    { value: '90年代', label: '90年代' },
    { value: '80年代', label: '80年代' },
    { value: '70年代', label: '70年代' },
    { value: '60年代', label: '60年代' },
    { value: '50年代', label: '50年代' },
    { value: '更早', label: '更早' },
];
/** 主库的全部筛选组（前端 `/api/facets` 直接渲染这个） */
export const MAC_FACET_GROUPS = [
    { key: 'area', label: '地区', values: MAC_AREA },
    { key: 'year', label: '年份', values: MAC_YEAR },
    { key: 'lang', label: '语言', values: MAC_LANG },
];
/**
 * 长写法 → macCMS 短写法。
 *
 * 影视仓（wzzycc）用的是 `中国大陆 / 中国香港 / 中国台湾`，
 * macCMS 只认 `大陆 / 香港 / 台湾`。两边共用一套 UI 时不做映射就会「点了没反应」。
 */
export const AREA_ALIAS = {
    中国大陆: '大陆',
    中国香港: '香港',
    中国台湾: '台湾',
    中國大陸: '大陆',
    中國香港: '香港',
    中國台灣: '台湾',
    其他: '其它',
};
/** 把任意写法归一成 macCMS 认的短写法（不在表里就原样返回） */
export function normalizeArea(v) {
    const s = (v ?? '').trim();
    if (!s)
        return '';
    return AREA_ALIAS[s] ?? s;
}
const AREA_SET = new Set(MAC_AREA.map((x) => x.value).filter(Boolean));
const LANG_SET = new Set(MAC_LANG.map((x) => x.value).filter(Boolean));
const YEAR_SET = new Set(MAC_YEAR.map((x) => x.value).filter(Boolean));
/**
 * 校验并归一单个筛选值。
 * 不在词表里的值一律返回空串（= 当没传），避免把用户输入原样丢给上游。
 */
export function normalizeFacetValue(key, raw) {
    const v = (raw ?? '').trim();
    if (!v)
        return '';
    if (key === 'area') {
        const n = normalizeArea(v);
        return AREA_SET.has(n) ? n : '';
    }
    if (key === 'lang')
        return LANG_SET.has(v) ? v : '';
    if (key === 'year')
        return YEAR_SET.has(v) ? v : '';
    return '';
}
/**
 * 已选条件 → 上游 query 参数。
 * 空值 / 非法值自动剔除，所以可以直接喂给 `URLSearchParams`。
 */
export function buildMacFacets(applied) {
    const out = {};
    for (const key of ['area', 'year', 'lang']) {
        const v = normalizeFacetValue(key, applied[key]);
        if (v)
            out[key] = v;
    }
    return out;
}
/** 是否有任何生效的筛选（一致性守卫只在带筛选时才跑） */
export function hasFacets(applied) {
    return Object.keys(buildMacFacets(applied)).length > 0;
}
/**
 * 同轴单选、点已选值取消。
 * 返回新对象，不修改入参（方便前端直接替换状态）。
 *
 * `key` 故意放宽成 string：影视仓那边的轴（class/sort_field/line/ban）不在
 * FacetKey 里，但「同轴替换 + 点已选取消」这套行为完全一样，共用一份实现。
 */
export function toggleFacet(applied, key, value) {
    const next = { ...applied };
    const cur = next[key] ?? '';
    if (cur === value)
        delete next[key];
    else if (!value)
        delete next[key];
    else
        next[key] = value;
    return next;
}
/** 把已选条件拍平成 chips（值本身就是中文，直接用做文案） */
export function facetChips(applied, groups = MAC_FACET_GROUPS) {
    const out = [];
    for (const g of groups) {
        const v = applied[g.key];
        if (!v)
            continue;
        const hit = g.values.find((x) => x.value === v);
        out.push({ key: g.key, value: v, label: hit?.label ?? v, groupLabel: g.label });
    }
    return out;
}
