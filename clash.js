// ===== Clash 节点自动切换 =====
// 走 Clash 的外部控制接口（external-controller）：
//   GET  /proxies                     列出所有代理与分组
//   GET  /proxies/{分组}               分组当前选中的节点 + 可选节点列表
//   PUT  /proxies/{分组}  {"name":x}   手动切换节点
//   GET  /proxies/{节点}/delay?timeout=&url=   测延迟
//
// 触发场景：
//   1) 页面出现 GitHub 限流（too many requests）→ 拉黑当前节点 + 换节点 + 刷新页面；
//   2) 当前节点测不通 / 延迟超过阈值 → 同样换掉（批量进行时每分钟检查一次）。
// 被换掉的节点会进黑名单（默认 25 分钟），期间不会再被选中。

const CLASH_DEFAULT = {
  enabled: false,
  baseUrl: "http://127.0.0.1:9090",
  secret: "",
  group: "", // 留空 = 自动挑一个 Selector 分组
  slowMs: 5000, // 延迟超过它就算「太慢」
  blacklistMinutes: 25,
  testUrl: "https://github.com/",
};

const CLASH_ALARM = "clash-health";

// 常见的外部控制地址：Clash Verge（Rev）默认 9097 且带随机密钥；
// Clash for Windows / Mihomo / 原版 Clash 常见 9090。连不上时挨个探一遍。
const CLASH_CANDIDATES = [
  "http://127.0.0.1:9090",
  "http://127.0.0.1:9097",
  "http://127.0.0.1:9091",
  "http://127.0.0.1:9098",
  "http://127.0.0.1:9099",
  "http://127.0.0.1:63443",
];

async function getClashConfig() {
  const { clashConfig } = await chrome.storage.local.get("clashConfig");
  return { ...CLASH_DEFAULT, ...(clashConfig || {}) };
}

