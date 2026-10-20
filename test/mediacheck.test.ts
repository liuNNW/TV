import { describe, expect, it } from 'vitest';
import { classifyFfmpegLog } from '../src/covers.js';

/**
 * 这里的用例来自真实事故：用户文件其实能正常解码，只是时间戳有重复，
 * ffmpeg 的输出端（null muxer）刷了一堆 "non monotonically increasing dts"。
 * 早期版本把这堆告警当成了「文件损坏」，把用户往错方向带。
 */
describe('文件体检的日志分类', () => {
  it('muxer 的重复时间戳告警只当提示，不算损坏', () => {
    const lines = [
      '[null @ 0x55903001e300] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 135 >= 135',
      '[null @ 0x55903001e300] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 138 >= 138',
      '[null @ 0x55903001e300] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 141 >= 141',
      '[null @ 0x55903001e300] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 146 >= 146',
    ];
    const r = classifyFfmpegLog(lines);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('截断的 mp4（moov 丢失）判为损坏', () => {
    const r = classifyFfmpegLog([
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1eca5f7dd00] moov atom not found',
      'D:\\x\\broken.mp4: Invalid data found when processing input',
    ]);
    expect(r.errors.length).toBe(2);
    expect(r.warnings).toEqual([]);
  });

  it('真正的解码错误也算损坏', () => {
    const r = classifyFfmpegLog([
      '[h264 @ 0x1] decode_slice_header error',
      '[h264 @ 0x1] error while decoding MB 12 34, bytestream -7',
      '[h264 @ 0x1] Invalid NAL unit size',
    ]);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('不认识的日志一律归到提示，避免误报损坏', () => {
    const r = classifyFfmpegLog(['[h264 @ 0x1] some brand new warning nobody has seen']);
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
  });

  it('重复行会去重', () => {
    const line = '[null @ 0x1] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 1 >= 1';
    const r = classifyFfmpegLog([line, line, line]);
    expect(r.warnings.length).toBe(1);
  });
});
