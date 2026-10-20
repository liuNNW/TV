/**
 * 本视频封面：没有同名封面图时，用浏览器自己抓一帧生成海报。
 *
 * 思路：
 *   1. 优先用服务端识别到的同名图片 / 目录海报（直接当 <img src>）
 *   2. 没有图片时，用 <video> + <canvas> 抓取指定比例处的一帧，压成 JPEG dataURL
 *   3. 抓取结果存进 IndexedDB，按 root|path|size 缓存，下次秒出、不重复解码
 *
 * 全程在浏览器本地完成，不需要 ffmpeg，也不占用 NAS 的 CPU。
 * 抓帧要真正解码视频，所以只在卡片进入视口时才做，并且串行排队，避免一次解码几十个文件。
 */
(function () {
  'use strict';

  const DB_NAME = 'mp-covers';
  const STORE = 'covers';
  const DB_VER = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }

  async function idbGet(key) {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function idbSet(key, val) {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  async function idbDel(key) {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  async function idbClear() {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  /* ---------------- 抓帧队列（串行，避免同时解码多个视频） ---------------- */

  const queue = [];
  let running = false;

  function enqueue(task) {
    return new Promise((resolve) => {
      queue.push({ task, resolve });
      pump();
    });
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const { task, resolve } = queue.shift();
      try {
        resolve(await task());
      } catch {
        resolve(null);
      }
    }
    running = false;
  }

  /** 从视频里抓一帧，返回 JPEG dataURL 或 null */
  function grabFrame(url, atRatio) {
    return enqueue(() => new Promise((resolve) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('muted', '');
      video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0';

      let finished = false;
      const timer = setTimeout(() => finish(null), 25_000);

      function cleanup() {
        clearTimeout(timer);
        try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
        try { video.remove(); } catch { /* ignore */ }
      }
      function finish(val) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(val);
      }

      function draw() {
        const vw = video.videoWidth || 0;
        const vh = video.videoHeight || 0;
        if (!vw || !vh) return finish(null);
        const w = Math.min(480, vw);
        const h = Math.max(1, Math.round(w * vh / vw));
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(video, 0, 0, w, h);
          finish(c.toDataURL('image/jpeg', 0.72));
        } catch {
          finish(null);
        }
      }

      video.addEventListener('loadeddata', () => {
        // 没有时长或时长未知：直接画第一帧
        if (!isFinite(video.duration) || video.duration <= 0) draw();
      });

      video.addEventListener('loadedmetadata', () => {
        const d = video.duration;
        const ratio = typeof atRatio === 'number' ? atRatio : 0.15;
        if (!isFinite(d) || d <= 0) { draw(); return; }
        const target = Math.min(d * ratio, Math.max(0, d - 1));
        if (target <= 0.05) {
          // 目标就是开头，等第一帧出来再画
          if (video.readyState >= 2) draw();
          return;
        }
        try { video.currentTime = target; } catch { draw(); }
      });

      video.addEventListener('seeked', draw);
      video.addEventListener('error', () => finish(null));

      document.body.appendChild(video);
      video.src = url;
      try { video.load(); } catch { /* ignore */ }
    }));
  }

  /* ---------------- 对外接口 ---------------- */

  /** 生成缓存 key */
  function coverKey(rootId, item) {
    const stamp = item.mtime ? Math.floor(item.mtime) : (item.size || 0);
    return `${rootId || 'auto'}|${item.path || item.cover || ''}|${stamp}`;
  }

  /**
   * 给一个 <img> 元素补封面。
   * @param {HTMLImageElement} imgEl
   * @param {{url:string, key:string, ratio?:number}} opts url=视频地址，key=缓存键
   */
  async function fillCover(imgEl, opts) {
    const hit = await idbGet(opts.key);
    if (hit && hit.dataUrl) {
      imgEl.src = hit.dataUrl;
      imgEl.dataset.coverState = 'cached';
      return true;
    }
    const dataUrl = await grabFrame(opts.url, opts.ratio);
    if (dataUrl) {
      await idbSet(opts.key, { dataUrl, at: Date.now() });
      imgEl.src = dataUrl;
      imgEl.dataset.coverState = 'captured';
      return true;
    }
    imgEl.dataset.coverState = 'failed';
    return false;
  }

  window.MPCovers = {
    coverKey,
    fillCover,
    grabFrame,
    get: idbGet,
    set: idbSet,
    del: idbDel,
    clear: idbClear,
  };
})();
