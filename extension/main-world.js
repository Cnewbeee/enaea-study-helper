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
