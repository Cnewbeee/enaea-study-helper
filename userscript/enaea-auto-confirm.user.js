// ==UserScript==
// @name         ENAEAA 学习弹窗自动确认
// @namespace    local.enaea.autoconfirm
// @version      1.0.0
// @description  自动点击观看视频时弹出的“继续学习”确认框，并自动恢复播放
// @author       local
// @match        *://*.enaea.edu.cn/*
// @match        *://enaea.edu.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* ENAEAA 学习视频弹窗自动确认
 * 作用：自动点击“继续学习/继续观看/继续播放/确定”等弹窗按钮，并在点击后恢复视频。
 * 只会在 enaea.edu.cn 域名下运行。
 */
(() => {
  'use strict';

  const host = location.hostname;
  let isTopFrame = true;
  try { isTopFrame = window.top === window; } catch (_) { isTopFrame = true; }
  // 允许 enaea 域名；也允许被 enaea 页面嵌入的跨域播放器 iframe
  const allowedHost = /(^|\.)enaea\.edu\.cn$/i.test(host) ||
    (!isTopFrame && /enaea\.edu\.cn/i.test(document.referrer || ''));
  if (!allowedHost) return;
  if (window.__ENAEA_AUTO_CONFIRM__) return;
  window.__ENAEA_AUTO_CONFIRM__ = true;

  // ==================== 可按需修改的配置 ====================
  const CONFIG = {
    // 高置信度按钮文字：位于弹窗/浮层内时直接点击
    strongTexts: ['继续学习', '继续观看', '继续播放', '确认继续'],
    // 普通确认文字：要求弹窗内容包含学习/观看类关键词才会点击
    weakTexts: ['继续', '确定', '确认', '知道了', '我知道了', '好的'],
    // 用于识别“学习提醒”弹窗的关键词
    popupKeywords: ['分钟', '继续学习', '继续观看', '继续播放', '是否继续', '观看', '学习', '在线'],
    // 弹窗包含这些词时不点普通“确定”，避免误点退出/交卷
    blockKeywords: [
      '退出学习', '退出课程', '离开学习', '离开课程',
      '结束学习', '结束课程', '学习结束', '课程结束',
      '提交', '交卷', '答题', '删除',
      '确认退出', '确定退出',
      '已达上限', '达到上限', '时长已达',
    ],
    clickCooldownMs: 2000,    // 两次点击的最小间隔
    retrySameButtonMs: 8000,  // 同一个按钮 8 秒内不重复点
    scanIntervalMs: 800,      // 定时扫描间隔
    autoResume: true,         // 点击后自动恢复播放
    dryRun: false,            // true = 只打印日志、不点击（调试用）
    debug: true,
  };
  // ==========================================================

  const LOG_PREFIX = '[enaea-auto]';
  const CLICKABLE_SELECTOR = [
    'button',
    'a',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
    '[onclick]',
    '[class*="btn"]',
    '[class*="button"]',
    '[class*="confirm"]',
  ].join(',');
  const ROOT_CLASS_RE = /(?:^|[\s_-])(dialog|modal|popup|layer|message-box|messagebox|confirm|alert|overlay|lightbox)(?:[\s_-]|$)/i;
  const SUBPART_RE = /(?:^|[\s_-])(btn\d*|btns|button|footer|header|body|content|title|close|icon|wrapper|inner|mask|backdrop|text|tip)(?:[\s_-]|$)/i;
  const RESUME_MSG = '__enaea_auto_resume_video__';

  const lastClickedAt = new WeakMap();
  let lastAnyClickAt = 0;
  let lastScanAt = 0;
  let started = false;

  function log(...args) {
    if (CONFIG.debug) {
      try { console.log(LOG_PREFIX, ...args); } catch (_) {}
    }
  }

  function normalize(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, '')
      .replace(/[>›»→]+$/g, '');
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const cls = el.classList;
    if (cls && (cls.contains('disabled') || cls.contains('is-disabled') || cls.contains('layui-disabled'))) {
      return false;
    }
    let style;
    try { style = getComputedStyle(el); } catch (_) { return false; }
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function isSubPart(cls) {
    if (!cls) return false;
    if (cls.includes('__')) return true;
    return SUBPART_RE.test(cls);
  }

  // 向上查找弹窗/浮层容器；找不到返回 null
  function getDialogRoot(el) {
    let node = el.parentElement;
    let fallback = null;
    let depth = 0;
    while (node && node !== document.body && node !== document.documentElement && depth < 15) {
      try {
        const role = node.getAttribute && node.getAttribute('role');
        if (role === 'dialog' || role === 'alertdialog') return node;

        const cls = typeof node.className === 'string' ? node.className : '';
        const style = getComputedStyle(node);
        const floating = (style.position === 'fixed' || style.position === 'absolute') &&
          (parseInt(style.zIndex, 10) || 0) >= 100;

        if (floating && !fallback) fallback = node;
        if (cls && !isSubPart(cls) && ROOT_CLASS_RE.test(cls)) return node;
      } catch (_) {}
      node = node.parentElement;
      depth++;
    }
    return fallback;
  }

  function getElementText(el) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'hidden' || el.type === 'text' || el.type === 'password') return '';
      return normalize(el.value);
    }
    return normalize(el.textContent || '');
  }

  function collectCandidates() {
    const texts = [];
    CONFIG.strongTexts.forEach((t, i) => texts.push({ t, i, strong: true }));
    CONFIG.weakTexts.forEach((t, i) => texts.push({ t, i, strong: false }));

    const raw = [];
    const add = (el, match) => {
      if (!el || !(el instanceof Element)) return;
      let target = el;
      try { target = el.closest(CLICKABLE_SELECTOR) || el; } catch (_) {}
      if (!isVisible(el) && !isVisible(target)) return;

      const dialog = getDialogRoot(el);
      if (!dialog || !isVisible(dialog)) return;

      const dialogText = normalize(dialog.innerText || dialog.textContent || '');
      if (!dialogText) return;

      if (!match.strong) {
        if (!CONFIG.popupKeywords.some((k) => dialogText.includes(k))) return;
        // 交卷/提交/删除类弹窗无论如何都不点
        if (['提交', '交卷', '答题', '删除'].some((k) => dialogText.includes(k))) return;
        const positive = match.label === '继续' ||
          /继续学习|继续观看|继续播放|是否继续|还在|仍在/.test(dialogText);
        if (!positive && CONFIG.blockKeywords.some((k) => dialogText.includes(k))) return;
      }

      let score = (match.strong ? 2000 : 1000) - match.i * 10;
      const tag = target.tagName.toLowerCase();
      if (tag === 'button' || tag === 'input' || target.getAttribute('role') === 'button' || target.hasAttribute('onclick')) {
        score += 50;
      } else if (tag === 'a') {
        score += 30;
      }
      if (target !== el) score += 10;
      try {
        if (getComputedStyle(target).cursor === 'pointer') score += 20;
      } catch (_) {}
      if (typeof target.className === 'string' && /btn|button|confirm/i.test(target.className)) score += 15;

      raw.push({ el: target, label: match.t, score });
    };

    document.querySelectorAll(CLICKABLE_SELECTOR).forEach((el) => {
      const text = getElementText(el);
      if (!text) return;
      const match = texts.find((x) => x.t === text);
      if (match) add(el, match);
    });

    // 兜底：某些弹窗按钮是带事件监听的 span/div
    if (raw.length === 0) {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const t = normalize(node.nodeValue);
          if (!t) return NodeFilter.FILTER_SKIP;
          return texts.some((x) => x.t === t) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const text = normalize(node.nodeValue);
        const match = texts.find((x) => x.t === text);
        if (match && node.parentElement) add(node.parentElement, match);
      }
    }

    const byEl = new Map();
    for (const item of raw) {
      const prev = byEl.get(item.el);
      if (!prev || item.score > prev.score) byEl.set(item.el, item);
    }
    return [...byEl.values()];
  }

  function clickElement(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
    } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_) {}
    try {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, { pointerId: 1, pointerType: 'mouse', isPrimary: true })));
    } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_) {}
    try { el.click(); } catch (e) { log('点击失败：', e && e.message); }
  }

  function resumeVideo() {
    if (!CONFIG.autoResume) return;
    const docs = [document];
    for (let i = 0; i < window.frames.length; i++) {
      try {
        if (window.frames[i].document) docs.push(window.frames[i].document);
      } catch (_) {}
    }
    for (const doc of docs) {
      doc.querySelectorAll('video').forEach((v) => {
        try {
          if (v.paused && !v.ended) {
            const p = v.play();
            if (p && typeof p.catch === 'function') {
              p.catch((err) => log('自动播放被浏览器拦截：', err && err.message));
            }
          }
        } catch (_) {}
      });
    }
  }

  function broadcastResume() {
    resumeVideo();
    try { window.postMessage(RESUME_MSG, '*'); } catch (_) {}
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(RESUME_MSG, '*'); } catch (_) {}
    }
  }

  function scan() {
    const now = Date.now();
    if (now - lastScanAt < 250) return;
    lastScanAt = now;
    if (now - lastAnyClickAt < CONFIG.clickCooldownMs) return;

    const candidates = collectCandidates()
      .filter((c) => now - (lastClickedAt.get(c.el) || 0) >= CONFIG.retrySameButtonMs)
      .sort((a, b) => b.score - a.score);
    if (!candidates.length) return;

    const best = candidates[0];
    lastClickedAt.set(best.el, now);
    lastAnyClickAt = now;

    if (CONFIG.dryRun) {
      log('[dry-run] 本应点击：', best.label, best.el);
      return;
    }
    log('点击弹窗按钮：', best.label);
    clickElement(best.el);
    setTimeout(broadcastResume, 700);
  }

  function safeScan() {
    try { scan(); } catch (e) { log('扫描出错：', e && e.message); }
  }

  function start() {
    if (started) return;
    started = true;
    log('已启用，正在等待学习弹窗…', location.href);
    safeScan();
    setInterval(safeScan, CONFIG.scanIntervalMs);
    try {
      new MutationObserver(safeScan).observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    if (event.data === RESUME_MSG) resumeVideo();
  });

  document.addEventListener('enaea-auto:native-confirm', () => {
    log('已确认浏览器原生弹窗');
    if (CONFIG.autoResume) setTimeout(broadcastResume, 600);
  });

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();


