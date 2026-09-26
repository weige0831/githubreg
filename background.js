// GitHub 自动注册 - 后台服务（Service Worker）
// 职责：临时邮箱 API、随机账户、验证码轮询、账户保存、消息中转、管理器导入、Clash 换节点

// Clash 节点切换逻辑单独一个文件（同作用域，直接用里面的函数）
importScripts("clash.js");


// 临时邮箱服务（邮局地址 + 收信域名）：不写默认值，在面板「📧 临时邮箱」里填一次并保存，
// 存在扩展本地存储里。公开仓库里不放自己的服务地址。
const MAIL_DEFAULT = { apiUrl: "", domain: "" };
const HOME_URL = "https://github.com/";
const ICON_URL = chrome.runtime.getURL("icons/icon128.png");

// 统一去掉末尾斜杠，避免拼出 //api 这种地址
const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "");

async function getMailConfig() {
  const { mailConfig } = await chrome.storage.local.get("mailConfig");
  return { ...MAIL_DEFAULT, ...(mailConfig || {}) };
}

const ADJ = [
  "cool", "fast", "blue", "red", "neo", "sky", "dev", "byte", "code", "pixel",
  "silver", "golden", "crimson", "cosmic", "lunar", "solar", "stormy",
  "winter", "oceanic", "mystic", "quantum", "rapid", "hyper", "mega", "ultra",
];
const NOUN = [
  "fox", "wolf", "cat", "owl", "bear", "hawk", "lion", "frog", "deer", "crab",
  "falcon", "tiger", "panda", "dragon", "phoenix", "panther", "eagle", "shark",
  "otter", "raven", "koala", "badger", "penguin", "jaguar",
];

// GitHub launch code 邮件正文里的 confirm 链接格式：
//   https://github.com/account_verifications/confirm/{36位uuid}/{8位验证码}
const LAUNCH_CODE_RE = /account_verifications\/confirm\/[\w-]{36}\/(\d{8})(?=\D|$)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// GitHub 要求密码 >=15 位，或 >=8 位含数字+小写。给足 16 位混合最稳。
function randPassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 14; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return "Gh1!" + s;
}

// 用户名：字母数字+连字符，<=39 位，不能以连字符开头/结尾
function randUsername() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return a + n + Math.floor(100000 + Math.random() * 900000);
}

// 转发日志给 popup（popup 关着时静默失败）
function notify(text) {
  chrome.runtime.sendMessage({ type: "log", text }).catch(() => {});
}

// ===== 侧边栏常驻面板 =====

// 点击扩展图标直接打开侧边栏面板（常驻，不随点击消失）
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} catch (e) {
  // 旧浏览器不支持则忽略
}

// 在指定标签页上打开侧边栏面板（start 时自动呼出）
async function openPanel(tabId) {
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (e) {
    // 无用户手势时可能失败，用户可手动点图标打开面板
  }
}

// ===== 成功提示音（MV3 需用 offscreen 文档播放音频）+ 系统通知 =====

let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYING"],
      justification: "注册成功播放提示音",
    });
  } catch (e) {
    // 已存在则忽略
  }
  offscreenReady = true;
}

async function playSuccess() {
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: "play_success" }).catch(() => {});
    chrome.notifications.create({
      type: "basic",
      iconUrl: ICON_URL,
      title: "🎉 GitHub 注册成功",
      message: "账户已保存，可在管理页面查看或导出",
    });
  } catch (e) {
    // 忽略
  }
}

// ===== 临时邮箱 API =====

// 统一的 fetch 包装：网络层失败时，先判断是不是「扩展没被授权访问这个地址」。
// 这种情况 Chrome 直接把请求拦掉，报错只有一句 Failed to fetch，很难看出原因。
// 带超时的 fetch。Chrome 的 fetch **默认没有超时**：节点坏了、代理吞包的时候，
// 连接会被"黑洞"挂住，流程一个字都不打就停在那儿（本地实测：当前节点能连 GitHub、
// 连不上邮局 → 邮局请求 12 秒还没响应，日志停在"已关闭 N 个标签页"之后再无输出）。
// 加超时之后，这类挂住会变成明确的报错，交给上层已有的"重试 / 换节点"逻辑处理。
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) {
      const err = new Error(`超时（${Math.round(timeoutMs / 1000)} 秒没响应，多半是当前节点连不通它）`);
      err.timedOut = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithPermitHint(url, options, what = "", timeoutMs = 15000) {
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } catch (e) {
    let permitted = true;
    try {
      permitted = await originPermitted(url);
    } catch (e2) {}
    if (!permitted) {
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch (e3) {}
      throw new Error(
        `没被授权访问 ${host}（Chrome 直接拦掉了请求）：去面板对应区块点一下「保存」，弹窗里点「允许」`
      );
    }
    throw new Error(`${what}连不上：${String((e && e.message) || e)}`);
  }
}

async function createTempEmail() {
  const { apiUrl, domain } = await getMailConfig();
  if (!trimUrl(apiUrl) || !domain) {
    throw new Error("未配置邮局地址/邮箱域名（面板 → 📧 临时邮箱里填一次并保存）");
  }
  const resp = await fetchWithPermitHint(
    `${trimUrl(apiUrl)}/api/v1/addresses`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "gh_" + randomHex(4), domain }),
    },
    "邮局 "
  );
  if (!resp.ok) throw new Error("创建邮箱失败 HTTP " + resp.status);
  return resp.json(); // { email, token }
}

function extractCode(text) {
  const m = LAUNCH_CODE_RE.exec(text || "");
  return m ? m[1] : null;
}

