'use strict';

/**
 * ENAEAA 自动连播 - 后台服务
 *
 * 职责：
 * 1. 接收播放页的“本课程已完成”消息；
 * 2. 找到“全部课程”标签页，向它询问当前课程之后的下一门课程；
 * 3. 把播放页直接导航到下一门课程；
 * 4. 用 alarms 做兜底定时检查（页面计时器被浏览器节流时仍然工作）。
 */

const ENAEA_TAB_URLS = ['*://*.enaea.edu.cn/*', '*://enaea.edu.cn/*'];
const LIST_URL_RE = /(?:circleIndexRedirect|toNewMyClass|myClass|courseList)/i;
const CACHE_KEY = 'enaeaNextCourseCache';
const TICK_ALARM = 'enaea-course-auto-tick';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function ensureAlarm() {
  try {
    chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  } catch (_) {
    // alarms 权限不可用时忽略；页面内的 setInterval 仍会工作
  }
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== TICK_ALARM) return;
  try {
    const tabs = await chrome.tabs.query({ url: ENAEA_TAB_URLS });
    for (const tab of tabs) {
      if (!tab || !tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'course-auto:tick' }).catch(() => {});
    }
  } catch (_) {
    // 查询失败时忽略，下一轮再试
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  if (msg.type === 'course-auto:prefetch-next') {
    handleFindNext(msg, sender)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'course-auto:complete') {
    handleComplete(msg, sender)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  return undefined;
});

async function readCache() {
  try {
    const obj = await chrome.storage.local.get({ [CACHE_KEY]: {} });
    return obj[CACHE_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function writeCache(cache) {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch (_) {
    // 忽略存储失败
  }
}

function safeUrl(tab) {
  try {
    return tab && tab.url ? new URL(tab.url) : null;
  } catch (_) {
    return null;
  }
}

async function findListTab(excludeTabId) {
  const tabs = await chrome.tabs.query({ url: ENAEA_TAB_URLS });
  const candidates = tabs.filter((tab) => {
    if (!tab || !tab.id) return false;
    if (excludeTabId && tab.id === excludeTabId) return false;
    return LIST_URL_RE.test(tab.url || '');
  });

  // 优先“我的课程/全部课程”页面
  candidates.sort((a, b) => {
    const score = (tab) => {
      const url = tab.url || '';
      let s = 0;
      if (/toNewMyClass/i.test(url)) s += 4;
      if (/circleIndexRedirect/i.test(url)) s += 2;
      if (/type=course/i.test(url)) s += 1;
      return s;
    };
    return score(b) - score(a);
  });

  return candidates[0] || null;
}

async function handleFindNext(msg, sender) {
  const senderTabId = sender && sender.tab && sender.tab.id;
  const listTab = await findListTab(senderTabId);
  if (!listTab || !listTab.id) {
    return { ok: false, error: '没有找到“全部课程”标签页，请先把课程列表页保持打开' };
  }

  let res;
  try {
    res = await chrome.tabs.sendMessage(listTab.id, {
      type: 'course-auto:find-next',
      courseId: msg.courseId || '',
      circleId: msg.circleId || '',
      title: msg.title || '',
    });
  } catch (err) {
    return { ok: false, error: '无法读取“全部课程”标签页：' + String(err && err.message || err) };
  }

  if (!res || !res.ok) {
    return res || { ok: false, error: '课程列表没有返回下一课程' };
  }

  const key = String(msg.courseId || res.courseId || 'unknown');
  const cache = await readCache();
  cache[key] = Object.assign({}, res, { savedAt: Date.now() });
  await writeCache(cache);
  return res;
}

async function handleComplete(msg, sender) {
  const senderTab = sender && sender.tab;
  const senderTabId = senderTab && senderTab.id;
  if (!senderTabId) {
    return { ok: false, error: '无法确定当前播放标签页' };
  }

  const current = safeUrl(senderTab);
  if (!current) {
    return { ok: false, error: '当前播放页地址无效' };
  }

  const circleId = String(msg.circleId || current.searchParams.get('circleId') || '');
  const courseId = String(msg.courseId || current.searchParams.get('courseId') || '');
  const cacheKey = courseId || 'unknown';

  let next = null;
  const cache = await readCache();
  const cached = cache[cacheKey];
  if (cached && Date.now() - Number(cached.savedAt || 0) < CACHE_TTL_MS && (cached.courseId || cached.url)) {
    next = cached;
  }

  if (!next) {
    next = await handleFindNext(
      { courseId, circleId, title: msg.title || '' },
      sender
    );
  }

  if (!next || !next.ok || (!next.courseId && !next.url)) {
    return {
      ok: false,
      error: (next && next.error) || '未找到下一门课程',
    };
  }

  let target = null;
  if (next.url) {
    try {
      const u = new URL(next.url, current.origin);
      // 只允许跳回同一学习平台，避免课程列表返回意外外链
      if (/(^|\.)enaea\.edu\.cn$/i.test(u.hostname)) target = u;
    } catch (_) {
      target = null;
    }
  }

  if (!target && next.courseId) {
    target = new URL('/viewerforccvideo.do', current.origin);
    target.searchParams.set('courseId', String(next.courseId));
    if (circleId) target.searchParams.set('circleId', circleId);
  }

  if (!target) {
    return { ok: false, error: '下一门课程的地址无效' };
  }

  await chrome.tabs.update(senderTabId, { url: target.toString() });
  return { ok: true, next: { courseId: next.courseId || '', title: next.title || '', url: target.toString() } };
}
