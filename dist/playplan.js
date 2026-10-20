/**
 * 播放方案决策：这个文件该「浏览器直接播」还是「NAS 转码后再播」。
 *
 * 为什么要先探再播，而不是等浏览器报错再兜底：
 *   <video> 的 error 事件在手机上很不靠谱 —— 安卓自带浏览器、夸克、UC 里
 *   经常只是黑屏转圈，一个错都不报，用户干等着。所以在服务端用 ffprobe 先看清楚
 *   编码，凡是浏览器注定解不了的（H.265/HEVC、MPEG-2、VC-1、RMVB、AC3/DTS/TrueHD 音轨…）
 *   就直接走转码，不再让用户等一场注定失败的播放。
 */
import { probeMedia } from './covers.js';
/** 浏览器（Chrome/Edge/Firefox/安卓自带）能直接解码的视频编码 */
const OK_VIDEO = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1']);
/** 浏览器能直接解码的音频编码 */
const OK_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'none', '']);
/** 可以交给浏览器原生 <video> 试的容器 */
const OK_CONTAINER = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ogg']);
/** 交给 mpegts.js 软解的容器 */
const TS_CONTAINER = new Set(['ts', 'mts', 'm2ts', 'm2s', 'tp', 'trp', 'tod']);
const FLV_CONTAINER = new Set(['flv', 'f4v']);
/** 需要转码的音频编码（名字好听的“影院音轨”，浏览器一个都不认） */
const BAD_AUDIO_NAMES = {
    ac3: 'AC3（杜比数字）',
    eac3: 'EAC3（杜比数字+）',
    dts: 'DTS',
    truehd: 'TrueHD（杜比无损）',
    mlp: 'MLP 无损',
    wmav1: 'WMA',
    wmav2: 'WMA',
    cook: 'RealAudio',
    ra_144: 'RealAudio',
    ra_288: 'RealAudio',
    aTRAC3: 'ATRAC3',
};
const BAD_VIDEO_NAMES = {
    hevc: 'H.265 / HEVC',
    h265: 'H.265 / HEVC',
    mpeg2video: 'MPEG-2',
    mpeg1video: 'MPEG-1',
    mpeg4: 'MPEG-4 Part 2 / Xvid',
    msmpeg4v3: 'MS-MPEG4',
    msmpeg4v2: 'MS-MPEG4',
    vc1: 'VC-1',
    wmv1: 'WMV',
    wmv2: 'WMV',
    wmv3: 'WMV',
    rv30: 'RealVideo',
    rv40: 'RealVideo',
    rv20: 'RealVideo',
    rv10: 'RealVideo',
    flv1: 'Sorenson H.263',
    h263: 'H.263',
    vp6f: 'VP6',
    vp6a: 'VP6',
    dvvideo: 'DV',
    prores: 'ProRes',
    mjpeg: 'Motion JPEG',
    cinepak: 'Cinepak',
    svq3: 'Sorenson Video 3',
    theora: 'Theora',
};
function extOf(p) {
    const m = String(p || '').match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
}
/** 容器本身浏览器就吃不下的（老格式），无论里面装什么都得转 */
const BAD_CONTAINER_NAMES = {
    avi: 'AVI',
    divx: 'DivX',
    wmv: 'WMV',
    asf: 'ASF',
    rm: 'RealMedia',
    rmvb: 'RMVB',
    mpg: 'MPEG-PS',
    mpeg: 'MPEG-PS',
    mpe: 'MPEG-PS',
    m1v: 'MPEG-1',
    m2v: 'MPEG-2',
    vob: 'DVD VOB',
    mxf: 'MXF',
    dv: 'DV',
    '3gp': '3GP',
    '3g2': '3G2',
    ogm: 'OGM',
};
/**
 * 给一个视频文件出播放方案。
 * 读不到编码信息时返回 unknown，让前端按老办法「先试直连、报错再转码」。
 */
export async function planPlayback(file) {
    const ext = extOf(file);
    const info = await probeMedia(file);
    if (!info) {
        return { mode: 'unknown', reason: '读不到编码信息（可能没装 ffprobe），先让浏览器试播', info: null, ext };
    }
    return decidePlay(ext, info);
}
/** 纯决策函数（不碰文件系统，方便单测） */
export function decidePlay(ext, info) {
    const codec = (info.codec || '').toLowerCase();
    const audio = (info.audio || '').toLowerCase();
    // 1) 容器层面就注定不行
    if (BAD_CONTAINER_NAMES[ext]) {
        return { mode: 'transcode', reason: `.${ext}（${BAD_CONTAINER_NAMES[ext]}）容器浏览器不支持`, info, ext };
    }
    // 2) 视频编码浏览器不认
    if (BAD_VIDEO_NAMES[codec]) {
        return { mode: 'transcode', reason: `视频编码是 ${BAD_VIDEO_NAMES[codec]}，浏览器解不了`, info, ext };
    }
    // 3) 音轨浏览器不认（画面明明能播，却因为音轨整段失败）
    if (BAD_AUDIO_NAMES[audio]) {
        return { mode: 'transcode', reason: `音轨是 ${BAD_AUDIO_NAMES[audio]}，浏览器不认（会整段播放失败）`, info, ext };
    }
    // 4) 特殊像素格式：10bit / 4:4:4 的 H.264 网页基本都播不了
    if (codec === 'h264' || codec === 'avc1') {
        const pf = (info.pixFmt || '').toLowerCase();
        const prof = (info.profile || '').toLowerCase();
        if (/(10le|10be|444|422)/.test(pf) || /(high 10|high 4|4:4:4|4:2:2)/.test(prof)) {
            return {
                mode: 'transcode',
                reason: `H.264 但色彩格式是 ${info.pixFmt || info.profile}（10bit 或 4:4:4），网页播不了`,
                info,
                ext,
            };
        }
    }
    // 5) 视频编码不在白名单 → 保险起见转码
    if (!OK_VIDEO.has(codec)) {
        return { mode: 'transcode', reason: `视频编码 ${codec} 不在浏览器支持列表里`, info, ext };
    }
    if (audio && !OK_AUDIO.has(audio)) {
        return { mode: 'transcode', reason: `音轨编码 ${audio} 浏览器不认`, info, ext };
    }
    // 6) TS / FLV：浏览器原生不行，但可以用 mpegts.js 在浏览器里软解（不占 NAS CPU）
    if (TS_CONTAINER.has(ext) || FLV_CONTAINER.has(ext)) {
        return { mode: 'mpegts', reason: `.${ext} 需要浏览器端软解（mpegts.js）`, info, ext };
    }
    // 7) 剩下能直接播的
    if (OK_CONTAINER.has(ext)) {
        const note = ext === 'mkv' ? '（MKV：Chrome/Edge/Firefox 可以，Safari 不行，播不了会自动转码）' : '';
        return { mode: 'direct', reason: `H.264 + ${info.audio || '无音轨'}，浏览器可以直接播${note}`, info, ext };
    }
    // 8) 不认识的容器：让浏览器试一下，不行再转
    return { mode: 'unknown', reason: `未知容器 .${ext}，先让浏览器试播`, info, ext };
}