// 拉邮件详情，从 confirm 链接末尾提取 8 位码
async function fetchDetail(apiUrl, token, id) {
  try {
    const resp = await fetchWithTimeout(`${trimUrl(apiUrl)}/api/v1/${token}/emails/${id}`, {}, 10000);
    if (!resp.ok) return null;
    const detail = await resp.json();
    for (const f of ["body", "body_html", "html", "content", "text"]) {
      if (typeof detail[f] === "string") {
        const c = extractCode(detail[f]);
        if (c) return c;
      }
    }
    return extractCode(JSON.stringify(detail));
  } catch (e) {
    return null;
  }
}

// 轮询收件箱找 GitHub 的 launch code，命中则按 id 拉详情提取验证码
async function pollForCode(token, timeoutMs = 150000) {
  const { apiUrl } = await getMailConfig();
  if (!trimUrl(apiUrl)) {
    notify("⚠️ 未配置邮局地址，无法收验证码（面板 → 📧 临时邮箱）");
    return null;
  }
  if (!(await originPermitted(apiUrl))) {
    // 没授权的话轮询会一直失败，早点说清楚
    notify("⚠️ 没被授权访问邮局地址（Chrome 拦了请求）：面板 → 📧 临时邮箱 → 点「保存」→ 弹窗点「允许」");
    return null;
  }
  const start = Date.now();
  const seen = new Set();
  const tried = new Set();
  let fetchFails = 0;
  let switched = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetchWithTimeout(`${trimUrl(apiUrl)}/api/v1/${token}/emails`, {}, 8000);
      if (!resp.ok) {
        // 连不上（或服务端报错）：累计几次就换节点再继续收
        fetchFails += 1;
        if (fetchFails >= 3 && !switched) {
          switched = true;
          notify(`⚠️ 邮局连续 ${fetchFails} 次连不上：换个节点再继续收验证码`);
          await switchNodeForRetry("邮局连不上，换节点重试");
        }
      }
      if (resp.ok) {
        fetchFails = 0;
        const data = await resp.json();
        for (const mail of data.emails || []) {
          const id = mail.id;
          const subject = mail.subject || "";
          const from = ((mail.from_address || mail.from || "") + " " + subject).toLowerCase();
          if (!id || (!from.includes("github") && !subject.toLowerCase().includes("launch code"))) {
            continue;
          }
          if (!seen.has(id)) {
            seen.add(id);
            notify(`收到邮件: ${subject.slice(0, 80)}`);
          }
          if (tried.has(id)) continue;
          tried.add(id);
          const code = await fetchDetail(apiUrl, token, id);
          if (code) return code;
        }
      }
    } catch (e) {
      // 网络抖动：继续轮询，但累计够几次就换节点（换完继续收）
      fetchFails += 1;
      if (fetchFails >= 3 && !switched) {
        switched = true;
        notify(`⚠️ 邮局连续 ${fetchFails} 次连不上：换个节点再继续收验证码`);
        await switchNodeForRetry("邮局连不上，换节点重试");
      }
    }
    await sleep(3000);
  }
  return null;
}

// ===== 账户保存与管理 =====

async function getAccounts() {
  const { accounts = [] } = await chrome.storage.local.get("accounts");
  return accounts;
}

async function saveAccount(account) {
  const accounts = await getAccounts();
  accounts.push({ ...account, time: new Date().toISOString() });
  await chrome.storage.local.set({ accounts });
  notify(`账户已保存，共 ${accounts.length} 个`);
}

async function deleteAccount(index) {
  const accounts = await getAccounts();
  if (index >= 0 && index < accounts.length) {
    accounts.splice(index, 1);
    await chrome.storage.local.set({ accounts });
    notify(`已删除第 ${index + 1} 个账户`);
  }
}

async function clearAccounts() {
  await chrome.storage.local.set({ accounts: [] });
  notify("已清空全部账户");
}

// ===== 批量连续注册队列 =====

async function getQueue() {
  const { queue } = await chrome.storage.session.get("queue");
  return queue || null;
}
async function setQueue(q) {
  await chrome.storage.session.set({ queue: q });
}

// ===== 页面心跳 + 看门狗 =====
// 为什么需要它：在 Windows 上关掉远程桌面（RDP）后，Chrome 会把窗口判定成"被遮挡/不可见"，
// 于是把页面里的定时器节流甚至冻结（界面被断开时尤其明显），表现就是"我一关远程桌面它就卡住不动了"。
// 页面自己的看门狗（content.js 里的 watchStuck）也活在被冻结的定时器上，一样不动；
// 而后台的 chrome.alarms **不受这个影响**，所以在后台盯心跳，超时就重开页面。
const WATCHDOG_ALARM = "ghreg-page-watchdog";
const PAGE_IDLE_LIMIT_MS = 3 * 60 * 1000; // 页面 3 分钟一点动静都没有 = 冻住了
const PAGE_JOLT_MS = 60 * 1000; // 60 秒没动静就先温和地拉一把（不重开）

let busyStarting = false; // 正在开新号（还没建好页面标签页）
let lastBeatAt = 0;
let lastGapLogAt = 0;
let lastJoltLogAt = 0;

// 页面每次说话 / 每 15 秒报一次心跳都走这里。
// 心跳变稀 = 页面被判定隐藏、定时器被降频（还在跑）；心跳完全不来 = 被冻结。
// 让标签页不被浏览器当"不活跃标签"回收/冻结掉（那会让页面脚本整个消失，表现就是"卡住不动了"）。
// 注意：autoDiscardable 只有 tabs.update 收，tabs.create 传这个参数会**直接抛错**
// （报 Unexpected property: 'autoDiscardable'），所以必须在创建之后单独设一次。
async function keepTabAlive(tabId) {
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (e) {}
}

