'use strict';

/**
 * ENAEAA 自动连播 - 页面脚本（只在顶层页面运行）
 *
 * 功能：
 * - 播放页：每 2 秒检查一次当前分集进度，视频结束/进度到 100% 时自动点下一集；
 * - 整门课全部分集完成后，通知后台切换到“全部课程”里的下一门课程；
 * - 课程列表页：解析课程行，按 courseId 或标题找到当前课程，返回下一门课程；
 * - 左下角常驻状态面板，显示当前分集、剩余时间、下一集/下一课程；
 * - Ctrl+Shift+D 复制诊断信息，方便排查页面结构变化。
 */

(() => {
  if (window.top !== window) return;
  if (window.__ENAEA_COURSE_AUTO_V1__) return;
  window.__ENAEA_COURSE_AUTO_V1__ = true;

  const PLAYER_RE = /viewerforc.*video\.do/i;
  const LIST_RE = /(?:circleIndexRedirect|toNewMyClass|myClass|courseList)/i;
  const IS_PLAYER = PLAYER_RE.test(location.pathname + location.search);
  const IS_LIST = !IS_PLAYER && LIST_RE.test(location.href);
  if (!IS_PLAYER && !IS_LIST) return;

  const CONFIG = {
    tickMs: 2000,
    switchCooldownMs: 12000,
    finishConfirmMs: 4000,
    completeRetryMs: 90000,
    prefetchMs: 5 * 60 * 1000,
    completeThreshold: 100,
    maxDesyncReplayAttempts: 4,
    debug: true,
  };

  const LOG_PREFIX = '[enaea-auto-next]';
  const logs = [];
  let enabled = true;
  let lastSwitchAt = 0;
  let lastSwitchKey = '';
  let finishSince = 0;
  let lastCompleteAt = 0;
  let switching = false;
  let prefetchedNext = null;
  let lastStatus = '';
  let panelHost = null;
  let panelApi = null;
  let resumeAttempted = false;
  let resumeAttempts = 0;
  let lastResumeAt = 0;
  let desyncSince = 0;
  let desyncReplayAttempts = 0;
  let lastDesyncReplayAt = 0;
  let desyncKey = '';
  let pageSeekTitle = '';
  let pageSeekTarget = 0;
  let pageSeekAttempts = 0;
  let lastPageSeekAt = 0;
  const MAX_PAGE_SEEK_ATTEMPTS = 5;
  let lastPlayAttemptAt = 0;
  let playAttempts = 0;
  let autoPlaySucceeded = false;
  const MAX_PLAY_ATTEMPTS = 4;

  function log(...args) {
    if (CONFIG.debug) {
      try { console.log(LOG_PREFIX, ...args); } catch (_) {}
    }
    try {
      const line = args.map((x) => {
        if (typeof x === 'string') return x;
        try { return JSON.stringify(x); } catch (_) { return String(x); }
      }).join(' ');
      logs.push(new Date().toLocaleTimeString() + ' ' + line);
      if (logs.length > 80) logs.splice(0, logs.length - 80);
    } catch (_) {}
  }

  function textOf(el) {
    if (!el) return '';
    const raw = typeof el.innerText === 'string' && el.innerText.trim()
      ? el.innerText
      : (el.textContent || '');
    return String(raw).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeTitle(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[（(]\s*已学完\s*[)）]/g, '')
      .replace(/已学完|已完成|未学完/g, '')
      .replace(/[“”"'‘’《》<>【】\[\]（）()：:，,。.、\s]/g, '')
      .trim();
  }

  function parseDuration(text) {
    const m = String(text || '').match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
    if (!m) return 0;
    if (m[3] != null) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function formatDuration(sec) {
    const n = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getCourseId() {
    try { return new URLSearchParams(location.search).get('courseId') || ''; } catch (_) { return ''; }
  }

  function getCircleId() {
    try { return new URLSearchParams(location.search).get('circleId') || ''; } catch (_) { return ''; }
  }

  // ==================== 状态面板 ====================

  function buildPanel() {
    if (panelHost && panelHost.isConnected) return panelApi;
    if (!document.documentElement) return null;

    const host = document.createElement('div');
    host.id = 'enaea-course-auto-host';
    host.style.cssText = 'position:fixed;left:14px;bottom:88px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          all: initial;
          display: block;
          width: 318px;
          box-sizing: border-box;
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(20, 24, 32, 0.93);
          color: #e8edf5;
          border: 1px solid rgba(120, 170, 255, 0.35);
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.38);
          font: 12px/1.55 "Microsoft YaHei", "Segoe UI", sans-serif;
          user-select: none;
        }
        .head { display: flex; align-items: center; gap: 7px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #39d98a; flex: none; box-shadow: 0 0 8px #39d98a; }
        .dot.warn { background: #ffb020; box-shadow: 0 0 8px #ffb020; }
        .dot.err { background: #ff5d5d; box-shadow: 0 0 8px #ff5d5d; }
        .dot.off { background: #7a8494; box-shadow: none; }
        .title { font-weight: 700; font-size: 12px; letter-spacing: .2px; flex: 1; }
        .btn {
          all: initial;
          cursor: pointer;
          font: 11px/1 "Microsoft YaHei", "Segoe UI", sans-serif;
          color: #cfe0ff;
          background: rgba(80, 130, 220, 0.18);
          border: 1px solid rgba(120, 170, 255, 0.35);
          border-radius: 6px;
          padding: 4px 7px;
          margin-left: 4px;
        }
        .btn:hover { background: rgba(80, 130, 220, 0.32); }
        .status { margin-top: 7px; font-size: 12.5px; font-weight: 600; color: #f2f6ff; }
        .detail { margin-top: 2px; color: #aebbd0; font-size: 11.5px; }
        .next { margin-top: 4px; color: #8fd3ff; font-size: 11.5px; word-break: break-all; }
        .foot { margin-top: 7px; display: flex; align-items: center; gap: 6px; color: #7f8da3; font-size: 10.5px; }
        .foot .time { flex: 1; }
        .hint { margin-top: 4px; color: #77839a; font-size: 10px; }
      </style>
      <div class="card">
        <div class="head">
          <span class="dot"></span>
          <span class="title">ENAEAA 自动连播</span>
          <button class="btn toggle" type="button">暂停监控</button>
        </div>
        <div class="status">正在初始化…</div>
        <div class="detail"></div>
        <div class="next"></div>
        <div class="foot"><span class="time"></span><button class="btn diag" type="button">诊断</button></div>
        <div class="hint">每 2 秒检查 · Ctrl+Shift+D 复制诊断</div>
      </div>
    `;

    document.documentElement.appendChild(host);

    const api = {
      host,
      dot: root.querySelector('.dot'),
      status: root.querySelector('.status'),
      detail: root.querySelector('.detail'),
      next: root.querySelector('.next'),
      time: root.querySelector('.time'),
      toggle: root.querySelector('.toggle'),
    };

    api.toggle.addEventListener('click', () => {
      enabled = !enabled;
      chrome.storage.local.set({ enaeaAutoNext: enabled });
      log(enabled ? '监控已恢复' : '监控已暂停');
      updatePanel();
    });

    root.querySelector('.diag').addEventListener('click', () => {
      copyDiagnostics().catch(() => {});
    });

    panelHost = host;
    panelApi = api;
    return api;
  }

  function updatePanel(opts = {}) {
    const api = buildPanel();
    if (!api) return;

    if (opts.status) lastStatus = opts.status;
    api.dot.className = 'dot' + (opts.tone ? ' ' + opts.tone : (enabled ? '' : ' off'));
    api.status.textContent = opts.status || lastStatus || (enabled ? '监控中…' : '监控已暂停');
    api.detail.textContent = opts.detail || '';
    api.next.textContent = opts.next || (prefetchedNext ? '下一课程：' + (prefetchedNext.title || prefetchedNext.courseId || '') : '');
    api.time.textContent = '检查于 ' + new Date().toLocaleTimeString();
    api.toggle.textContent = enabled ? '暂停监控' : '恢复监控';
  }

  function toast(message) {
    updatePanel({ status: message });
  }

  // ==================== 视频与分集 ====================

  function eachDocument(fn, win = window, depth = 0) {
    if (depth > 4) return;
    try { fn(win.document); } catch (_) {}
    try {
      for (let i = 0; i < win.frames.length; i++) {
        eachDocument(fn, win.frames[i], depth + 1);
      }
    } catch (_) {}
  }

  function getVideos() {
    const list = [];
    eachDocument((doc) => {
      try {
        doc.querySelectorAll('video').forEach((video) => list.push(video));
      } catch (_) {}
    });
    return list;
  }

  function getAccessibleDocs() {
    const out = [];
    (function walk(win, depth) {
      if (depth > 4) return;
      try {
        if (win.document) out.push({ doc: win.document, win });
      } catch (_) {}
      try {
        for (let i = 0; i < win.frames.length; i++) walk(win.frames[i], depth + 1);
      } catch (_) {}
    })(window, 0);
    return out;
  }

  function currentVideoState() {
    const videos = getVideos().filter((v) => {
      try { return Number.isFinite(v.duration) && v.duration > 30; } catch (_) { return false; }
    });
    if (!videos.length) return null;

    videos.sort((a, b) => {
      const ap = a.paused ? 0 : 1;
      const bp = b.paused ? 0 : 1;
      if (ap !== bp) return bp - ap;
      return (Number(b.currentTime) || 0) - (Number(a.currentTime) || 0);
    });

    const v = videos[0];
    try {
      return {
        video: v,
        duration: Number(v.duration) || 0,
        current: Number(v.currentTime) || 0,
        paused: !!v.paused,
        ended: !!v.ended,
      };
    } catch (_) {
      return null;
    }
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const style = win.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    } catch (_) {
      return false;
    }
  }

  function findPlayButton() {
    const selectors = [
      '.vjs-big-play-button',
      '.prism-big-play-button',
      '.xgplayer-start',
      '.dplayer-play-icon',
      '[class*="big-play"]',
      '[class*="bigPlay"]',
      '[class*="play-btn"]',
      '[class*="playBtn"]',
      '[class*="play-button"]',
      '[class*="playButton"]',
      '[aria-label*="播放"]',
      '[title*="播放"]',
      '[aria-label="play" i]',
      '[title="play" i]',
    ];
    for (const item of getAccessibleDocs()) {
      for (const sel of selectors) {
        try {
          const els = item.doc.querySelectorAll(sel);
          for (const el of els) {
            if (isElementVisible(el)) return el;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  async function tryPlayVideo(video) {
    if (!video || video.ended) return false;
    if (!video.paused) {
      autoPlaySucceeded = true;
      return true;
    }

    // 1) 先点站点自己的播放按钮，部分播放器只有点击后才能开始
    const playBtn = findPlayButton();
    if (playBtn && video.paused) {
      try { clickElement(playBtn); } catch (_) {}
      await sleep(700);
      if (!video.paused) {
        autoPlaySucceeded = true;
        return true;
      }
    }

    // 2) 正常调用 play()
    try {
      const p = video.play();
      if (p && typeof p.then === 'function') await p;
      if (!video.paused) {
        autoPlaySucceeded = true;
        return true;
      }
    } catch (err) {
      log('正常播放被拦截：' + (err && err.name || err));
    }

    // 3) 静音后再试；浏览器通常允许静音自动播放
    try {
      video.muted = true;
      const p = video.play();
      if (p && typeof p.then === 'function') await p;
      if (!video.paused) {
        autoPlaySucceeded = true;
        log('已静音自动播放');
        updatePanel({
          status: '已静音自动播放',
          detail: '需要声音请点视频音量按钮',
          tone: 'warn',
        });
        return true;
      }
    } catch (err) {
      log('静音播放仍被拦截：' + (err && err.name || err));
    }

    return false;
  }

  function playVideos(reset = false) {
    if (reset) {
      playAttempts = 0;
      autoPlaySucceeded = false;
    }
    const videos = getVideos().filter((v) => !v.ended);
    const paused = videos.filter((v) => v.paused);
    if (!paused.length) return;

    if (Date.now() - lastPlayAttemptAt < 1200) return;
    lastPlayAttemptAt = Date.now();
    playAttempts += 1;
    log('尝试恢复播放，找到视频数：' + videos.length + '，第 ' + playAttempts + ' 次');
    for (const video of paused) {
      tryPlayVideo(video).catch(() => {});
    }
  }

  function ensurePlaying(video) {
    if (!enabled || !video || !video.paused || video.ended) return;
    if (autoPlaySucceeded) return;
    if (playAttempts >= MAX_PLAY_ATTEMPTS) return;
    if (Date.now() - lastPlayAttemptAt < 5000) return;
    playVideos();
  }

  function parsePercent(text) {
    const m = String(text || '').match(/(\d{1,3})\s*%/);
    return m ? Math.max(0, Math.min(100, Number(m[1]))) : null;
  }

  function isActiveRow(row) {
    if (!row || !row.el) return false;
    const own = (row.el.className && String(row.el.className)) + ' ' + (row.el.id || '');
    if (/(?:^|[\s_-])(active|current|playing|selected|on|cur)(?:[\s_-]|$)/i.test(own)) return true;

    try {
      const marked = row.el.querySelectorAll('[class],[aria-current]');
      for (const el of marked) {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (el.getAttribute('aria-current') === 'true') return true;
        if (/(?:^|[\s_-])(active|current|playing|selected|cur)(?:[\s_-]|$)/i.test(cls)) return true;
      }
    } catch (_) {}
    return false;
  }

  function collectEpisodes() {
    const byEl = new Map();

    function addRow(el) {
      if (!el || byEl.has(el)) return;
      const txt = textOf(el);
      if (!txt || txt.length > 700) return;

      const durations = txt.match(/\d{1,3}:\d{2}(?::\d{2})?/g) || [];
      const percents = txt.match(/\d{1,3}\s*%/g) || [];
      if (!durations.length || !percents.length) return;
      if (durations.length > 2 || percents.length > 2) return;

      const durationText = durations[durations.length - 1];
      const percentText = percents[percents.length - 1];
      const progress = parsePercent(percentText);
      const durationSec = parseDuration(durationText);
      if (progress == null || !durationSec) return;

      let title = '';
      let titleEl = null;
      try {
        const candidates = el.querySelectorAll('*');
        for (const child of candidates) {
          if (child.children && child.children.length > 2) continue;
          const t = textOf(child);
          if (!t || t.length < 3 || t.length > 220) continue;
          if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(t)) continue;
          if (/^\d{1,3}\s*%$/.test(t)) continue;
          if (t === durationText || t === percentText) continue;
          if (t.length > title.length) {
            title = t;
            titleEl = child;
          }
        }
      } catch (_) {}

      if (!title) {
        title = txt
          .replace(/\d{1,3}:\d{2}(?::\d{2})?/g, '')
          .replace(/\d{1,3}\s*%/g, '')
          .trim()
          .slice(0, 120);
        titleEl = el;
      }

      byEl.set(el, {
        el,
        title: title || '未命名分集',
        titleEl: titleEl || el,
        durationText,
        durationSec,
        progress,
      });
    }

    try { document.querySelectorAll('tr').forEach(addRow); } catch (_) {}

    if (byEl.size < 2) {
      // 部分页面用 li/div 渲染分集，用“时长文本节点”向上找行
      try {
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = (node.nodeValue || '').trim();
          if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(t)) continue;
          let cur = node.parentElement;
          for (let i = 0; i < 8 && cur && cur !== document.body; i++, cur = cur.parentElement) {
            const txt = textOf(cur);
            if (txt.length < 700 && /\d{1,3}:\d{2}(?::\d{2})?/.test(txt) && /\d{1,3}\s*%/.test(txt)) {
              addRow(cur);
              break;
            }
          }
        }
      } catch (_) {}
    }

    const rows = [...byEl.values()];
    rows.sort((a, b) => {
      try {
        if (a.el === b.el) return 0;
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      } catch (_) {
        return 0;
      }
    });
    return rows;
  }

  function chooseActiveIndex(episodes, video) {
    // 优先用视频实际时长匹配分集：重播已完成分集时，进度百分比会误导
    if (video && video.duration > 30 && episodes.length) {
      const tolerance = Math.max(3, video.duration * 0.02);
      const matches = episodes
        .map((e, i) => ({ e, i, diff: Math.abs(e.durationSec - video.duration) }))
        .filter((x) => x.diff <= tolerance);
      if (matches.length) {
        const videoPct = video.duration ? (video.current / video.duration) * 100 : 0;
        matches.sort((a, b) => {
          const ap = a.e.progress >= 100 ? 1 : 0;
          const bp = b.e.progress >= 100 ? 1 : 0;
          if (ap !== bp) return ap - bp; // 优先未完成的分集
          return Math.abs(a.e.progress - videoPct) - Math.abs(b.e.progress - videoPct);
        });
        return matches[0].i;
      }
    }

    let idx = episodes.findIndex(isActiveRow);
    if (idx >= 0) return idx;

    idx = episodes.findIndex((e) => e.progress > 0 && e.progress < 100);
    if (idx >= 0) return idx;

    idx = episodes.findIndex((e) => e.progress < 100);
    if (idx >= 0) return idx;

    return episodes.length - 1;
  }

  function findResumeIndex(episodes) {
    // 按课程顺序找最早未完成的分集，避免前面某一集没看完就被后面的分集跳过。
    // 例如第三集 68%、第四集 54% 时，应先补第三集。
    return episodes.findIndex((e) => e.progress < CONFIG.completeThreshold);
  }

  function clickElement(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    try { rect = el.getBoundingClientRect(); } catch (_) {}

    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };

    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return true;
    } catch (err) {
      log('点击分集失败：' + (err && err.message || err));
      return false;
    }
  }

  function switchToEpisode(episode) {
    const now = Date.now();
    const key = normalizeTitle(episode.title);
    if (now - lastSwitchAt < CONFIG.switchCooldownMs && key === lastSwitchKey) return;
    if (!enabled) return;

    lastSwitchAt = now;
    lastSwitchKey = key;
    lastPlayAttemptAt = 0;
    playAttempts = 0;
    autoPlaySucceeded = false;
    log('切换到下一集：' + episode.title);
    updatePanel({
      status: '正在切换：' + episode.title,
      detail: '点击下一集后会自动恢复播放',
      next: '',
      tone: 'warn',
    });

    const target = episode.titleEl || episode.el;
    clickElement(target);

    setTimeout(() => playVideos(true), 1200);
    setTimeout(() => playVideos(true), 3500);
  }

  function getCourseTitle() {
    const bad = /学习公社|课程详情|课程分集|主讲老师|学习进度|课件名称|课件时长|我的学习|课程学习|所有课程/;
    const selectors = [
      'h1', 'h2', 'h3',
      '.course-title', '.courseName', '.course-name', '.course_title',
      '[class*="courseName"]', '[class*="course-name"]', '[class*="courseTitle"]', '[class*="course-title"]',
      '[class*="title"]', '[class*="name"]',
    ];
    const found = [];
    for (const sel of selectors) {
      let els = [];
      try { els = document.querySelectorAll(sel); } catch (_) { continue; }
      for (const el of els) {
        const t = textOf(el);
        if (!t || t.length < 6 || t.length > 120) continue;
        if (bad.test(t)) continue;
        let size = 0;
        try { size = parseFloat(getComputedStyle(el).fontSize) || 0; } catch (_) {}
        found.push({ t, size });
      }
      if (found.length) break;
    }
    found.sort((a, b) => b.size - a.size || b.t.length - a.t.length);
    if (found.length) return found[0].t.slice(0, 100);

    const docTitle = String(document.title || '').replace(/学习公社云平台|学习公社|云平台/g, '').trim();
    return docTitle.slice(0, 100);
  }

  // ==================== 播放页逻辑 ====================

  function tickPlayer() {
    if (!enabled) {
      updatePanel({ status: '监控已暂停', detail: '点击右上角“恢复监控”继续', next: '', tone: 'off' });
      return;
    }

    const episodes = collectEpisodes();
    const video = currentVideoState();

    if (!episodes.length) {
      updatePanel({
        status: '等待课程分集加载…',
        detail: video ? '视频剩余 ' + formatDuration(video.duration - video.current) : '尚未识别到分集列表',
        next: '',
        tone: 'warn',
      });
      return;
    }

    const activeIdx = chooseActiveIndex(episodes, video);
    const active = episodes[Math.max(0, activeIdx)];
    const nextEpisode = episodes.slice(activeIdx + 1).find((e) => e.progress < CONFIG.completeThreshold) || null;
    const completed = episodes.filter((e) => e.progress >= CONFIG.completeThreshold).length;

    const videoMatchesEpisode = Boolean(
      video && active && active.durationSec > 0 &&
      Math.abs(video.duration - active.durationSec) <= Math.max(5, active.durationSec * 0.05)
    );
    const progressRemaining = active ? active.durationSec * (100 - active.progress) / 100 : null;
    const remaining = progressRemaining;

    const allDone = episodes.length > 0 && episodes.every((e) => e.progress >= CONFIG.completeThreshold);

    // 整门课所有分集都达到 100% 后，不要因为站点从第一集重新开始播放
    // 就再次续播/重播，而是直接切到下一门课程。
    if (allDone && activeIdx === 0 && videoMatchesEpisode && video.current < 60 && !switching) {
      if (!finishSince) finishSince = Date.now();
      const elapsed = Date.now() - finishSince;
      if (elapsed >= CONFIG.finishConfirmMs) {
        completeCourse(episodes, active);
      } else {
        updatePanel({
          status: '本课程已完成，准备切换下一门课程…',
          detail: `所有分集已达到 ${CONFIG.completeThreshold}% 以上，${Math.ceil((CONFIG.finishConfirmMs - elapsed) / 1000)} 秒后切换`,
          next: prefetchedNext ? '下一课程：' + (prefetchedNext.title || prefetchedNext.courseId) : '',
          tone: 'warn',
        });
      }
      return;
    }

    // 刷新/重新进入课程后，站点会从第一集开始。自动续播到上次未看完的分集。
    // 只切换到对应分集；播放位置由下面的“网页进度定位”逻辑处理。
    const resumeIdx = findResumeIndex(episodes);

    if (resumeIdx >= 0 && resumeIdx === activeIdx) {
      // 当前已经在“最早未完成”的分集上，重置补全尝试次数
      resumeAttempts = 0;
    }

    // 如果当前在后面的分集，但前面还有分集没到 100%，先跳回去补全，避免遗漏。
    if (resumeIdx >= 0 && resumeIdx < activeIdx && resumeAttempts < 2 && Date.now() - lastResumeAt > 8000) {
      const target = episodes[resumeIdx];
      resumeAttempted = true;
      resumeAttempts += 1;
      lastResumeAt = Date.now();
      log('前面还有分集未完成，跳回补全', { title: target.title, progress: target.progress, attempt: resumeAttempts });
      updatePanel({
        status: '还有分集未完成，跳回补全：' + target.title,
        detail: `网页进度 ${target.progress}%`,
        next: '',
        tone: 'warn',
      });
      clickElement(target.titleEl || target.el);
      lastPlayAttemptAt = 0;
      playAttempts = 0;
      autoPlaySucceeded = false;
      setTimeout(() => playVideos(true), 1500);
      setTimeout(() => playVideos(true), 3500);
      return;
    }

    if (resumeIdx > activeIdx && resumeAttempts < 2 && Date.now() - lastResumeAt > 8000) {
      const target = episodes[resumeIdx];
      resumeAttempted = true;
      resumeAttempts += 1;
      lastResumeAt = Date.now();
      log('自动续播到上次分集', { title: target.title, progress: target.progress, attempt: resumeAttempts });
      updatePanel({
        status: '正在续播：' + target.title,
        detail: `网页进度 ${target.progress}%`,
        next: '',
        tone: 'warn',
      });
      clickElement(target.titleEl || target.el);
      lastPlayAttemptAt = 0;
      playAttempts = 0;
      autoPlaySucceeded = false;
      setTimeout(() => playVideos(true), 1500);
      setTimeout(() => playVideos(true), 3500);
      return;
    }

    // 前面还有分集未完成时，不允许继续往后跳，先等补全逻辑把它处理完。
    if (resumeIdx >= 0 && resumeIdx < activeIdx) {
      updatePanel({
        status: '前面还有分集未完成，等待补全',
        detail: `最早未完成：${episodes[resumeIdx].title} ${episodes[resumeIdx].progress}%`,
        next: '',
        tone: 'warn',
      });
      return;
    }

    // 以网页显示的进度为准。视频元素先播完、但网页进度还没到阈值时，
    // 不切下一集；回到网页进度对应的位置重播剩余部分，让平台重新记录。
    const videoEnded = Boolean(videoMatchesEpisode && (video.ended || video.duration - video.current <= 5));
    const pageNotDone = Boolean(active && active.progress < CONFIG.completeThreshold);

    const currentDesyncKey = active ? `${active.title}|${active.progress}` : '';
    if (currentDesyncKey !== desyncKey) {
      desyncKey = currentDesyncKey;
      desyncReplayAttempts = 0;
      desyncSince = 0;
    }

    if (videoEnded && pageNotDone) {
      if (!desyncSince) desyncSince = Date.now();
      const waited = Date.now() - desyncSince;

      if (waited > 8000 && desyncReplayAttempts < CONFIG.maxDesyncReplayAttempts && Date.now() - lastDesyncReplayAt > 30000) {
        try {
          video.video.currentTime = Math.floor(video.duration * (active.progress / 100));
          desyncReplayAttempts += 1;
          lastDesyncReplayAt = Date.now();
          desyncSince = 0;
          log('视频结束但网页进度未达标，回到网页进度位置重播', active.progress);
          updatePanel({
            status: '视频已结束，网页进度未达标',
            detail: `已回到网页进度 ${active.progress}% 的位置重播，等待平台记录`,
            next: nextEpisode ? '下一集：' + nextEpisode.title : '',
            tone: 'warn',
          });
          playVideos(true);
        } catch (_) {}
        return;
      }

      if (waited > 8000 && desyncReplayAttempts >= CONFIG.maxDesyncReplayAttempts) {
        updatePanel({
          status: `视频已结束，但网页进度只有 ${active.progress}%`,
          detail: '平台没有记录完整观看，请手动检查或重看本集',
          next: '',
          tone: 'err',
        });
        return;
      }

      updatePanel({
        status: '视频已结束，等待网页进度更新…',
        detail: `网页进度 ${active.progress}% · 已完成 ${completed}/${episodes.length} 集`,
        next: nextEpisode ? '下一集：' + nextEpisode.title : '',
        tone: 'warn',
      });
      return;
    }

    desyncSince = 0;

    // 按网页显示的进度定位：floor(进度% × 分集时长)。
    // 只向前跳到网页已经记录的进度，不允许超过它；播放器可能在初始化时把
    // currentTime 重置为 0，所以允许重试几次。
    if (videoMatchesEpisode && active && active.progress > 1 && active.progress < CONFIG.completeThreshold) {
      const target = Math.floor(video.duration * (active.progress / 100));
      if (video.current < target - 5) {
        const sameTarget = pageSeekTitle === active.title && Math.abs(pageSeekTarget - target) < 5;
        if (!sameTarget) {
          pageSeekTitle = active.title;
          pageSeekTarget = target;
          pageSeekAttempts = 0;
          lastPageSeekAt = 0;
        }
        if (pageSeekAttempts < MAX_PAGE_SEEK_ATTEMPTS && Date.now() - lastPageSeekAt > 2500) {
          try {
            video.video.currentTime = target;
            pageSeekAttempts += 1;
            lastPageSeekAt = Date.now();
            log('按网页进度定位', {
              progress: active.progress,
              target: formatDuration(target),
              attempt: pageSeekAttempts,
              current: formatDuration(video.current),
            });
            updatePanel({
              status: `按网页进度 ${active.progress}% 继续`,
              detail: `定位到 ${formatDuration(target)} / ${formatDuration(video.duration)}（第 ${pageSeekAttempts} 次）`,
              next: nextEpisode ? '下一集：' + nextEpisode.title : '',
              tone: 'warn',
            });
            playVideos(true);
          } catch (_) {}
        }
      } else {
        // 已经定位到网页进度附近，或者播放器自己恢复得更靠后，不再干预
        pageSeekTitle = '';
        pageSeekTarget = 0;
        pageSeekAttempts = 0;
        lastPageSeekAt = 0;
      }
    }

    // 刷新后视频常常是暂停的；自动尝试播放（必要时静音）
    if (resumeIdx <= activeIdx && video && video.paused && !video.ended && !(allDone && !nextEpisode)) {
      ensurePlaying(video);
    }

    const finished = Boolean(
      (active && active.progress >= CONFIG.completeThreshold) ||
      (allDone && !nextEpisode)
    );

    if (!finished) {
      // 还有一个兜底：进度显示 100%，且没有视频可读，也进入切换
      updatePanel({
        status: active
          ? `第 ${activeIdx + 1}/${episodes.length} 集 · 剩余 ${formatDuration(remaining == null ? 0 : remaining)}`
          : '监控中…',
        detail: active
          ? `网页进度 ${active.progress}% · 已完成 ${completed}/${episodes.length} 集`
          : `已完成 ${completed}/${episodes.length} 集`,
        next: nextEpisode
          ? '下一集：' + nextEpisode.title
          : '本课程最后一集，结束后切换下一门课程',
      });
      return;
    }

    if (nextEpisode) {
      finishSince = 0;
      switchToEpisode(nextEpisode);
      return;
    }

    // 切换下一门课程前，必须确认所有分集都达到 100%。
    if (!allDone) {
      const missing = findResumeIndex(episodes);
      updatePanel({
        status: '还有分集未完成，暂不切换课程',
        detail: missing >= 0
          ? `最早未完成：${episodes[missing].title} ${episodes[missing].progress}%`
          : '等待网页进度更新',
        next: '',
        tone: 'warn',
      });
      return;
    }

    // 本课程所有分集都达到 100%，准备切下一门课程
    if (!finishSince) {
      finishSince = Date.now();
      log('本课程已完成，准备切换下一门课程');
    }

    const elapsed = Date.now() - finishSince;
    if (elapsed < CONFIG.finishConfirmMs) {
      updatePanel({
        status: '本课程已完成，准备切换下一门课程…',
        detail: `将在 ${Math.ceil((CONFIG.finishConfirmMs - elapsed) / 1000)} 秒后切换`,
        next: prefetchedNext ? '下一课程：' + (prefetchedNext.title || prefetchedNext.courseId) : '',
        tone: 'warn',
      });
      return;
    }

    completeCourse(episodes, active);
  }

  function completeCourse(episodes, active) {
    if (switching) return;
    const now = Date.now();
    if (now - lastCompleteAt < CONFIG.completeRetryMs) {
      updatePanel({
        status: '切换失败，等待重试…',
        detail: '请确认“全部课程”标签页仍然打开',
        tone: 'err',
      });
      return;
    }

    switching = true;
    lastCompleteAt = now;
    const courseId = getCourseId();
    const circleId = getCircleId();
    const title = getCourseTitle();

    updatePanel({
      status: '正在切换到下一门课程…',
      detail: '向“全部课程”标签页查询下一门课程',
      next: '',
      tone: 'warn',
    });

    chrome.runtime.sendMessage({
      type: 'course-auto:complete',
      courseId,
      circleId,
      title,
      episodes: episodes.map((e) => ({ title: e.title, progress: e.progress })),
    }, (res) => {
      if (chrome.runtime.lastError) {
        switching = false;
        updatePanel({
          status: '切换失败：后台无响应',
          detail: chrome.runtime.lastError.message || '',
          tone: 'err',
        });
        return;
      }
      if (!res || !res.ok) {
        switching = false;
        log('切换下一门课程失败', res);
        updatePanel({
          status: '切换失败：' + ((res && res.error) || '未找到下一门课程'),
          detail: '请确认“全部课程”标签页已打开，或手动切换',
          tone: 'err',
        });
        return;
      }

      log('已请求切换到下一门课程', res.next);
      updatePanel({
        status: '已切换：' + ((res.next && (res.next.title || res.next.courseId)) || '下一门课程'),
        detail: '新课程加载后会自动继续检查',
        next: '',
      });
    });
  }

  // ==================== 课程列表页逻辑 ====================

  function collectCourseRows(doc) {
    const scope = doc || document;
    const byEl = new Map();
    const candidates = [];

    try {
      scope.querySelectorAll('tr').forEach((el) => candidates.push(el));
    } catch (_) {}

    if (!candidates.length) {
      try {
        const all = [...scope.querySelectorAll('li,div')];
        for (const el of all) {
          const t = textOf(el);
          if (t.length > 0 && t.length < 600 && /\d{1,3}:\d{2}(?::\d{2})?/.test(t) && /\d{1,3}\s*%/.test(t)) {
            candidates.push(el);
          }
        }
      } catch (_) {}
    }

    // 对 div/li 候选，保留最内层包含“时长+百分比+学习”的元素
    const cleaned = candidates.filter((el) => {
      if (!el || !el.querySelectorAll) return false;
      let childCount = 0;
      for (const other of candidates) {
        if (other !== el && el.contains(other)) childCount++;
      }
      return childCount === 0;
    });

    for (const el of cleaned) {
      if (byEl.has(el)) continue;
      const txt = textOf(el);
      if (!txt || txt.length > 600) continue;
      if (!/\d{1,3}:\d{2}(?::\d{2})?/.test(txt)) continue;
      if (!/\d{1,3}\s*%/.test(txt)) continue;

      const durationMatch = txt.match(/\d{1,3}:\d{2}(?::\d{2})?/);
      const duration = durationMatch ? durationMatch[0] : '';
      const progress = parsePercent(txt);
      if (progress == null) continue;

      let learn = null;
      let learnCandidates = [];
      try {
        learnCandidates = [...el.querySelectorAll('a,button,[role="button"],[onclick]')];
      } catch (_) {}
      learn = learnCandidates.find((x) => {
        const t = textOf(x);
        const label = t + ' ' +
          (x.getAttribute('title') || '') + ' ' +
          (x.getAttribute('aria-label') || '') + ' ' +
          (x.getAttribute('value') || '');
        const href = x.getAttribute('href') || '';
        const onclick = x.getAttribute('onclick') || '';
        return /学习|开始|继续|进入/.test(label) ||
          /viewerforc|courseId=/i.test(href) ||
          /study|course|learn|play|open/i.test(onclick);
      }) || null;
      if (!learn) {
        // 这类页面最后一列的“学习”按钮常常只有图标、没有文字，取行内最后一个链接
        const anchors = learnCandidates.filter((x) => x.tagName === 'A');
        learn = anchors.length ? anchors[anchors.length - 1] : (learnCandidates[learnCandidates.length - 1] || null);
      }
      if (!learn) continue;

      const html = (el.outerHTML || '').slice(0, 20000);
      const learnHref = learn.getAttribute('href') || '';
      const learnOnclick = learn.getAttribute('onclick') || '';
      const courseId = extractCourseId(el, learn, html, learnHref, learnOnclick);

      let title = '';
      try {
        const titleSpan = el.querySelector('.course-title');
        if (titleSpan) {
          title = titleSpan.getAttribute('title') || textOf(titleSpan);
        }
      } catch (_) {}
      if (!title) {
        try {
          const cells = [...el.children]
            .map((c) => textOf(c))
            .filter((t) => t && t.length >= 3 && t.length <= 160)
            .filter((t) => !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(t))
            .filter((t) => !/^\d{1,3}\s*%$/.test(t))
            .filter((t) => !/^学习$|^开始学习$|^继续学习$/.test(t))
            .filter((t) => !/^(New|NEW|新)$/.test(t));
          cells.sort((a, b) => b.length - a.length);
          title = cells[0] || '';
        } catch (_) {}
      }

      if (!title) {
        title = txt
          .replace(/\d{1,3}:\d{2}(?::\d{2})?/g, '')
          .replace(/\d{1,3}\s*%/g, '')
          .replace(/学习/g, '')
          .trim()
          .slice(0, 120);
      }

      title = title.replace(/^New\s*/i, '').replace(/^【.*?】/, '').trim();

      byEl.set(el, { el, title, courseId, duration, progress, learn, html });
    }

    const rows = [...byEl.values()];
    rows.sort((a, b) => {
      try {
        if (a.el === b.el) return 0;
        return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      } catch (_) {
        return 0;
      }
    });
    return rows;
  }

  function collectAllCourseRows() {
    const all = [];
    const seen = new Set();
    for (const item of getAccessibleDocs()) {
      let rows = [];
      try { rows = collectCourseRows(item.doc); } catch (_) { rows = []; }
      for (const row of rows) {
        const key = row.courseId
          ? 'id:' + row.courseId
          : 't:' + normalizeTitle(row.title) + '|' + row.duration;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(row);
      }
    }
    return all;
  }

  function extractCourseId(el, learn, html, href, onclick) {
    const attributeSources = [
      'courseid-id', 'courseid', 'course-id',
      'data-courseid', 'data-course-id', 'data-course', 'data-vurl',
    ];
    for (const attr of attributeSources) {
      const v = (learn && learn.getAttribute(attr)) || (el && el.getAttribute(attr)) || '';
      if (!v) continue;
      if (/^\d{4,}$/.test(v.trim())) return v.trim();
      const m = v.match(/[?&]courseId=(\d+)/i);
      if (m) return m[1];
    }

    const sources = [href, onclick, html];
    for (const src of sources) {
      if (!src) continue;
      let m = src.match(/(?:courseId|courseid|course_id|courseid)\s*[=:]\s*["']?(\d{4,})/i);
      if (m) return m[1];
      m = src.match(/(?:open|study|learn|play|to|go)[A-Za-z]*\s*\(\s*["']?(\d{4,})/i);
      if (m) return m[1];
    }
    return '';
  }

  function findCourseIndex(rows, msg) {
    const id = String(msg.courseId || '');
    if (id) {
      const idx = rows.findIndex((r) => String(r.courseId) === id || (r.html && r.html.includes(id)));
      if (idx >= 0) return idx;
    }

    const want = normalizeTitle(msg.title || '');
    if (want.length >= 6) {
      let best = -1;
      let bestScore = 0;
      rows.forEach((r, i) => {
        const have = normalizeTitle(r.title);
        if (!have || have.length < 6) return;
        let score = 0;
        if (have === want) score = 1000;
        else if (have.includes(want)) score = 500 + want.length;
        else if (want.includes(have)) score = 300 + have.length;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      });
      if (best >= 0) return best;
    }
    return -1;
  }

  function rowToResult(row) {
    if (!row) return { ok: false, error: '下一课程为空' };
    let courseId = row.courseId || '';
    let url = '';
    try {
      const learn = row.learn;
      const raw = (learn && (learn.getAttribute('data-vurl') || learn.getAttribute('href'))) || '';
      if (raw && !/^javascript:/i.test(raw)) {
        const u = new URL(raw, location.origin);
        if (/^https?:/i.test(u.href) && /(^|\.)enaea\.edu\.cn$/i.test(u.hostname)) {
          url = u.href;
          if (!courseId) {
            const m = u.href.match(/[?&]courseId=(\d+)/i);
            if (m) courseId = m[1];
          }
        }
      }
    } catch (_) {}
    if (!courseId) {
      const m = String(row.html || '').match(/[?&]courseId=(\d+)/i);
      if (m) courseId = m[1];
    }
    return {
      ok: true,
      courseId,
      title: row.title || '',
      duration: row.duration || '',
      progress: row.progress,
      url,
    };
  }

  function pageNumberFor(url, text) {
    const direct = parseInt(String(text || '').trim(), 10);
    if (!Number.isNaN(direct)) return direct;
    const m = String(url || '').match(/(?:page|pageNo|pageIndex|pageNum|currentPage)=(\d+)/i);
    return m ? Number(m[1]) : 9999;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getPageNumbers() {
    const nums = [];
    try {
      document.querySelectorAll('#J_myOptionRecords_paginate a, .dataTables_paginate a').forEach((a) => {
        const t = textOf(a);
        if (/^\d+$/.test(t)) nums.push(parseInt(t, 10));
      });
    } catch (_) {}
    return [...new Set(nums)].sort((a, b) => a - b);
  }

  function getActivePage() {
    try {
      const active = document.querySelector('#J_myOptionRecords_paginate a.paginate_active, .dataTables_paginate a.paginate_active');
      if (active) {
        const n = parseInt(textOf(active), 10);
        if (!Number.isNaN(n)) return n;
      }
    } catch (_) {}
    return 1;
  }

  async function gotoPage(page) {
    if (!page) return false;
    if (getActivePage() === page) return true;

    let btn = null;
    try {
      btn = [...document.querySelectorAll('#J_myOptionRecords_paginate a, .dataTables_paginate a')]
        .find((a) => textOf(a) === String(page)) || null;
    } catch (_) {}
    if (!btn) return false;

    const before = collectAllCourseRows();
    const beforeKey = before.map((r) => r.courseId + '|' + r.title).join('~');

    clickElement(btn);

    const start = Date.now();
    while (Date.now() - start < 6000) {
      await sleep(200);
      const now = collectAllCourseRows();
      const nowKey = now.map((r) => r.courseId + '|' + r.title).join('~');
      if (now.length && nowKey !== beforeKey) return true;
      if (getActivePage() === page && now.length && nowKey !== beforeKey) return true;
    }
    return getActivePage() === page;
  }

  async function walkPagesForCourse(msg) {
    const originalPage = getActivePage();
    const pages = getPageNumbers();
    if (!pages.length) return null;

    let result = null;
    try {
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (!(await gotoPage(page))) continue;
        const rows = collectAllCourseRows();
        const idx = findCourseIndex(rows, msg);
        if (idx < 0) continue;
        if (idx + 1 < rows.length) {
          result = rowToResult(rows[idx + 1]);
          break;
        }
        // 当前课程是本页最后一门，取下一页第一门
        if (i + 1 < pages.length) {
          if (await gotoPage(pages[i + 1])) {
            const nextRows = collectAllCourseRows();
            if (nextRows.length) result = rowToResult(nextRows[0]);
          }
        }
        break;
      }
    } finally {
      if (originalPage && getActivePage() !== originalPage) {
        try { await gotoPage(originalPage); } catch (_) {}
      }
    }
    return result;
  }

  async function fetchOtherPages() {
    const current = location.href.split('#')[0];
    const links = [];
    for (const item of getAccessibleDocs()) {
      try {
        item.doc.querySelectorAll('a[href]').forEach((a) => {
          const text = textOf(a);
          const href = a.getAttribute('href') || '';
          if (!href || /^javascript:/i.test(href) || href === '#') return;
          if (!(/^\d+$/.test(text) || text === '>' || text === '下一页' || text === '下页')) return;
          try {
            const u = new URL(href, item.doc.baseURI || location.href);
            if (!/^https?:/i.test(u.href)) return;
            if (!/(^|\.)enaea\.edu\.cn$/i.test(u.hostname)) return;
            u.hash = '';
            links.push({ url: u.href, num: pageNumberFor(u.href, text) });
          } catch (_) {}
        });
      } catch (_) {}
    }

    const seen = new Set([current]);
    const ordered = [];
    links.sort((a, b) => a.num - b.num);
    for (const item of links) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      ordered.push(item);
      if (ordered.length >= 12) break;
    }

    const pages = [];
    for (const item of ordered) {
      try {
        const res = await fetch(item.url, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) continue;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = collectCourseRows(doc);
        if (rows.length) pages.push({ url: item.url, rows });
      } catch (_) {}
    }
    return pages;
  }

  async function findNextCourse(msg) {
    let rows = collectAllCourseRows();
    let idx = findCourseIndex(rows, msg);

    if (idx >= 0 && idx + 1 < rows.length) {
      return rowToResult(rows[idx + 1]);
    }

    // 当前页找不到或当前课程是本页最后一门：通过 DataTables 翻页查找
    const walked = await walkPagesForCourse(msg);
    if (walked) return walked;

    rows = collectAllCourseRows();
    idx = findCourseIndex(rows, msg);
    if (idx < 0) {
      return { ok: false, error: '在课程列表中没有找到当前课程（请确认列表页已加载完成）' };
    }
    if (idx === rows.length - 1) {
      return { ok: false, error: '当前课程已经是列表中的最后一门' };
    }
    return rowToResult(rows[idx + 1]);
  }

  function tickList() {
    const rows = collectAllCourseRows();
    updatePanel({
      status: '课程列表已就绪',
      detail: `本页识别到 ${rows.length} 门课程 · 等待播放页请求`,
      next: '下一课程会在当前课程结束后自动打开',
    });
  }

  // ==================== 诊断 ====================

  function buildDiagnostics() {
    const episodes = IS_PLAYER ? collectEpisodes() : [];
    const courses = IS_LIST ? collectAllCourseRows() : [];
    const videos = getVideos().map((v) => ({
      src: String(v.currentSrc || v.src || '').slice(0, 300),
      duration: v.duration,
      currentTime: v.currentTime,
      paused: v.paused,
      ended: v.ended,
    }));

    const links = [];
    for (const item of getAccessibleDocs()) {
      try {
        item.doc.querySelectorAll('a[href]').forEach((a) => {
          const t = textOf(a);
          if (!/学习|课程|video|course/i.test(t + ' ' + a.href)) return;
          if (links.length >= 50) return;
          links.push({
            text: t.slice(0, 80),
            href: String(a.getAttribute('href') || '').slice(0, 300),
            onclick: String(a.getAttribute('onclick') || '').slice(0, 300),
          });
        });
      } catch (_) {}
    }

    const frames = getAccessibleDocs().map((item) => {
      let frameUrl = '';
      try { frameUrl = item.win.location.href; } catch (_) { frameUrl = '(cross-origin)'; }
      return {
        url: frameUrl,
        rows: (() => { try { return collectCourseRows(item.doc).length; } catch (_) { return 0; } })(),
      };
    });

    const bodyText = (() => { try { return textOf(document.body || document.documentElement); } catch (_) { return ''; } })();
    const titleSamples = [];
    const learnSamples = [];
    let sampleRow = null;
    try {
      sampleRow = [...document.querySelectorAll('tr')].find((tr) => textOf(tr).includes('认真学习党章')) || null;
    } catch (_) {}
    const rowLinks = [];
    if (sampleRow) {
      try {
        sampleRow.querySelectorAll('a,button,input,[onclick]').forEach((el) => {
          rowLinks.push({
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 100),
            text: textOf(el).slice(0, 40),
            title: String(el.getAttribute('title') || '').slice(0, 80),
            aria: String(el.getAttribute('aria-label') || '').slice(0, 80),
            href: String(el.getAttribute('href') || '').slice(0, 200),
            onclick: String(el.getAttribute('onclick') || '').slice(0, 300),
            html: String(el.outerHTML || '').slice(0, 500),
          });
        });
      } catch (_) {}
    }
    try {
      const titleNodes = [...document.querySelectorAll('a,td,div,span,tr,li,h1,h2,h3,h4,p')]
        .filter((el) => {
          const t = textOf(el);
          return t.includes('认真学习党章') && t.length < 300;
        })
        .slice(-8);
      for (const el of titleNodes) {
        titleSamples.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 100),
          text: textOf(el).slice(0, 160),
          parent: el.parentElement ? el.parentElement.tagName + '.' + String(el.parentElement.className || '').slice(0, 60) : '',
          html: String(el.outerHTML || '').slice(0, 500),
        });
      }
    } catch (_) {}
    try {
      const learnNodes = [...document.querySelectorAll('a,button,input,span,div')]
        .filter((el) => /^(学习|开始学习|继续学习)$/.test(textOf(el)))
        .slice(0, 12);
      for (const el of learnNodes) {
        learnSamples.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 100),
          text: textOf(el).slice(0, 40),
          onclick: String(el.getAttribute('onclick') || '').slice(0, 200),
          href: String(el.getAttribute('href') || '').slice(0, 200),
          html: String(el.outerHTML || '').slice(0, 400),
        });
      }
    } catch (_) {}

    return {
      time: new Date().toISOString(),
      url: location.href,
      page: IS_PLAYER ? 'player' : (IS_LIST ? 'list' : 'other'),
      courseId: getCourseId(),
      circleId: getCircleId(),
      courseTitle: getCourseTitle(),
      enabled,
      dom: {
        trCount: (() => { try { return document.querySelectorAll('tr').length; } catch (_) { return 0; } })(),
        hasCourseText: bodyText.includes('认真学习党章'),
        fullRow: sampleRow ? String(sampleRow.outerHTML || '').slice(0, 5000) : '',
        rowLinks,
        titleSamples,
        learnSamples,
      },
      episodes: episodes.map((e) => ({ title: e.title, duration: e.durationText, progress: e.progress })),
      courses: courses.map((c) => ({ title: c.title, courseId: c.courseId, duration: c.duration, progress: c.progress })),
      videos,
      frames,
      links,
      logs: logs.slice(-40),
    };
  }

  async function copyDiagnostics() {
    const data = buildDiagnostics();
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.documentElement.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (err) {
        log('复制诊断失败：' + (err && err.message || err));
      }
    }
    updatePanel({ status: '诊断信息已复制到剪贴板', detail: '可直接粘贴给助手分析', tone: 'warn' });
    setTimeout(() => updatePanel(), 3500);
    log('诊断信息已复制');
  }

  // ==================== 启动 ====================

  function prefetchNext() {
    if (!IS_PLAYER || !enabled) return;
    const courseId = getCourseId();
    if (!courseId) return;
    chrome.runtime.sendMessage({
      type: 'course-auto:prefetch-next',
      courseId,
      circleId: getCircleId(),
      title: getCourseTitle(),
    }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.ok) {
        prefetchedNext = res;
        log('预取下一课程成功', res);
        updatePanel({ next: '下一课程：' + (res.title || res.courseId || '') });
      } else if (res && res.error) {
        log('预取下一课程失败：' + res.error);
      }
    });
  }

  function runTick() {
    try {
      if (IS_PLAYER) tickPlayer();
      else if (IS_LIST) tickList();
    } catch (err) {
      log('检查出错：' + (err && err.message || err));
      updatePanel({ status: '检查出错：' + (err && err.message || err), tone: 'err' });
    }
  }

  function start() {
    if (!document.documentElement) return;
    chrome.storage.local.get({ enaeaAutoNext: true }, (obj) => {
      enabled = obj.enaeaAutoNext !== false;
      buildPanel();
      updatePanel({ status: enabled ? '监控中…' : '监控已暂停' });
      log('启动', { page: IS_PLAYER ? 'player' : 'list', enabled });
    });

    document.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault();
        copyDiagnostics().catch(() => {});
      }
    }, true);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return undefined;
      if (msg.type === 'course-auto:tick') {
        runTick();
        sendResponse({ ok: true });
        return undefined;
      }
      if (msg.type === 'course-auto:find-next' && IS_LIST) {
        findNextCourse(msg)
          .then((res) => {
            if (res && res.ok) {
              updatePanel({
                status: '已找到下一课程',
                detail: res.title || res.courseId || '',
                next: '当前课程结束后自动打开',
                tone: 'warn',
              });
            }
            sendResponse(res);
          })
          .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
        return true;
      }
      return undefined;
    });

    runTick();
    setInterval(runTick, CONFIG.tickMs);
    setTimeout(prefetchNext, 2500);
    setInterval(prefetchNext, CONFIG.prefetchMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
