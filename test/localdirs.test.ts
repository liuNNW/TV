import { describe, expect, it } from 'vitest';
import { dirId, validateDirPath } from '../src/localdirs.js';

describe('自定义本地目录校验', () => {
  it('接受正常的绝对路径', () => {
    const r = validateDirPath('/vol1/1000/movies');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('movies');
    }
  });

  it('拒绝空值与相对路径', () => {
    expect(validateDirPath('').ok).toBe(false);
    expect(validateDirPath('   ').ok).toBe(false);
    expect(validateDirPath('movies').ok).toBe(false);
    expect(validateDirPath('./movies').ok).toBe(false);
  });

  it('拒绝带 .. 的路径', () => {
    expect(validateDirPath('/vol1/1000/../etc/passwd').ok).toBe(false);
    expect(validateDirPath('/vol1/..').ok).toBe(false);
  });

  it('拒绝系统目录与磁盘根目录', () => {
    for (const p of ['/', '/etc', '/etc/', '/proc', '/sys', '/dev', '/boot', '/root', '/usr', '/bin']) {
      expect(validateDirPath(p).ok, p).toBe(false);
    }
    expect(validateDirPath('C:\\').ok).toBe(false);
    expect(validateDirPath('c:/').ok).toBe(false);
  });

  it('接受 Windows 下的普通目录', () => {
    const r = validateDirPath('D:\\movies');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('movies');
  });

  it('去掉末尾斜杠，id 稳定', () => {
    const a = validateDirPath('/vol1/1000/movies/');
    const b = validateDirPath('/vol1/1000/movies');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.path).toBe(b.path);
      expect(dirId(a.path)).toBe(dirId(b.path));
    }
  });
});