async function markPageBeat(hidden) {
  const now = Date.now();
  const gap = lastBeatAt ? now - lastBeatAt : 0;
  lastBeatAt = now;
  try {
    await chrome.storage.session.set({ lastPageBeat: now });
  } catch (e) {}
  if (gap > 30000 && gap < PAGE_IDLE_LIMIT_MS && now - lastGapLogAt > 60000) {
    lastGapLogAt = now;
    notify(`⏱️ 页面心跳间隔变成 ${Math.round(gap / 1000)} 秒${hidden ? "，而且页面自报「不可见」" : ""}：被系统/浏览器降频了，但还在跑`);
  }
}

function startWatchdogAlarm() {
  try {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  } catch (e) {}
}

function stopWatchdogAlarm() {
  try {
    chrome.alarms.clear(WATCHDOG_ALARM);
  } catch (e) {}
}

// 定时看页面是不是还活着。分两级：
//   ① 60 秒没动静 → 温和地拉一把（激活标签页 + 叫它一声），**不导航、不丢进度**；
//      标签页不是活动标签而被冻结时，这一步通常就够了。
//   ② 3 分钟没动静 → 真的被冻结了，只能重新打开页面（按 stage 接着跑）。
async function onWatchdogTick() {
  const queue = await getQueue();
  if (!queue) {
    stopWatchdogAlarm(); // 没有批量在跑就不用管了
    return { ok: true, action: "无批量在跑" };
  }
  if (busyStarting) return { ok: true, action: "正在开新号（页面还没建起来），不动手" };
  const { lastPageBeat = 0 } = await chrome.storage.session.get("lastPageBeat");
  if (!lastPageBeat) return { ok: true, action: "还没有心跳" };
  const idle = Date.now() - lastPageBeat;

  if (idle >= PAGE_JOLT_MS) {
    const { task } = await chrome.storage.session.get("task");
    if (task && task.tabId) {
      try {
        await chrome.tabs.update(task.tabId, { active: true });
        await chrome.tabs.sendMessage(task.tabId, { type: "wake" }).catch(() => {});
      } catch (e) {}
    }
  }

  if (idle < PAGE_IDLE_LIMIT_MS) {
    if (idle >= PAGE_JOLT_MS && Date.now() - lastJoltLogAt > 120000) {
      lastJoltLogAt = Date.now();
      notify(`⏱️ 页面 ${Math.round(idle / 1000)} 秒没动静：拉了一下标签页（不重开，等它自己缓过来）`);
    }
    return { ok: true, action: idle >= PAGE_JOLT_MS ? "唤醒页面" : "页面有动静", idleMs: idle };
  }

  const mins = Math.round(idle / 60000);
  notify(`⏱️ 页面已经 ${mins} 分钟没有任何动静（多半是被系统/浏览器冻结了）：重新打开页面接着跑`);
  await markPageBeat(); // 先记一次心跳，免得看门狗连环重开
  await reloadTaskTab("看门狗：页面长时间没反应");
  return { ok: true, action: `重开页面（静默 ${mins} 分钟）`, idleMs: idle };
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  await onWatchdogTick();
});

// 开一个注册流程（新邮箱 + 新账户 + 打开首页）
// extra 会并进新任务里（比如换邮箱重试要带着 recoverAttempts，否则重试次数会被清零）
async function startOne(extra = {}) {
  busyStarting = true; // 这期间页面还没建起来，看门狗别抢着开标签页
  // 批量衔接：先关掉上一个任务的标签页，避免越开越多
  try {
    const prev = (await chrome.storage.session.get("task")).task;
    if (prev && prev.tabId) await chrome.tabs.remove(prev.tabId);
  } catch (e) {
    // 标签页可能已被用户手动关掉，忽略
  }
  const { email, token } = await createTempEmail();
  const password = randPassword();
  const username = randUsername();
  const tab = await chrome.tabs.create({ url: HOME_URL, active: true });
  // autoDiscardable 只能通过 tabs.update 改（tabs.create 不收这个参数，传了会直接抛错）
  await keepTabAlive(tab.id);
  await chrome.storage.session.set({
    task: { stage: "start", email, password, username, token, tabId: tab.id, ...extra },
  });
  await markPageBeat(); // 新页面刚开，心跳重置
  notify(`📧 临时邮箱: ${email}`);
  // 尽量自动呼出常驻侧边栏面板（不 await，避免拖慢批量衔接）
  openPanel(tab.id).catch(() => {});
  busyStarting = false;
  return { email, password, username, token, tabId: tab.id };
}


// 邮局 / 管理器连不上时换节点再试（它们也经 Clash 转发，节点坏了同样连不上）。
// 只在「Clash 自动切换」开着时动作，关着就静默跳过，免得刷一堆没用的日志。
async function switchNodeForRetry(reason) {
  const cfg = await getClashConfig();
  if (!cfg.enabled) return null;
  const r = await clashSwitch(reason, { rotate: true, blacklist: true });
  if (!r || !r.ok) notify(`（换节点没成功：${(r && r.error) || "未知原因"}，继续重试）`);
  return r;
}

