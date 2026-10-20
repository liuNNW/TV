/**
 * 极简 LRU + TTL 缓存。
 *
 * 为什么需要：
 * 列表要分两步取（先 ac=list 拿条目，再 ac=detail&ids= 回填封面），
 * 而剧集分类的第二步实测要 4 秒、最坏 33 秒。没有缓存，翻页体验会很差。
 *
 * 用 Map 的插入顺序实现 LRU：get 命中后删了再塞回去（变成最新），
 * 超容量就删 Map 里最前面的那个 key。
 */

interface Entry<V> {
  value: V;
  /** 过期时间戳 */
  expiresAt: number;
}

export class LruCache<V> {
  private map = new Map<string, Entry<V>>();

  constructor(
    /** 最大条目数 */
    private readonly capacity: number,
    /** 存活时间（毫秒） */
    private readonly ttl: number,
  ) {
    if (capacity <= 0) throw new Error('capacity 必须为正数');
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;

    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // 命中后移到队尾，表示最近使用
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    // 已存在先删，保证重新插入后位于队尾
    if (this.map.has(key)) this.map.delete(key);

    this.map.set(key, { value, expiresAt: Date.now() + this.ttl });

    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** 删除所有已过期项，返回删除数量 */
  prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, e] of this.map) {
      if (now > e.expiresAt) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * 「取或算」封装：命中直接返回，未命中则计算并写入。
 *
 * 注意并发同一 key 时这里会重复计算几次。对当前场景（本地单人使用）无所谓，
 * 也就不引入 promise 去重的复杂度。
 */
export async function cached<V>(
  cache: LruCache<V>,
  key: string,
  compute: () => Promise<V>,
): Promise<V> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const value = await compute();
  cache.set(key, value);
  return value;
}