/* 处理浏览器原生 confirm / alert 弹窗（Content Script 无法操作系统级弹窗）
 * 仅自动处理“继续学习”类提示，退出/提交类提示保持原样。
 */
(() => {
  'use strict';

  const MARK = '__ENAEA_AUTO_NATIVE__';
  if (window[MARK]) return;
  window[MARK] = true;

  const CONFIRM_KEYWORDS = ['继续学习', '继续观看', '继续播放', '是否继续', '分钟', '观看', '学习', '播放'];
  const ALERT_RE = /(分钟|继续学习|继续观看|继续播放|是否继续)/;
  const BLOCK_KEYWORDS = ['退出学习', '退出课程', '离开课程', '结束学习', '提交', '交卷', '答题', '删除'];
  const ALERT_BLOCK_KEYWORDS = BLOCK_KEYWORDS.concat(['退出', '结束']);

  function shouldAuto(message) {
    const text = String(message == null ? '' : message);
    if (!text) return false;
    if (BLOCK_KEYWORDS.some((k) => text.includes(k))) return false;
    return CONFIRM_KEYWORDS.some((k) => text.includes(k));
  }

  function notify(message) {
    try {
      document.dispatchEvent(new CustomEvent('enaea-auto:native-confirm', { detail: { message } }));
    } catch (_) {}
    try { console.log('[enaea-auto] 已自动确认原生弹窗：', message); } catch (_) {}
  }

  const originalConfirm = window.confirm;
  const originalAlert = window.alert;

  try {
    window.confirm = function (message) {
      if (shouldAuto(message)) {
        notify(String(message));
        return true;
      }
      return originalConfirm.call(window, message);
    };
  } catch (_) {}

  try {
    window.alert = function (message) {
      const text = String(message == null ? '' : message);
      if (ALERT_RE.test(text) && !ALERT_BLOCK_KEYWORDS.some((k) => text.includes(k))) {
        notify(text);
        return;
      }
      return originalAlert.call(window, message);
    };
  } catch (_) {}
})();