// 开一个新号：邮局/网络抖动时**一直重试**（不设次数上限），等待时间逐步拉长到最多 60 秒。
// 每失败 3 次顺手换个节点（邮局也是走代理访问的，节点坏了同样会连不上）。
// 用户点「停止」时立刻中断。
async function startOneWithRetry(extra = {}) {
  let fails = 0;
  for (;;) {
    const { task } = await chrome.storage.session.get("task");
    if (task && task.stopped) throw new Error("已停止（用户点了停止）");
    try {
      return await startOne(extra);
    } catch (e) {
      fails += 1;
      notify(`⚠️ 开新号失败（第 ${fails} 次）：${String((e && e.message) || e)} —— 30 秒内自动重试，不会中断`);
      // 超时基本可以断定是当前节点连不通它（不是服务端抖动），直接换节点，不必等满 3 次
      if ((e && e.timedOut) || fails % 3 === 0) {
        // 连不上很可能是当前节点的问题（邮局也要经代理），换一个再试
        const sw = await clashSwitch("开新号连续失败，换节点重试", { rotate: true, blacklist: true }).catch(() => null);
        if (sw && sw.ok) notify(`已换节点：${sw.from || "?"} → ${sw.to || "?"}，继续重试`);
        else notify("换节点没成功（可能没启用或没可换的），继续重试");
      }
      const waitMs = Math.min(60, 5 * Math.min(fails, 12)) * 1000;
      notify(`等 ${waitMs / 1000} 秒后重试...`);
      await sleep(waitMs);
    }
  }
}

// ===== 账户间清理：删 GitHub cookie + 留一个标签页 =====

// 一次最多连续注册多少个（面板/弹窗的输入框上限也用它，别只改一边）
const MAX_BATCH = 999;

// 清理环境：删掉 GitHub 的 cookie/本地存储 + 只留一个标签页。
// 批次开始前和每两个账户之间都要清一遍——上一批留下的登录态会让第一个号卡在首页。
// openGithub=false 时不额外把保留的标签页跳到 github.com（紧接着就要开新标签页时没必要）。
async function cleanupBeforeNext({ openGithub = true } = {}) {
  // 1) 只清 GitHub 的 cookie 和本地存储，不影响其它网站登录态
  try {
    await chrome.browsingData.remove(
      { origins: ["https://github.com"] },
      { cookies: true, localStorage: true }
    );
    notify("已清除 GitHub cookie");
  } catch (e) {
    notify("清除 cookie 失败: " + String(e));
  }

  // 2) 只留当前窗口一个标签页，其余全部关掉
  //    （只处理 currentWindow，其它窗口不碰，避免整个浏览器被关）
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (tabs.length === 0) return;
    const kept = tabs[0];
    const toClose = tabs.slice(1).map((t) => t.id).filter((id) => id != null);
    if (toClose.length) await chrome.tabs.remove(toClose);
    notify(`已关闭 ${toClose.length} 个标签页，保留 1 个`);

    // 3) 保留的标签页跳 github.com（cookie 已清 = 未登录），等于刷新
    if (openGithub) {
      try {
        await chrome.tabs.update(kept.id, { url: "https://github.com/" });
        notify("保留标签页已跳转 github.com（未登录状态）");
      } catch (e) {
        notify("保留标签页跳转失败: " + String(e));
      }
    }
  } catch (e) {
    notify("关闭标签页失败: " + String(e));
  }
}

// 一个注册完成：保存 + 清理 + 开下一个（提示音不阻塞）
async function onRegistrationDone(account, { save = true } = {}) {
  // 先把之前失败的补导入（保证备注顺序与注册顺序一致），再导入本次账户；
  // 导入过程出任何问题都不能影响账户保存
  let gam = {};
  if (save) {
    try {
      await flushPendingImports();
      gam = await importWithRetry(account);
    } catch (e) {
      notify("导入管理器异常: " + String(e.message || e));
    }

    // 关了「保存到本地」时：只有确实进了管理器的账户才不留副本，
    // 没进管理器（没 token / 导入失败 / 配置没填）的一律本地留一份，避免直接丢号
    const cfg = await getGamConfig();
    if (!cfg.saveLocal && gam.ok) {
      notify("（已导入管理器，按设置不在本地留副本）");
    } else {
      await saveAccount({ ...account, gamGroup: gam.group || "", gamNote: gam.note || "" });
      if (!cfg.saveLocal) notify("⚠️ 这次没进管理器，已在本地保留副本（防丢号）");
    }
  } else {
    notify("🗑️ 这个号按要求丢弃（不写账户列表、不进管理器）");
  }

  const queue = await getQueue();
  if (queue && queue.left > 0) {
    queue.left -= 1;
    await setQueue(queue);
    const done = queue.total - queue.left;
    notify(`✅ 第 ${done}/${queue.total} 个注册完成，清理环境后继续下一个...`);
    try {
      await cleanupBeforeNext(); // 删 GitHub cookie + 留一个标签页
      await clashHealthCheck("开下一个号之前"); // 节点太慢/不通就先换，免得新号也跑不动
      notify("等待 10 秒后开始下一个账户...");
      await sleep(10000);
      await startOneWithRetry(); // 先开下一个，缩短间隔（抖动会自动重试）
    } catch (e) {
      notify("批量注册中断: " + String(e));
    }
    playSuccess(); // 提示音放最后，不阻塞
  } else if (queue) {
    notify(`🎉 批量注册完成：共 ${queue.total} 个`);
    await setQueue(null);
    stopClashAlarm();
    stopWatchdogAlarm();
    playSuccess();
  }
}

// ===== 管理器导入（自建账户管理器，接口见 README）=====
// 注册成功的 token 自动导入管理器：
//   每 groupSize（默认 10）个号一组，分组名 = 日期 + 6 位随机字符（当日不重复），
//   组内备注依次是「分组名-0 … 分组名-9」

// 默认留空：地址/管理密码在面板「📥 导入管理器」里填一次即可（存在扩展本地存储里）。
// 不要把地址和密码写进代码——这个仓库是公开的。
const GAM_DEFAULT = {
  enabled: true,
  baseUrl: "",
  masterPassword: "",
  apiKey: "", // 填了就用 X-API-Key，不再需要管理密码
  groupSize: 10,
  saveLocal: true, // 关掉 = 只导入管理器，本地不留明文副本（导入失败时仍会本地保留，防丢号）
};
// 去掉易混字符（l/o/0/1），避免手抄分组名时看错
const GROUP_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

