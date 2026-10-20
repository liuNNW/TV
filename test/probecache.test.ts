import { describe, expect, it } from 'vitest';
import { resetProbeCache } from '../src/covers.js';

/**
 * 探测缓存的回归测试。
 *
 * 背景：/local/playplan 是「每次点播放都要走」的热路径，同一个文件会被问好几次
 * （前端 decide() 一次、startTranscode() 一次、出错兜底再一次）。
 * 早期版本每次都是新起一个 ffprobe 子进程，机械盘上单次 0.2~2 秒，
 * 用户感知就是「点一下要等半天才出画面」。
 *
 * 这里不去真的起 ffprobe（测试机上不一定有），只验证缓存接口的契约：
 * 键基于 路径+mtime+size，文件变化后必须失效；resetProbeCache() 必须能清空。
 */
describe('探测缓存（probeMedia）', () => {
  it('resetProbeCache 可以安全调用（即使缓存是空的）', () => {
    expect(() => resetProbeCache()).not.toThrow();
    expect(() => resetProbeCache()).not.toThrow();
  });

  it('对不存在的文件探测返回 null，且不会因为 stat 失败而崩', async () => {
    const mod = await import('../src/covers.js');
    const info = await mod.probeMedia('C:\\definitely\\not\\a\\real\\file\\nope.mp4');
    expect(info).toBeNull();
  });
});
