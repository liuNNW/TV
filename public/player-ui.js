/**
 * 通用播放器 UI（自绘控制栏，风格对齐优酷 / 爱奇艺 / 腾讯视频）。
 *
 * 用法：initPlayerUI(videoEl, { title, onPrev, onNext, hasEpisodes, keyboard, poster })
 * 会把 video 包进 .vp-stage，注入：
 *   - 顶部渐变信息条（标题 / 提示，播放时淡出）
 *   - 中央大播放按钮（点击播放，播放中淡出）
 *   - 底部控制栏：细圆角进度条（hover 变粗 + 圆形拖拽点 + 时间气泡 + 缓冲条）
 *     播放/暂停 · 时间 · 上一集/下一集 · 倍速 · 音量 · 画中画 · 全屏
 * 原生 controls 会被移除。依赖 style.css 里的 .vp-* 样式。
 */
(function () {
  'use strict';

  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2v12H7zM20 6v12l-9-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M15 6h2v12h-2zM4 6l9 6-9 6z"/></svg>',
    volUp: '<svg viewBox="0 0 24 24"><path d="M4 9v6h3l5 4V5L7 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>',
    volLow: '<svg viewBox="0 0 24 24"><path d="M4 9v6h3l5 4V5L7 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z"/></svg>',
    volMute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h3l5 4V5L7 9H4zm15.5 3 2.5-2.5-1.4-1.4L18.1 10.6 15.6 8.1 14.2 9.5l2.5 2.5-2.5 2.5 1.4 1.4 2.5-2.5 2.5 2.5 1.4-1.4z"/></svg>',
    pip: '<svg viewBox="0 0 24 24"><path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h16V7H4zm9 3h6v5h-6z"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/></svg>',
    exitFull: '<svg viewBox="0 0 24 24"><path d="M10 4v6H4V8h4V4h2zm4 0h2v4h4v2h-6V4zM4 14h6v6H8v-4H4v-2zm10 0h6v2h-4v4h-2v-6z"/></svg>',
    rate: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm-1 3v5.2l3.6 2.2.9-1.5-2.5-1.5V8h-2z"/></svg>',
    back10: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
    fwd10: '<svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z"/></svg>',
  };

  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function fmt(sec) {
    if (!sec || !isFinite(sec) || sec < 0) return '00:00';
    sec = Math.floor(sec);
    const hh = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  const RATES = [2, 1.5, 1.25, 1, 0.75, 0.5];

  /**
   * @param {HTMLVideoElement} video
   * @param {{onPrev?:Function, onNext?:Function, hasEpisodes?:boolean,
   *          title?:string, keyboard?:boolean, poster?:string,
   *          onSkipIntro?:Function, nextLabel?:string}} opts
   */
  function initPlayerUI(video, opts) {
    opts = opts || {};
    const wrap = video.parentElement;
    if (!wrap || wrap.dataset.vpInit) return null;
    wrap.dataset.vpInit = '1';
    wrap.classList.add('vp-stage');
    video.removeAttribute('controls');
    if (opts.poster) video.setAttribute('poster', opts.poster);

    /* ---------- 顶部渐变信息条 ---------- */
    const top = h(`<div class="vp-top">
      <div class="vp-title">${opts.title || ''}</div>
      <div class="vp-top-right"><span class="vp-ads" id="vpAds" hidden></span></div>
    </div>`);

    /* ---------- 中央大播放按钮 ---------- */
    const center = h(`<button class="vp-center" data-act="toggle" title="播放 / 暂停 (空格)">${ICONS.play}</button>`);

    /* ---------- 缓冲转圈 ---------- */
    const spin = h('<div class="vp-spinner" hidden><i></i></div>');

    /* ---------- 底部控制栏 ---------- */
    const bar = h(`<div class="vp-bar">
      <div class="vp-progress" id="vpProgress">
        <div class="vp-track">
          <div class="vp-buffer"></div>
          <div class="vp-played"><span class="vp-thumb"></span></div>
          <div class="vp-tip"><span class="vp-tip-txt">00:00</span></div>
        </div>
      </div>
      <div class="vp-row">
        <button class="vp-btn vp-play" data-act="toggle" title="播放 / 暂停 (空格)">${ICONS.play}</button>
        <button class="vp-btn vp-skip" data-act="back" title="快退 10 秒 (←)">${ICONS.back10}</button>
        <button class="vp-btn vp-skip" data-act="fwd" title="快进 10 秒 (→)">${ICONS.fwd10}</button>
        ${opts.hasEpisodes ? `<button class="vp-btn" data-act="prev" title="上一集 (P)">${ICONS.prev}</button>
        <button class="vp-btn" data-act="next" title="下一集 (N)">${ICONS.next}</button>` : ''}
        <span class="vp-time"><i class="vp-cur">00:00</i><span class="vp-sep">/</span><i class="vp-dur">00:00</i></span>
        <div class="vp-spacer"></div>
        <div class="vp-rate">
          <button class="vp-btn vp-rate-btn" data-act="rate" title="播放速度"><span class="vp-rate-txt">倍速</span></button>
          <div class="vp-menu" id="vpRateMenu">${RATES.map((r) => `<button class="vp-menu-item${r === 1 ? ' active' : ''}" data-rate="${r}">${r === 1 ? '正常' : r + 'x'}</button>`).join('')}</div>
        </div>
        <div class="vp-vol">
          <button class="vp-btn" data-act="mute" title="静音 (M)">${ICONS.volUp}</button>
          <div class="vp-vol-track"><input class="vp-vol-slider" type="range" min="0" max="1" step="0.02" value="1" aria-label="音量"></div>
        </div>
        <button class="vp-btn" data-act="pip" title="画中画">${ICONS.pip}</button>
        <button class="vp-btn" data-act="full" title="全屏 (F)">${ICONS.full}</button>
      </div>
    </div>`);

    wrap.appendChild(top);
    wrap.appendChild(center);
    wrap.appendChild(spin);
    wrap.appendChild(bar);

    const $ = (sel) => bar.querySelector(sel);
    const progress = $('#vpProgress');
    const track = progress.querySelector('.vp-track');
    const played = progress.querySelector('.vp-played');
    const bufferBar = progress.querySelector('.vp-buffer');
    const tip = progress.querySelector('.vp-tip');
    const tipTxt = progress.querySelector('.vp-tip-txt');
    const playBtn = $('.vp-play');
    const curEl = $('.vp-cur');
    const durEl = $('.vp-dur');
    const volBtn = bar.querySelector('[data-act="mute"]');
    const volSlider = $('.vp-vol-slider');
    const rateMenu = $('#vpRateMenu');
    const fullBtn = bar.querySelector('[data-act="full"]');

    /* ---------- 播放 / 暂停 ---------- */
    function setPlayIcon(isPlaying) {
      const svg = isPlaying ? ICONS.pause : ICONS.play;
      playBtn.innerHTML = svg;
      center.innerHTML = svg;
    }

    function toggle() {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    function seekBy(delta) {
      if (!video.duration) return;
      video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta));
    }

    video.addEventListener('play', () => { setPlayIcon(true); center.classList.add('hide'); });
    video.addEventListener('pause', () => { setPlayIcon(false); center.classList.remove('hide'); });

    /* ---------- 缓冲指示 ---------- */
    let waitingTimer = null;
    video.addEventListener('waiting', () => {
      waitingTimer = setTimeout(() => { spin.hidden = false; }, 250);
    });
    const clearSpin = () => { clearTimeout(waitingTimer); spin.hidden = true; };
    video.addEventListener('playing', clearSpin);
    video.addEventListener('canplay', clearSpin);
    video.addEventListener('timeupdate', clearSpin);
    video.addEventListener('seeked', clearSpin);
    video.addEventListener('error', clearSpin);
    video.addEventListener('stalled', () => { waitingTimer = setTimeout(() => { spin.hidden = false; }, 400); });

    /* ---------- 进度条 ---------- */
    let dragging = false;
    let dragTime = 0;

    function ratioFromEvent(e) {
      const rect = track.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      return Math.min(1, Math.max(0, x / rect.width));
    }

    function renderProgress() {
      const dur = video.duration || 0;
      const ratio = dragging ? (dur ? dragTime / dur : 0) : (dur ? video.currentTime / dur : 0);
      played.style.width = (ratio * 100).toFixed(3) + '%';
      curEl.textContent = fmt(dragging ? dragTime : video.currentTime);
      durEl.textContent = fmt(dur);
    }

    video.addEventListener('timeupdate', renderProgress);
    video.addEventListener('durationchange', renderProgress);
    video.addEventListener('progress', () => {
      const dur = video.duration || 0;
      if (!dur || !video.buffered.length) return;
      const end = video.buffered.end(video.buffered.length - 1);
      bufferBar.style.width = Math.min(100, (end / dur) * 100).toFixed(3) + '%';
    });

    function moveTip(e) {
      const r = ratioFromEvent(e);
      const dur = video.duration || 0;
      tip.style.left = (r * 100).toFixed(3) + '%';
      tipTxt.textContent = fmt(r * dur);
      tipTxt.style.transform = r > 0.92 ? 'translateX(-92%)' : r < 0.08 ? 'translateX(-8%)' : 'translateX(-50%)';
      tip.style.visibility = dur ? 'visible' : 'hidden';
    }

    progress.addEventListener('mousemove', moveTip);
    progress.addEventListener('touchmove', (e) => { if (video.duration) moveTip(e); }, { passive: true });

    function startDrag(e) {
      if (!video.duration) return;
      dragging = true;
      progress.classList.add('dragging');
      dragTime = ratioFromEvent(e) * video.duration;
      renderProgress();
      moveTip(e);
      e.preventDefault();
    }
    function moveDrag(e) {
      if (!dragging) return;
      dragTime = ratioFromEvent(e) * video.duration;
      renderProgress();
      moveTip(e);
      e.preventDefault();
    }
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      progress.classList.remove('dragging');
      if (video.duration) {
        const t = ratioFromEvent(e) * video.duration;
        try { video.currentTime = t; } catch { /* ignore */ }
      }
      renderProgress();
    }

    progress.addEventListener('mousedown', startDrag);
    progress.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('mousemove', moveDrag);
    window.addEventListener('touchmove', moveDrag, { passive: false });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);

    /* ---------- 音量 ---------- */
    function syncVolIcon() {
      const v = video.muted ? 0 : video.volume;
      volBtn.innerHTML = v === 0 ? ICONS.volMute : v < 0.5 ? ICONS.volLow : ICONS.volUp;
      volSlider.value = String(v);
      volSlider.style.setProperty('--vp-vol', (v * 100).toFixed(0) + '%');
    }
    video.addEventListener('volumechange', syncVolIcon);
    volSlider.addEventListener('input', () => {
      video.volume = Number(volSlider.value);
      video.muted = video.volume === 0;
    });
    volBtn.addEventListener('click', () => { video.muted = !video.muted; });
    // 触摸板：点喇叭除了静音，也顺手把滑杆固定展开，方便接着拖音量。
    // （鼠标用户 hover 一下就展开了，不受影响）
    const volGroup = volBtn.closest('.vp-vol');
    if (volGroup) {
      volBtn.addEventListener('pointerup', (e) => {
        if (e.pointerType === 'mouse') return;
        volGroup.classList.add('open');
      });
      // 点到别处就收起
      volGroup.addEventListener('pointerleave', () => volGroup.classList.remove('open'));
      document.addEventListener('pointerdown', (e) => {
        if (!volGroup.contains(e.target)) volGroup.classList.remove('open');
      });
    }
    syncVolIcon();

    /* ---------- 倍速 ---------- */
    rateMenu.querySelectorAll('.vp-menu-item').forEach((b) => {
      b.onclick = () => {
        video.playbackRate = Number(b.dataset.rate);
        rateMenu.querySelectorAll('.vp-menu-item').forEach((x) => x.classList.toggle('active', x === b));
        const txt = bar.querySelector('.vp-rate-txt');
        txt.textContent = Number(b.dataset.rate) === 1 ? '倍速' : b.dataset.rate + 'x';
        txt.classList.toggle('on', Number(b.dataset.rate) !== 1);
        rateMenu.classList.remove('open');
      };
    });
    bar.querySelector('[data-act="rate"]').onclick = (e) => {
      e.stopPropagation();
      rateMenu.classList.toggle('open');
    };

    /* ---------- 全屏 ---------- */
    function toggleFull() {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (wrap.requestFullscreen) {
        wrap.requestFullscreen().catch(() => {});
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    }
    document.addEventListener('fullscreenchange', () => {
      fullBtn.innerHTML = document.fullscreenElement ? ICONS.exitFull : ICONS.full;
    });

    /* ---------- 按钮派发 ---------- */
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'toggle') toggle();
      else if (act === 'back') seekBy(-10);
      else if (act === 'fwd') seekBy(10);
      else if (act === 'prev' && opts.onPrev) opts.onPrev();
      else if (act === 'next' && opts.onNext) opts.onNext();
      else if (act === 'pip') {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(() => {});
      } else if (act === 'full') toggleFull();
      else if (act === 'mute') { /* 由独立监听处理 */ }
      activity();
    });

    center.addEventListener('click', () => { toggle(); activity(); });

    /* ---------- 单击 / 双击 / 滚轮 ---------- */
    let clickTimer = null;
    video.addEventListener('click', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; toggleFull(); return; }
      clickTimer = setTimeout(() => { clickTimer = null; toggle(); activity(); }, 220);
    });
    video.addEventListener('dblclick', (e) => e.preventDefault());

    // 滚轮 / 触摸板：
    //   - 笔记触摸板「双指上下滑」= deltaY（调音量，和绝大多数播放器一致）
    //   - 「双指左右滑」= deltaX（拖动进度，这是触摸板最顺手的手势）
    //   - 按住 Shift 再滚 = 微调（1 秒 / 2%），方便精确对细节
    // 用累计值 + 时间窗，避免触摸板那种「一次滑动几十个事件」把音量/进度一次拉到底。
    let wheelAcc = 0;
    let wheelAxis = '';
    let wheelTimer = null;
    video.addEventListener('wheel', (e) => {
      e.preventDefault();

      const fine = e.shiftKey;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const axis = horizontal ? 'x' : 'y';

      if (axis !== wheelAxis) { wheelAcc = 0; wheelAxis = axis; }
      // deltaMode: 0=像素 1=行 2=页，统一折算成「格」
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const raw = horizontal ? e.deltaX : e.deltaY;
      wheelAcc += raw * unit;

      clearTimeout(wheelTimer);
      // 120 是一个「标准滚轮格」的近似像素量，触摸板连续小 delta 会累计到 120 才动手
      const threshold = fine ? 30 : 90;
      if (Math.abs(wheelAcc) >= threshold) {
        const steps = Math.trunc(wheelAcc / threshold);
        wheelAcc -= steps * threshold;

        if (axis === 'x' && video.duration) {
          // 横向：拖进度。细调 1 秒/格，粗调 5 秒/格
          const delta = steps * (fine ? 1 : 5);
          try { video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + delta)); } catch { /* ignore */ }
        } else {
          // 纵向：调音量。细调 1%/格，粗调 5%/格
          const delta = steps * (fine ? 0.01 : 0.05);
          video.volume = Math.min(1, Math.max(0, video.volume + delta));
          video.muted = video.volume === 0;
        }
      }
      wheelTimer = setTimeout(() => { wheelAcc = 0; }, 220);
      activity();
    }, { passive: false });

    /* ---------- 控制栏自动隐藏 ---------- */
    let hideTimer = null;
    let hoveringBar = false;
    function show() {
      wrap.classList.remove('vp-idle');
      if (rateMenu.classList.contains('open') || hoveringBar || dragging || video.paused) return;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => wrap.classList.add('vp-idle'), 3000);
    }
    function activity() { wrap.classList.remove('vp-idle'); show(); }
    // 用 pointermove 而不是 mousemove：触摸板、触摸屏、手写笔都会派发 pointermove，
    // 单靠 mousemove 在部分触摸板驱动下不触发，控制栏就「怎么动都不出来」。
    wrap.addEventListener('pointermove', () => { wrap.classList.remove('vp-idle'); show(); });
    wrap.addEventListener('mouseleave', () => { if (!video.paused) wrap.classList.add('vp-idle'); });
    wrap.addEventListener('touchstart', activity, { passive: true });
    // 键盘/触摸板没有任何指针进入时，也保证控制栏能被 Tab 唤出
    wrap.addEventListener('focusin', () => { wrap.classList.remove('vp-idle'); clearTimeout(hideTimer); });
    bar.addEventListener('mouseenter', () => { hoveringBar = true; wrap.classList.remove('vp-idle'); });
    bar.addEventListener('mouseleave', () => { hoveringBar = false; show(); });
    video.addEventListener('pause', () => { wrap.classList.remove('vp-idle'); clearTimeout(hideTimer); });
    video.addEventListener('play', show);
    document.addEventListener('click', () => rateMenu.classList.remove('open'));
    show();

    /* ---------- 键盘 ---------- */
    if (opts.keyboard !== false) {
      document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toUpperCase();
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
        switch (e.key) {
          case ' ':
          case 'k':
          case 'K':
            e.preventDefault();
            toggle();
            break;
          case 'ArrowLeft':
            e.preventDefault();
            seekBy(-10);
            break;
          case 'ArrowRight':
            e.preventDefault();
            seekBy(10);
            break;
          case 'ArrowUp':
            e.preventDefault();
            video.volume = Math.min(1, video.volume + 0.1);
            video.muted = false;
            break;
          case 'ArrowDown':
            e.preventDefault();
            video.volume = Math.max(0, video.volume - 0.1);
            break;
          case 'f':
          case 'F':
            e.preventDefault();
            toggleFull();
            break;
          case 'm':
          case 'M':
            video.muted = !video.muted;
            break;
          case 'n':
          case 'N':
            if (opts.onNext) opts.onNext();
            break;
          case 'p':
          case 'P':
            if (opts.onPrev) opts.onPrev();
            break;
        }
        activity();
      });
    }

    video.addEventListener('contextmenu', (e) => e.preventDefault());
    renderProgress();

    return {
      setTitle(t) { top.querySelector('.vp-title').textContent = t; },
      /** 显示一条播放器内提示（例如已剔除广告） */
      notice(msg, ms) {
        const el = document.getElementById('vpAds');
        if (!el) return;
        el.hidden = false;
        el.textContent = msg;
        setTimeout(() => { el.hidden = true; }, ms || 3500);
      },
      activity,
      setPlayIcon,
    };
  }

  window.initPlayerUI = initPlayerUI;
  window.vpFmt = fmt;
})();