async function getGamConfig() {
  const { gamConfig } = await chrome.storage.local.get("gamConfig");
  return { ...GAM_DEFAULT, ...(gamConfig || {}) };
}

async function getGamState() {
  const { gamState } = await chrome.storage.local.get("gamState");
  return { group: "", index: 0, ...(gamState || {}) };
}

// JWT 只在内存缓存（有效期 7 天，留一天余量），SW 重启后自动重新登录
let gamAuth = { jwt: "", exp: 0 };

async function gamLogin(cfg) {
  if (!trimUrl(cfg.baseUrl)) throw new Error("未配置管理器地址（面板 → 📥 导入管理器）");
  const resp = await fetchWithPermitHint(`${trimUrl(cfg.baseUrl)}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ masterPassword: cfg.masterPassword }),
  });
  const body = await resp.json().catch(() => null);
  const jwt = body && body.data && body.data.token;
  if (!resp.ok || !jwt) {
    throw new Error(`管理器登录失败：${(body && body.message) || "HTTP " + resp.status}`);
  }
  gamAuth = { jwt, exp: Date.now() + 6 * 24 * 3600 * 1000 };
  return jwt;
}

// 带自动重登的请求；成功返回 data 字段，失败抛后端 message
// 配了 API Key 就直接用 X-API-Key（长期有效，不用存管理密码）
async function gamRequest(path, { method = "GET", body } = {}) {
  const cfg = await getGamConfig();
  const base = trimUrl(cfg.baseUrl);
  if (!base) throw new Error("未配置管理器地址（面板 → 📥 导入管理器）");
  const url = base + "/api" + path;
  const send = (jwt) =>
    fetchWithPermitHint(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey
          ? { "X-API-Key": cfg.apiKey }
          : jwt
            ? { Authorization: `Bearer ${jwt}` }
            : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let jwt = "";
  if (!cfg.apiKey) {
    jwt = gamAuth.exp > Date.now() ? gamAuth.jwt : await gamLogin(cfg);
  }
  let resp = await send(jwt);
  if (resp.status === 401 && !cfg.apiKey) {
    // JWT 过期或密码被改：重新登录一次
    gamAuth = { jwt: "", exp: 0 };
    jwt = await gamLogin(cfg);
    resp = await send(jwt);
  }
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error((json && (json.message || json.error)) || `HTTP ${resp.status}`);
  }
  return json ? json.data : null;
}

// 用管理密码换一个长期 API Key（管理器里叫「新建 API Key」）
async function gamCreateApiKey(cfg, name = "github-auto-reg") {
  const jwt = await gamLogin(cfg);
  const resp = await fetchWithTimeout(`${trimUrl(cfg.baseUrl)}/api/apikeys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name, expires_in_days: 0 }), // 0 = 永久
  });
  const json = await resp.json().catch(() => null);
  const key = json && json.data && json.data.key;
  if (!resp.ok || !key) {
    throw new Error((json && (json.message || json.error)) || `创建 API Key 失败 HTTP ${resp.status}`);
  }
  const { gamConfig } = await chrome.storage.local.get("gamConfig");
  await chrome.storage.local.set({ gamConfig: { ...(gamConfig || {}), apiKey: key } });
  return key;
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function randChars(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => GROUP_ALPHABET[b % GROUP_ALPHABET.length])
    .join("");
}

// 分组名 = 日期 + 随机字符；当日不重复：本地记录 +（管理器已有分组）双重校验
async function makeGroupName() {
  const today = dateStamp();
  const { gamUsedNames } = await chrome.storage.local.get("gamUsedNames");
  const localNames = gamUsedNames && gamUsedNames.date === today ? gamUsedNames.names || [] : [];
  const used = new Set(localNames);
  try {
    const groups = await gamRequest("/accounts/groups");
    for (const g of Array.isArray(groups) ? groups : []) used.add(g);
  } catch (e) {
    // 拿不到已有分组也不阻塞：本地记录已能保证当日不重复
  }
  for (let i = 0; i < 20; i++) {
    const name = today + randChars(6);
    if (used.has(name)) continue;
    await chrome.storage.local.set({ gamUsedNames: { date: today, names: [...localNames, name] } });
    return name;
  }
  throw new Error("生成分组名失败：连续 20 次都撞名");
}

// 累计已导入数：单独记，不依赖本地账户列表
// （关了「保存到本地」或手动清空列表后，面板上的进度仍然是对的）
async function bumpImportedCount(delta = 1) {
  const state = await getGamState();
  if (state.importedCount == null) {
    const accounts = await getAccounts();
    state.importedCount = accounts.filter((a) => a.gamNote).length; // 首次以本地记录为基数
  }
  state.importedCount += delta;
  await chrome.storage.local.set({ gamState: state });
  return state.importedCount;
}

