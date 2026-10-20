import { describe, expect, it } from 'vitest';
import { parseFfmpegHeader } from '../src/covers.js';
import { decidePlay } from '../src/playplan.js';

/**
 * 这些用例对应真实的「为什么飞牛影视能播、这个站播不了」：
 * 网页能播什么完全由浏览器的解码器决定，而浏览器只认 H.264 + AAC/MP3 这一小撮组合，
 * 而且还不认 10bit / 4:4:4 的 H.264。服务端必须先看清编码，再决定转不转码。
 */

/** 真实 ffmpeg `-i 文件` 打在 stderr 上的样子（不给输出文件时会打印完再报错退出） */
function header(lines: string[]): string {
  return [
    "ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers",
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'C:\\movies\\a.mp4':",
    '  Metadata:',
    '    major_brand     : isom',
    ...lines,
    'At least one output file must be specified',
  ].join('\n');
}

describe('没装 ffprobe 时从 ffmpeg 输出里解析编码', () => {
  it('普通 H.264 + AAC 的 mp4', () => {
    const info = parseFfmpegHeader(header([
      '  Duration: 00:02:12.34, start: 0.000000, bitrate: 4500 kb/s',
      '    Stream #0:0(chi): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x804 [SAR 1:1 DAR 160:67], 23.98 fps, 23.98 tbr',
      '    Stream #0:1(chi): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s',
    ]));
    expect(info).not.toBeNull();
    expect(info!.codec).toBe('h264');
    expect(info!.profile).toBe('High');
    expect(info!.pixFmt).toBe('yuv420p');
    expect(info!.audio).toBe('aac');
    expect(info!.width).toBe(1920);
    expect(info!.height).toBe(804);
    expect(Math.round(info!.duration)).toBe(132);
  });

  it('HEVC 10bit 的 mkv（飞牛影视能播、浏览器不能）', () => {
    const info = parseFfmpegHeader(header([
      '  Duration: 01:58:00.00, start: 0.000000, bitrate: 12000 kb/s',
      '    Stream #0:0: Video: hevc (Main 10) (hev1 / 0x31637668), yuv420p10le(tv, bt709), 3840x2160, 23.98 fps',
      '    Stream #0:1: Audio: dts (DTS-HD MA), 48000 Hz, 5.1(side), fltp, 1536 kb/s',
    ]));
    expect(info!.codec).toBe('hevc');
    expect(info!.profile).toBe('Main 10');
    expect(info!.pixFmt).toBe('yuv420p10le');
    expect(info!.audio).toBe('dts');
    expect(info!.width).toBe(3840);
  });

  it('老 AVI（Xvid + MP3）', () => {
    const info = parseFfmpegHeader(header([
      '  Duration: 00:45:00.00, start: 0.000000, bitrate: 900 kb/s',
      '    Stream #0:0: Video: mpeg4 (Advanced Simple Profile) (XVID / 0x44495658), yuv420p, 720x400 [SAR 1:1 DAR 9:5], 25 fps',
      '    Stream #0:1: Audio: mp3 (U[0][0][0] / 0x0055), 44100 Hz, stereo, fltp, 128 kb/s',
    ]));
    expect(info!.codec).toBe('mpeg4');
    expect(info!.width).toBe(720);
    expect(info!.audio).toBe('mp3');
  });

  it('不是视频的输出返回 null', () => {
    expect(parseFfmpegHeader('some random ffmpeg banner\nAt least one output file must be specified')).toBeNull();
  });
});

describe('播放方案决策', () => {
  const mk = (codec: string, audio: string, extra: Record<string, unknown> = {}) => ({
    codec,
    audio,
    width: 1920,
    height: 1080,
    duration: 100,
    ...extra,
  });

  it('H.264 + AAC 的 mp4 直接播', () => {
    expect(decidePlay('mp4', mk('h264', 'aac')).mode).toBe('direct');
  });

  it('H.265 必须转码', () => {
    const p = decidePlay('mp4', mk('hevc', 'aac'));
    expect(p.mode).toBe('transcode');
    expect(p.reason).toContain('H.265');
  });

  it('H.264 但音轨是 AC3 → 也得转码（画面能播音轨不认，整段失败）', () => {
    const p = decidePlay('mkv', mk('h264', 'ac3'));
    expect(p.mode).toBe('transcode');
    expect(p.reason).toContain('AC3');
  });

  it('H.264 10bit / 4:4:4 也要转码', () => {
    expect(decidePlay('mp4', mk('h264', 'aac', { pixFmt: 'yuv420p10le', profile: 'High 10' })).mode).toBe('transcode');
    expect(decidePlay('mp4', mk('h264', 'aac', { profile: 'High 4:4:4 Predictive' })).mode).toBe('transcode');
  });

  it('AVI / RMVB 容器一律转码', () => {
    expect(decidePlay('avi', mk('mpeg4', 'mp3')).mode).toBe('transcode');
    expect(decidePlay('rmvb', mk('rv40', 'cook')).mode).toBe('transcode');
  });

  it('TS + H.264 交给 mpegts.js 软解，不占 NAS CPU', () => {
    expect(decidePlay('ts', mk('h264', 'aac')).mode).toBe('mpegts');
  });

  it('TS + H.265 直接转码（软解也救不了）', () => {
    expect(decidePlay('ts', mk('hevc', 'aac')).mode).toBe('transcode');
  });

  it('MKV + H.264 + AAC 先让浏览器试（Chrome 能播）', () => {
    expect(decidePlay('mkv', mk('h264', 'aac')).mode).toBe('direct');
  });

  it('编码名认不出来时保守起见转码', () => {
    expect(decidePlay('mp4', mk('unknown', '')).mode).toBe('transcode');
  });
});