async function clashRequest(path, { method = "GET", body } = {}) {
  const cfg = await getClashConfig();
  const base = trimUrl(cfg.baseUrl);
  if (!base) throw new Error("未配置 Clash 控制器地址");
  const resp = await fetchWithTimeout(base + path, {
    method,
    headers: {
      ...(cfg.secret ? { Authorization: `Bearer ${cfg.secret}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, 8000); // 控制器是本机服务，8 秒还不回就是它挂了，别把整批拖住
  if (!resp.ok) throw new Error(`Clash ${method} ${path} → HTTP ${resp.status}`);
  return resp.json().catch(() => null);
}

// 黑名单：{ 节点名: 解禁时间戳 }
async function clashBlacklist() {
  const { clashBlacklist = {} } = await chrome.storage.local.get("clashBlacklist");
  const now = Date.now();
  const live = {};
  for (const [name, until] of Object.entries(clashBlacklist)) if (until > now) live[name] = until;
  if (Object.keys(live).length !== Object.keys(clashBlacklist).length) {
    await chrome.storage.local.set({ clashBlacklist: live }); // 顺手清掉过期的
  }
  return live;
}

async function clashBlacklistAdd(name, minutes) {
  if (!name) return;
  const list = await clashBlacklist();
  list[name] = Date.now() + Math.max(1, minutes) * 60000;
  await chrome.storage.local.set({ clashBlacklist: list });
  notify(`⛔ 已拉黑节点「${name}」${minutes} 分钟`);
}

// 选分组：配置里写了就用它；没写就自动挑（名字像「选择/select/proxy/节点」的 Selector，其次可选最多的）
async function clashPickGroup(cfg) {
  const data = await clashRequest("/proxies");
  const proxies = (data && data.proxies) || {};
  if (cfg.group) {
    if (!proxies[cfg.group]) throw new Error(`Clash 里没有分组「${cfg.group}」`);
    return cfg.group;
  }
  const selectors = Object.entries(proxies).filter(
    ([, p]) => p && p.type === "Selector" && Array.isArray(p.all) && p.all.length > 1
  );
  if (!selectors.length) throw new Error("没找到可切换的分组（需要 Selector 类型的手动选择分组）");
  const preferred = selectors.filter(([name]) => /选择|select|proxy|节点|手动/i.test(name));
  const pool = preferred.length ? preferred : selectors;
  pool.sort((a, b) => b[1].all.length - a[1].all.length);
  return pool[0][0];
}

// 测一个节点的延迟；测不通 / 超时返回 null
async function clashDelay(node, cfg) {
  try {
    const timeout = Math.max(1000, cfg.slowMs + 2000); // 比阈值放宽一点，好区分「慢」和「不通」
    const r = await clashRequest(
      `/proxies/${encodeURIComponent(node)}/delay?timeout=${timeout}&url=${encodeURIComponent(cfg.testUrl)}`
    );
    return r && typeof r.delay === "number" ? r.delay : null;
  } catch (e) {
    return null;
  }
}

// 换节点：拉黑当前节点，从没被拉黑的里挑（先测 3 个候选，取最快的）
// 换节点。
//   rotate=true ：按分组里的顺序换「下一个」节点（换来换去绕限流用这个，保证每个节点轮到）
//   rotate=false：测 3 个候选取最快的（手动换、节点太慢时换用这个）
//   blacklist   ：是否把旧节点拉黑（限流快速重试阶段不拉黑，等过一轮还不行才拉黑）
async function clashSwitch(reason, { blacklist = true, rotate = false } = {}) {
  const cfg = await getClashConfig();
  if (!cfg.enabled) {
    return {
      ok: false,
      enabled: false,
      error: "Clash 自动切换没开：面板 → 🔀 Clash 换节点 → 勾上「限流 / 节点太慢时自动换节点」→ 点保存",
    };
  }
  if (!trimUrl(cfg.baseUrl)) {
    return {
      ok: false,
      enabled: true,
      error: "Clash 控制器地址是空的：面板 → 🔀 Clash 换节点 → 点「从配置文件导入」",
    };
  }
  try {
    const group = await clashPickGroup(cfg);
    const info = await clashRequest(`/proxies/${encodeURIComponent(group)}`);
    const now = (info && info.now) || "";
    const all = (info && info.all) || [];
    const blocked = await clashBlacklist();
    const usable = all.filter((n) => n !== now && !blocked[n]);
    if (!usable.length) {
      const err = `没有可换的节点（共 ${all.length} 个，其中 ${Object.keys(blocked).length} 个在黑名单里）`;
      notify("⚠️ " + err);
      return { ok: false, error: err, group, current: now };
    }

    let pick = "";
    let picked = null; // { delay }
    if (rotate) {
      // 从当前节点往后按顺序取候选（最多 3 个），挑第一个能测通的
      const start = Math.max(0, all.indexOf(now));
      const order = [];
      for (let i = 1; i <= all.length && order.length < 3; i++) {
        const n = all[(start + i) % all.length];
        if (n === now || blocked[n]) continue;
        order.push(n);
      }
      for (const n of order) {
        const d = await clashDelay(n, cfg);
        if (d != null) {
          pick = n;
          picked = { delay: d };
          break;
        }
      }
      if (!pick) pick = order[0] || "";
      if (!pick) {
        notify("⚠️ 往后找不到可用节点");
        return { ok: false, error: "往后找不到可用节点", group, current: now };
      }
    } else {
      const probes = usable.slice(0, 3);
      const tested = await Promise.all(
        probes.map(async (n) => ({ node: n, delay: await clashDelay(n, cfg) }))
      );
      const best = tested.filter((t) => t.delay != null).sort((a, b) => a.delay - b.delay)[0];
      pick = best ? best.node : probes[0];
      picked = best ? { delay: best.delay } : null;
    }

    await clashRequest(`/proxies/${encodeURIComponent(group)}`, {
      method: "PUT",
      body: { name: pick },
    });
    if (blacklist && now) await clashBlacklistAdd(now, cfg.blacklistMinutes);
    notify(
      `🔀 换节点：${now || "?"} → ${pick}` +
        (picked
          ? `（延迟 ${picked.delay}ms，原因：${reason}）`
          : `（原因：${reason}，候选都测不通，先换上）`) +
        (blacklist && now ? `，旧节点拉黑 ${cfg.blacklistMinutes} 分钟` : "")
    );
    // switched 要显式带上：调用方（定时检查）靠它决定要不要刷新页面
    return {
      ok: true,
      switched: true,
      group,
      from: now,
      to: pick,
      delay: picked ? picked.delay : null,
      blacklisted: !!(blacklist && now),
    };
  } catch (e) {
    const msg = String(e.message || e);
    notify("换节点失败：" + msg);
    return { ok: false, error: msg };
  }
}

// 健康检查：当前节点测不通或太慢就换一个
async function clashHealthCheck(trigger = "定时检查") {
  const cfg = await getClashConfig();
  if (!cfg.enabled) return { ok: false, skipped: true, error: "未启用" };
  try {
    const group = await clashPickGroup(cfg);
    const info = await clashRequest(`/proxies/${encodeURIComponent(group)}`);
    const now = (info && info.now) || "";
    if (!now) return { ok: false, error: "拿不到当前节点" };
    const delay = await clashDelay(now, cfg);
    if (delay == null) {
      notify(`🐢 节点「${now}」测不通（${trigger}），换一个`);
      return { ...(await clashSwitch("节点测不通")), checked: now };
    }
    if (delay > cfg.slowMs) {
      notify(`🐢 节点「${now}」延迟 ${delay}ms 超过 ${cfg.slowMs}ms（${trigger}），换一个`);
      return { ...(await clashSwitch(`延迟 ${delay}ms 太慢`)), checked: now, delay };
    }
    return { ok: true, switched: false, node: now, delay };
  } catch (e) {
    const msg = String(e.message || e);
    notify("节点健康检查失败：" + msg);
    return { ok: false, error: msg };
  }
}

// 换完节点让页面重新开始。
// 不能用 chrome.tabs.reload()：注册表单提交后的页面是 POST 结果页，reload 会弹
// 「确认重新提交表单」对话框，把自动化卡住等人点（实测踩到过）。
// 改成导航到一个干净的 GET 地址，页面脚本会按 stage 自己接着往下走。
async function reloadTaskTab(reason) {
  const { task } = await chrome.storage.session.get("task");
  if (!task) {
    notify("没有找到当前任务，没重新打开");
    return false;
  }
  // token 阶段回首页即可（首页会自己跳 token 创建页）；其它阶段回注册页重填
  const url = task.stage === "token" ? "https://github.com/" : "https://github.com/signup";
  try {
    // 标签页可能已经不在了（被用户关掉、被浏览器回收、整个窗口被关）。
    // 这时 chrome.tabs.update 会抛 "No tab with id: xxx"，流程就停在那儿不动了 ——
    // 所以先看它在不在，不在就重新开一个，并把 task 指向新标签页（页面脚本会按 stage 接着跑）。
    const alive = task.tabId ? await chrome.tabs.get(task.tabId).catch(() => null) : null;
    if (alive) {
      await chrome.tabs.update(task.tabId, { url });
      notify(`🔄 已重新打开 ${url}（${reason}）`);
      return true;
    }
    const t = await chrome.tabs.create({ url, active: true });
    // autoDiscardable 只能改、不能在建标签页时传（传了 tabs.create 会抛错）
    try { await chrome.tabs.update(t.id, { autoDiscardable: false }); } catch (e) {}
    await chrome.storage.session.set({ task: { ...task, tabId: t.id } });
    await chrome.storage.session.set({ lastPageBeat: Date.now() }); // 新页面刚开，心跳重置
    notify(`🔄 原来的标签页不在了，重新开一个：${url}（${reason}）`);
    return true;
  } catch (e) {
    notify("重新打开页面失败：" + String(e));
  }
  return false;
}

// 批量进行中每分钟检查一次节点速度
function startClashAlarm() {
  try {
    chrome.alarms.create(CLASH_ALARM, { periodInMinutes: 1 });
  } catch (e) {
    // 不支持 alarms 就算了，还有「下一个号之前」的检查兜底
  }
}

function stopClashAlarm() {
  try {
    chrome.alarms.clear(CLASH_ALARM);
  } catch (e) {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CLASH_ALARM) return;
  const queue = await getQueue();
  if (!queue) {
    stopClashAlarm(); // 没有批量在跑就不用管了
    return;
  }
  const r = await clashHealthCheck("批量进行中的定时检查");
  if (r && r.ok && r.switched) await reloadTaskTab("节点太慢，换节点后刷新");
});

// 扩展有没有被授权访问这个地址：没授权时 fetch 会直接 Failed to fetch，
// 看起来像"端口不通"，其实是浏览器拦了，要给用户指出来
async function originPermitted(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
  } catch (e) {
    return true; // 判断不了就别误导用户
  }
}

// 从 Clash / Mihomo 的运行时配置里读 external-controller 与 secret。
// Clash Verge 生成的配置里长这样（external-controller-pipe 那行不会被误读）：
//   external-controller: 127.0.0.1:9097
//   secret: xxxxx
function parseClashConfig(text) {
  const src = String(text || "");
  // 返回 null = 配置里没这个键；返回 "" = 有这个键但值是空的（Verge 关闭开关时会写成 ''）
  const raw = (key) => {
    const m = src.match(new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.*)$`, "m"));
    return m ? m[1].replace(/\s+#.*$/, "").trim() : null;
  };
  const strip = (v) => (v == null ? "" : v.replace(/^["']|["']$/g, "").trim());

  const ctrlRaw = raw("external-controller");
  const secret = strip(raw("secret"));
  let base = strip(ctrlRaw);
  if (base && !/^https?:\/\//i.test(base)) base = "http://" + base;

  // Clash Verge 关闭「外部控制」时会生成 external-controller: ''，内核因此完全不监听管理端口
  const controllerOff = ctrlRaw !== null && base === "";
  return { baseUrl: base, secret, controllerOff };
}

// 探测常见的控制器地址（连不上 / 密钥不对时给个明确结论）
// 返回 { found, needSecret, hadSecret, wrongSecret, tried }
async function clashProbe() {
  const cfg = await getClashConfig();
  const hadSecret = !!cfg.secret;
  const tried = [];
  for (const base of CLASH_CANDIDATES) {
    try {
      const resp = await fetchWithTimeout(base + "/version", {
        headers: cfg.secret ? { Authorization: `Bearer ${cfg.secret}` } : {},
      }, 3000); // 探测候选端口：每个最多等 3 秒，探不到就换下一个
      if (resp.status === 401) {
        tried.push({ base, status: 401 });
        continue;
      }
      if (!resp.ok) {
        tried.push({ base, status: resp.status });
        continue;
      }
      const info = await resp.json().catch(() => null);
      tried.push({ base, status: 200, version: (info && (info.version || info.meta)) || "" });
      return { found: base, needSecret: false, hadSecret, wrongSecret: false, tried };
    } catch (e) {
      tried.push({ base, status: 0 }); // 端口没开/连不上
    }
  }
  const locked = tried.find((t) => t.status === 401);
  return {
    found: locked ? locked.base : "",
    needSecret: !!locked && !hadSecret,
    hadSecret,
    wrongSecret: !!locked && hadSecret,
    tried,
  };
}

async function clashStatus() {
  const cfg = await getClashConfig();
  const blocked = await clashBlacklist();
  const out = {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    secret: cfg.secret,
    group: cfg.group,
    slowMs: cfg.slowMs,
    blacklistMinutes: cfg.blacklistMinutes,
    blacklistCount: Object.keys(blocked).length,
    current: "",
    groupUsed: "",
    error: "",
  };
  if (!cfg.enabled) return out;
  try {
    const group = await clashPickGroup(cfg);
    const info = await clashRequest(`/proxies/${encodeURIComponent(group)}`);
    out.current = (info && info.now) || "";
    out.groupUsed = group;
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}