// 导入一个账户；失败抛异常，由调用方决定重试/入队
async function importAccountToManager(account) {
  // 不在这里卡 token：管理器服务端自己会校验（空 token 会被它拒），
  // 客户端不重复服务端的规则——哪天服务端允许空 token，这里不用改也能用。
  if (!account) throw new Error("没有账户数据");
  const cfg = await getGamConfig();
  const state = await getGamState();
  if (!state.group || state.index >= cfg.groupSize) {
    state.group = await makeGroupName();
    state.index = 0;
    await chrome.storage.local.set({ gamState: state });
    notify(`🆕 管理器新建分组「${state.group}」（每 ${cfg.groupSize} 个一组）`);
  }
  const note = `${state.group}-${state.index}`;
  const created = await gamRequest("/accounts/import", {
    method: "POST",
    body: {
      token: account.token,
      password: account.password || "",
      recovery_email: account.email || "",
      note,
      group: state.group,
    },
  });
  // 只有真正导入成功才推进编号，失败重试时复用同一个备注，保证组内 0~9 不留空
  state.index += 1;
  await chrome.storage.local.set({ gamState: state });
  await bumpImportedCount(1);
  notify(
    `📥 已导入管理器：${(created && created.github_login) || account.username || "账户"}` +
      `（分组 ${state.group}，备注 ${note}）`
  );
  return { ok: true, group: state.group, note, id: created && created.id };
}

// 把导入结果写回本地账户记录（补导入的账户也能对上台账）
async function updateAccountGamInfo(email, info) {
  if (!email) return;
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.email === email);
  if (!acc) return;
  acc.gamGroup = info.group;
  acc.gamNote = info.note;
  await chrome.storage.local.set({ accounts });
}

// 永久性错误：重试和排队都没意义，直接跳过（重复账户、空 token、鉴权失败）。
// 注意「token 验证失败」不在此列 —— 管理器要拿 token 回查 GitHub，它自己网络/限流出问题时
// 就会报这个，此时排队等下次补导入才是对的。
const GAM_FATAL = /已存在|重复|duplicate|exists|不能为空|无效|invalid|unauthorized/i;

// 导入 + 重试 3 次；仍失败则进待重试队列（不阻塞后续注册）
async function importWithRetry(account) {
  const cfg = await getGamConfig();
  if (!cfg.enabled) return { ok: false, skipped: "已关闭" };
  if (!trimUrl(cfg.baseUrl)) {
    notify("⚠️ 未配置管理器地址，跳过导入（面板 → 📥 导入管理器里填一次并保存）");
    return { ok: false, skipped: "未配置地址" };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await importAccountToManager(account);
    } catch (e) {
      const msg = String(e.message || e);
      if (GAM_FATAL.test(msg)) {
        notify(`⏭️ 跳过导入管理器：${msg}`);
        return { ok: false, skipped: msg };
      }
      notify(`⚠️ 导入管理器失败（${attempt}/3）：${msg}`);
      if (attempt < 3) await sleep(attempt * 3000);
    }
  }
  // 3 次都失败：先换个节点再试一次（"连不上服务器"多半是节点问题），还不行才入队
  notify("⚠️ 导入管理器连续失败：换个节点再试一次");
  await switchNodeForRetry("管理器连不上，换节点重试");
  try {
    return await importAccountToManager(account);
  } catch (e) {
    const msg = String(e.message || e);
    if (GAM_FATAL.test(msg)) {
      notify(`⏭️ 跳过导入管理器：${msg}`);
      return { ok: false, skipped: msg };
    }
    notify(`❌ 换节点后仍未成功：${msg}`);
  }

  const { gamPending = [] } = await chrome.storage.local.get("gamPending");
  gamPending.push({ ...account, failedAt: new Date().toISOString() });
  await chrome.storage.local.set({ gamPending });
  notify(`❌ 导入失败，已加入待重试队列（共 ${gamPending.length} 个）`);
  return { ok: false, pending: true };
}

// 补导入之前失败的账户；管理器已有或已永久失败的跳过，其余留在队列里
async function flushPendingImports(limit = 5) {
  const { gamPending = [] } = await chrome.storage.local.get("gamPending");
  if (!gamPending.length) return { done: 0, left: 0 };
  const cfg = await getGamConfig();
  if (!cfg.enabled) return { done: 0, left: gamPending.length };

  const rest = [];
  let done = 0;
  let switchedForFlush = false;
  for (const acc of gamPending.slice(0, limit)) {
    try {
      const r = await importAccountToManager(acc);
      done++;
      await updateAccountGamInfo(acc.email, r);
    } catch (e) {
      const msg = String(e.message || e);
      if (GAM_FATAL.test(msg)) {
        notify(`待重试账户跳过（${msg}）：${acc.username || acc.email}`);
      } else {
        rest.push(acc);
        if (!switchedForFlush) {
          switchedForFlush = true;
          notify("⚠️ 补导入连不上管理器：换个节点再继续");
          await switchNodeForRetry("补导入连不上管理器");
        }
      }
    }
  }
  rest.push(...gamPending.slice(limit));
  await chrome.storage.local.set({ gamPending: rest });
  if (done) notify(`🔁 已补导入 ${done} 个账户（剩余待重试 ${rest.length} 个）`);
  return { done, left: rest.length };
}

async function gamStatus() {
  const cfg = await getGamConfig();
  const state = await getGamState();
  const accounts = await getAccounts();
  const { gamPending = [] } = await chrome.storage.local.get("gamPending");
  const full = !state.group || state.index >= cfg.groupSize;
  const imported =
    state.importedCount == null ? accounts.filter((a) => a.gamNote).length : state.importedCount;
  return {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    masterPassword: cfg.masterPassword,
    apiKey: cfg.apiKey,
    authMode: cfg.apiKey ? "API Key" : "管理密码",
    groupSize: cfg.groupSize,
    saveLocal: cfg.saveLocal !== false,
    permitted: cfg.baseUrl ? await originPermitted(cfg.baseUrl) : true,
    localCount: accounts.length,
    group: state.group,
    index: state.index,
    nextNote: full ? "（下一个账户时新建分组）" : `${state.group}-${state.index}`,
    pending: gamPending.length,
    imported,
  };
}

