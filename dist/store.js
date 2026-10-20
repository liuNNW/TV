/**
 * 收藏与观看历史的持久化。
 *
 * 数据量很小，用 JSON 文件足够，也避开 node:sqlite 的 experimental 警告。
 * 写入走「临时文件 + 改名」，避免写一半崩了把数据写坏。
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.js';
const FAV_FILE = join(DATA_DIR, 'favorites.json');
const HIS_FILE = join(DATA_DIR, 'history.json');
const MARKER_FILE = join(DATA_DIR, 'markers.json');
/** 原子写 */
async function writeJsonAtomic(file, data) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    try {
        await rename(tmp, file);
    }
    catch (e) {
        // Windows 上目标文件带只读属性时 rename 会 EPERM（从压缩包/网盘解出来的常见坑）。
        // 自愈：去掉只读位后重试；还失败就先删旧文件再改名（最坏情况丢一份旧数据，好过崩进程）。
        const err = e;
        if (err.code !== 'EPERM' && err.code !== 'EACCES')
            throw e;
        try {
            await chmod(file, 0o666);
            await rename(tmp, file);
        }
        catch {
            try {
                await unlink(file);
            }
            catch { /* 目标本来就不存在 */ }
            await rename(tmp, file);
        }
    }
}
async function readJson(file, fallback) {
    try {
        const text = await readFile(file, 'utf8');
        if (!text.trim())
            return fallback;
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
/* ---------------- 收藏 ---------------- */
export async function listFavorites() {
    const list = await readJson(FAV_FILE, []);
    return list.sort((a, b) => b.addedAt - a.addedAt);
}
export async function addFavorite(fav) {
    const list = await readJson(FAV_FILE, []);
    const filtered = list.filter((f) => !(f.id === fav.id && f.source === fav.source));
    filtered.push({ ...fav, addedAt: Date.now() });
    await writeJsonAtomic(FAV_FILE, filtered);
    return listFavorites();
}
export async function removeFavorite(id, source) {
    const list = await readJson(FAV_FILE, []);
    const filtered = list.filter((f) => !(f.id === id && (source === undefined || f.source === source)));
    await writeJsonAtomic(FAV_FILE, filtered);
    return listFavorites();
}
export async function isFavorite(id, source) {
    const list = await readJson(FAV_FILE, []);
    return list.some((f) => f.id === id && f.source === source);
}
/* ---------------- 历史 ---------------- */
export async function listHistory() {
    const list = await readJson(HIS_FILE, []);
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
}
/** 写入进度。同一部片只保留一条最新记录。 */
export async function saveHistory(entry) {
    const list = await readJson(HIS_FILE, []);
    const filtered = list.filter((h) => !(h.id === entry.id && h.source === entry.source));
    filtered.push({ ...entry, updatedAt: Date.now() });
    // 只保留最近 500 条
    const trimmed = filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
    await writeJsonAtomic(HIS_FILE, trimmed);
    return trimmed;
}
export async function getHistory(id, source) {
    const list = await readJson(HIS_FILE, []);
    return list.find((h) => h.id === id && h.source === source) ?? null;
}
export async function clearHistory() {
    await writeJsonAtomic(HIS_FILE, []);
}
async function readMarkers() {
    return readJson(MARKER_FILE, {});
}
export async function getMarker(name) {
    const all = await readMarkers();
    return all[name] ?? null;
}
export async function setMarker(name, patch) {
    const all = await readMarkers();
    const prev = all[name] ?? { intro: 0, outro: 0, updatedAt: 0 };
    const next = {
        intro: Math.max(0, Number(patch.intro ?? prev.intro) || 0),
        outro: Math.max(0, Number(patch.outro ?? prev.outro) || 0),
        updatedAt: Date.now(),
    };
    all[name] = next;
    await writeJsonAtomic(MARKER_FILE, all);
    return next;
}
