/**
 * 自定义本地媒体目录（网页里添加，不用改配置文件）。
 *
 * 用户在「本地媒体」页填一个绝对路径（比如 /vol1/1000/movies），
 * 这里校验后存进 data/local-dirs.json，之后就能像内置目录一样浏览播放。
 */
import { mkdir, readFile, rename, stat, unlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
const DIRS_FILE = join(DATA_DIR, 'local-dirs.json');
/** 最多能添加多少个自定义目录 */
export const MAX_LOCAL_DIRS = 20;
/**
 * 明显是系统目录的一律拒绝。
 * 这功能是给局域网里自己用的，挡一下「手滑把 / 或 C:\ 加进来」的情况。
 */
const BLOCKED = [
    '/', '/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/bin', '/sbin', '/usr', '/lib',
    '/var/run', '/var/lib/docker', '/run', '/system', 'c:\\', 'c:/', 'c:\\windows', 'c:\\program files',
];
export function dirId(path) {
    return createHash('md5').update(path).digest('hex').slice(0, 10);
}
/** 纯逻辑校验（不碰文件系统），单测覆盖这个 */
export function validateDirPath(raw) {
    const input = String(raw ?? '').trim();
    if (!input)
        return { ok: false, reason: '请填写目录路径' };
    if (input.includes('..'))
        return { ok: false, reason: '路径里不能有 ..' };
    if (!isAbsolute(input))
        return { ok: false, reason: '必须填绝对路径，例如 /vol1/1000/movies' };
    const p = normalize(input).replace(/[\\/]+$/, '');
    // Windows 上 normalize('/etc') 会变成 '\etc'，比黑名单前统一用 / 作比较
    const canon = p.replace(/\\/g, '/');
    const lower = canon.toLowerCase();
    if (BLOCKED.some((b) => lower === b || lower === b.replace(/\/+$/, ''))) {
        return { ok: false, reason: '这是系统目录，换个视频文件夹试试' };
    }
    // 根目录（/ 或 C:\）显式拒绝
    if (canon === '' || /^[a-z]:?$/i.test(canon))
        return { ok: false, reason: '不能把整个硬盘根目录加进来' };
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    return { ok: true, path: resolve(p), name };
}
/** 校验 + 确认目录真实存在 */
export async function checkDir(raw) {
    const v = validateDirPath(raw);
    if (!v.ok)
        return v;
    try {
        const st = await stat(v.path);
        if (!st.isDirectory())
            return { ok: false, reason: '这是一个文件，不是文件夹' };
    }
    catch {
        return { ok: false, reason: '路径不存在，检查一下有没有写错' };
    }
    return { ok: true, path: v.path, name: v.name };
}
async function readDirs() {
    try {
        const text = await readFile(DIRS_FILE, 'utf8');
        const list = JSON.parse(text);
        return Array.isArray(list) ? list.filter((d) => d && typeof d.path === 'string') : [];
    }
    catch {
        return [];
    }
}
async function writeDirs(list) {
    await mkdir(dirname(DIRS_FILE), { recursive: true });
    const tmp = `${DIRS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
    try {
        await rename(tmp, DIRS_FILE);
    }
    catch {
        // 只读属性自愈（同 store.ts）
        try {
            await chmod(DIRS_FILE, 0o666);
            await rename(tmp, DIRS_FILE);
        }
        catch {
            try {
                await unlink(DIRS_FILE);
            }
            catch { /* 本来就不存在 */ }
            await rename(tmp, DIRS_FILE);
        }
    }
}
export async function listLocalDirs() {
    const list = await readDirs();
    return list.sort((a, b) => a.addedAt - b.addedAt);
}
export async function findLocalDir(id) {
    const list = await readDirs();
    return list.find((d) => d.id === id) ?? null;
}
/** 添加一个目录；重复添加返回已有的那条 */
export async function addLocalDir(rawPath, name) {
    const check = await checkDir(rawPath);
    if (!check.ok)
        throw new Error(check.reason);
    const list = await readDirs();
    const exist = list.find((d) => d.path === check.path);
    if (exist)
        return { dir: exist, dirs: await listLocalDirs() };
    if (list.length >= MAX_LOCAL_DIRS) {
        throw new Error(`最多添加 ${MAX_LOCAL_DIRS} 个目录，先删掉一些再用`);
    }
    const dir = {
        id: dirId(check.path),
        path: check.path,
        name: (name || '').trim() || check.name || check.path,
        addedAt: Date.now(),
    };
    list.push(dir);
    await writeDirs(list);
    return { dir, dirs: await listLocalDirs() };
}
export async function removeLocalDir(id) {
    const list = await readDirs();
    await writeDirs(list.filter((d) => d.id !== id));
    return listLocalDirs();
}