async function mailStatus() {
  const cfg = await getMailConfig();
  return {
    apiUrl: cfg.apiUrl,
    domain: cfg.domain,
    permitted: cfg.apiUrl ? await originPermitted(cfg.apiUrl) : true,
  };
}

// ===== 启动自检：自定义地址有没有拿到授权 =====
// （扩展只能预授权 github.com；管理器/邮局/Clash 的地址是用户填的，没授权时请求会被 Chrome 拦掉）
async function checkHostPermissions() {
  try {
    const [gam, mail, clash] = await Promise.all([getGamConfig(), getMailConfig(), getClashConfig()]);
    const targets = [
      ["管理器", gam.baseUrl],
      ["邮局", mail.apiUrl],
      ["Clash 控制器", clash.baseUrl],
    ];
    const missing = [];
    for (const [name, url] of targets) {
      if (!trimUrl(url)) continue;
      if (await originPermitted(url)) continue;
      let origin = url;
      try {
        origin = new URL(url).origin;
      } catch (e) {}
      missing.push(`${name}（${origin}）`);
    }
    if (missing.length) {
      notify(
        "⚠️ 这些地址还没授权，请求会被浏览器直接拦掉：" +
          missing.join("、") +
          " —— 去面板对应区块点「保存」，弹窗里点「允许」"
      );
    }
  } catch (e) {
    // 自检失败不影响使用
  }
}

chrome.runtime.onStartup.addListener(checkHostPermissions);
chrome.runtime.onInstalled.addListener(checkHostPermissions);

// ===== 消息处理 =====

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "start": {
        try {
          const count = Math.max(1, Math.min(MAX_BATCH, parseInt(msg.count, 10) || 1));
          // 上次如果点过「停止」，这里要先把这个标记清掉，否则重写开始会被它挡住
          const { task: prevTask } = await chrome.storage.session.get("task");
          if (prevTask && prevTask.stopped) {
            await chrome.storage.session.set({ task: { ...prevTask, stopped: false } });
            notify("▶️ 重新开始（已清除上次的停止标记）");
          }
          await setQueue({ total: count, left: count - 1 });
          // 开跑前先清一遍环境：上一批（或上次浏览）留下的 GitHub 登录态会让第一个号卡在首页
          notify("🧹 先清理环境：清除 GitHub 登录态 + 关掉多余标签页...");
          await cleanupBeforeNext({ openGithub: false });
          await clashHealthCheck("开跑之前");
          await clashHealthCheck("开跑之前"); // 节点不行就先换掉再开始
          startClashAlarm(); // 批量期间每分钟检查一次节点速度
          startWatchdogAlarm(); // 批量期间每分钟看一眼页面冻没冻住
          await sleep(1000);
          const info = await startOneWithRetry();
          notify(count > 1 ? `开始批量注册：共 ${count} 个` : "开始注册");
          sendResponse({ ok: true, ...info, count });
        } catch (e) {
          notify("启动失败: " + String(e));
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      case "new_account": {
        // 邮箱不可用（已被注册且不是我们的号）时换一个邮箱重开，
        // 队列位置不变（不消耗 batch 计数），所以这次重试不占用一个名额
        try {
          notify("🔄 换新邮箱重新开一个注册任务...");
          await cleanupBeforeNext({ openGithub: false });
          const info = await startOneWithRetry({ recoverAttempts: msg.attempts || 0 });
          sendResponse({ ok: true, ...info });
        } catch (e) {
          notify("换邮箱重开失败: " + String(e));
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      case "request_code": {
        const code = await pollForCode(msg.token, msg.timeoutMs || 150000);
        sendResponse({ code });
        break;
      }
      case "done": {
        await onRegistrationDone(msg.account, { save: msg.save !== false });
        sendResponse({ ok: true });
        break;
      }
      case "log": {
        notify(msg.text);
        sendResponse({ ok: true });
        break;
      }
      case "content_log": {
        // content 脚本日志：只由后台转发为 log，面板只显示这一份
        await markPageBeat(); // 页面在说话 = 它还活着（看门狗靠这个判断冻没冻住）
        notify(msg.text);
        sendResponse({ ok: true });
        break;
      }
      case "page_beat": {
        // 页面的定时器心跳（content.js 每 15 秒报一次，不产生日志）
        await markPageBeat(msg.hidden);
        sendResponse({ ok: true });
        break;
      }
      case "get_accounts": {
        sendResponse({ accounts: await getAccounts() });
        break;
      }
      case "delete_account": {
        await deleteAccount(msg.index);
        sendResponse({ ok: true });
        break;
      }
      case "clear_accounts": {
        await clearAccounts();
        sendResponse({ ok: true });
        break;
      }
      case "stop": {
        // 中途停止：清掉批量队列（不会再开下一个号），并给当前任务打标记，
        // 页面脚本的自动重试循环看到标记就停手。再点「开始注册」即重新开始（新任务不带这个标记）
        try {
          await setQueue(null);
          const { task } = await chrome.storage.session.get("task");
          if (task) await chrome.storage.session.set({ task: { ...task, stopped: true } });
          stopClashAlarm();
          stopWatchdogAlarm();
          notify("⏹ 已停止：不再开新号、自动重试也停下（点「开始注册」可重新开始）");
          sendResponse({ ok: true });
        } catch (e) {
          notify("停止失败: " + String(e));
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      case "get_queue": {
        sendResponse({ queue: await getQueue() });
        break;
      }
      case "get_task": {
        const { task } = await chrome.storage.session.get("task");
        sendResponse({ task: task || null });
        break;
      }
      case "gam_get_status": {
        sendResponse({ ok: true, status: await gamStatus() });
        break;
      }
      case "gam_set_config": {
        const { gamConfig } = await chrome.storage.local.get("gamConfig");
        await chrome.storage.local.set({
          gamConfig: { ...(gamConfig || {}), ...msg.config },
        });
        gamAuth = { jwt: "", exp: 0 }; // 地址/密码可能变了，下次请求重新登录
        sendResponse({ ok: true, status: await gamStatus() });
        break;
      }
      case "gam_retry_pending": {
        const r = await flushPendingImports(10);
        sendResponse({ ok: true, ...r, status: await gamStatus() });
        break;
      }
      case "gam_test": {
        try {
          const groups = await gamRequest("/accounts/groups");
          sendResponse({
            ok: true,
            groups: Array.isArray(groups) ? groups.length : 0,
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "gam_create_apikey": {
        try {
          const cfg = await getGamConfig();
          const key = await gamCreateApiKey(cfg, msg.name || "github-auto-reg");
          gamAuth = { jwt: "", exp: 0 };
          sendResponse({ ok: true, key, status: await gamStatus() });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "clash_get_status": {
        sendResponse({ ok: true, status: await clashStatus() });
        break;
      }
      case "clash_set_config": {
        const { clashConfig } = await chrome.storage.local.get("clashConfig");
        const patch = { ...(msg.config || {}) };
        const clearBlacklist = !!patch.clearBlacklist;
        delete patch.clearBlacklist;
        await chrome.storage.local.set({ clashConfig: { ...(clashConfig || {}), ...patch } });
        if (clearBlacklist) {
          await chrome.storage.local.set({ clashBlacklist: {} });
          notify("已清空节点黑名单");
        }
        sendResponse({ ok: true, status: await clashStatus() });
        break;
      }
      case "clash_test": {
        // 连一下控制器，报告当前节点与延迟；连不上/密钥不对就顺手探一遍常见地址
        let cfg = null;
        try {
          cfg = await getClashConfig();
          const group = await clashPickGroup(cfg);
          const info = await clashRequest(`/proxies/${encodeURIComponent(group)}`);
          const node = (info && info.now) || "";
          const delay = await clashDelay(node, cfg);
          sendResponse({
            ok: true,
            group,
            node,
            delay,
            total: ((info && info.all) || []).length,
          });
        } catch (e) {
          const error = String(e.message || e);
          const permitted = cfg ? await originPermitted(cfg.baseUrl) : true;
          let probe = null;
          // 没授权的话探测也全是失败，没必要浪费时间
          if (permitted) {
            try {
              probe = await clashProbe();
            } catch (e2) {}
          }
          sendResponse({ ok: false, error, permitted, probe });
        }
        break;
      }
      case "clash_import_config": {
        // 面板上让用户选 Clash 的配置文件（扩展本身不读磁盘），这里只负责解析出地址和密钥
        const info = parseClashConfig(msg.text || "");
        let error = "";
        if (info.controllerOff) {
          error =
            "这份配置里 external-controller 是空的——说明 Clash Verge 里「外部控制」开关没打开，" +
            "内核因此不会监听任何管理端口。去 Verge 设置里打开它，再重新导入。";
        } else if (!info.baseUrl) {
          error = "这份配置里没有 external-controller，可能不是 Clash 的运行时配置";
        }
        sendResponse({ ok: !!info.baseUrl, ...info, error });
        break;
      }
      case "clash_health": {
        // 手动触发一次节点健康检查（太慢/测不通就换，逻辑与定时检查一致）
        sendResponse({ ok: true, ...(await clashHealthCheck("手动检查")), status: await clashStatus() });
        break;
      }
      case "clash_switch": {
        // 手动换，或页面脚本检测到 GitHub 限流时触发（reload=true 表示换完刷新当前页面）
        const r = await clashSwitch(msg.reason || "手动切换", {
          blacklist: msg.blacklist !== false, // 默认拉黑；限流快速重试阶段会传 false
          rotate: !!msg.rotate, // true = 按顺序换下一个（绕限流用）
        });
        let reloaded = false;
        if (r.ok && msg.reload) reloaded = await reloadTaskTab("换节点后刷新重试");
        sendResponse({ ...r, reloaded, status: await clashStatus() });
        break;
      }
      case "clear_github_session": {
        // 清掉 GitHub 的 cookie + localStorage（只清 github.com，不动其它站点的登录态），
        // 用于遇到「访问暂时受限」时把会话重置干净、从头跑。
        // 顺带清 DataDome 的（GitHub 用它给 /signup 做滑块人机验证）：它会在浏览器里留一个
        // "这台设备可疑"的 cookie，不清掉的话换多少 IP 都还是弹验证。
        try {
          await chrome.browsingData.remove(
            {
              origins: [
                "https://github.com",
                "https://captcha-delivery.com",
                "https://geo.captcha-delivery.com",
              ],
            },
            { cookies: true, localStorage: true }
          );
          notify("🧹 已清空 GitHub cookie / localStorage（会话重置）");
          sendResponse({ ok: true });
        } catch (e) {
          notify("清空 GitHub 会话失败: " + String(e));
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      case "mail_get_status": {
        sendResponse({ ok: true, status: await mailStatus() });
        break;
      }
      case "mail_set_config": {
        const { mailConfig } = await chrome.storage.local.get("mailConfig");
        await chrome.storage.local.set({
          mailConfig: { ...(mailConfig || {}), ...msg.config },
        });
        sendResponse({ ok: true, status: await mailStatus() });
        break;
      }
      case "mail_test": {
        // 真的建一个临时邮箱来验证配置（注册时走的也是这个接口）
        try {
          const info = await createTempEmail();
          sendResponse({ ok: true, email: info.email });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      }
      case "set_task": {
        await chrome.storage.session.set({ task: msg.task });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // 异步响应
});
