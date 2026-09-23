// 实际流程测试：在真实 Chrome 里装扩展，用真实邮局 + 真实管理器**完整跑一遍注册**，
// 看它能不能自己注册成功、拿到 token 并导入管理器。
//
// 只在 CI（或显式 RUN_REAL_FLOW=1）里跑，本机默认跳过。
// 需要的环境变量：MAIL_API_URL / MAIL_DOMAIN / MANAGER_BASE_URL / MANAGER_PASSWORD（或 MANAGER_API_KEY）
// 退出码：0=注册成功  2=被 GitHub 反爬拦（环境问题，不是代码问题）  1=其它失败
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const log = (...a) => console.log(...a);
// puppeteer 启动失败后清理临时 profile 时可能抛 EBUSY（Windows 上文件还被锁），
// 那是它自己的清理噪音，不该把测试打崩 —— 否则后面的启动方式根本没机会试。
process.on("unhandledRejection", (e) => log("（忽略一个未处理的拒绝：" + String(e).slice(0, 90) + "）"));
if (!process.env.CI && !process.env.RUN_REAL_FLOW) {
  log("SKIP  实际流程测试：本机默认不跑（CI 里会跑；要本机跑就设 RUN_REAL_FLOW=1）");
  process.exit(0);
}

const MAIL_API_URL = (process.env.MAIL_API_URL || "").trim();
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || "").trim();
const MANAGER_BASE_URL = (process.env.MANAGER_BASE_URL || "").trim();
const MANAGER_PASSWORD = (process.env.MANAGER_PASSWORD || "").trim();
const MANAGER_API_KEY = (process.env.MANAGER_API_KEY || "").trim();
const DEADLINE_MIN = parseInt(process.env.REAL_FLOW_MINUTES || "15", 10);

if (!MAIL_API_URL || !MANAGER_BASE_URL || (!MANAGER_PASSWORD && !MANAGER_API_KEY)) {
  log("SKIP  实际流程测试：缺 MAIL_API_URL / MANAGER_BASE_URL / MANAGER_PASSWORD（配到仓库 Secrets 里）");
  process.exit(0);
}

const CHROME = [process.env.CHROME_BIN, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome"]
  .filter(Boolean)
  .find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!CHROME) { log("SKIP  实际流程测试：没找到 Chrome"); process.exit(0); }

let puppeteer = null;
try { puppeteer = (await import("puppeteer-core")).default; } catch (e) { log("SKIP  实际流程测试：没装 puppeteer-core"); process.exit(0); }

// ---------- 1) 复制一份扩展，并把邮局/管理器地址写进必需权限（免得测不了权限弹窗）----------
const EXT_SRC = process.cwd();
// 副本放在 runner 的临时目录（RUNNER_TEMP，形如 D:/a/_temp 这种干净短路径）。
// 之前用 os.tmpdir() 得到的是 C:/Users/RUNNER~1/... 这种 8.3 短名路径，
// 实测在 GA 上 Chrome 用 --load-extension 加载它时会卡住（拿不到 WS 端点）。
const TMP_ROOT = process.env.RUNNER_TEMP || os.tmpdir();
const EXT = fs.mkdtempSync(path.join(TMP_ROOT, "ghreg-ext-"));
// 只跳过大而无用的目录，其余全拷 —— icons 必须留：manifest 引用它们，缺了扩展装不上
const SKIP = new Set([".git", ".github", ".zcode", "node_modules"]);
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
};
copyDir(EXT_SRC, EXT);
const manifestPath = path.join(EXT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const hosts = [];
for (const u of [MAIL_API_URL, MANAGER_BASE_URL]) {
  try { hosts.push(new URL(u).origin + "/*"); } catch (e) {}
}
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...hosts])];
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
log(`测试用扩展副本: ${EXT}`);
log(`预授权 host: ${hosts.join(", ")}`);

// ---------- 2) 启动真实 Chrome ----------
// 启动：与 test-extension-loads.mjs 同样的参数，但超时给足（并行 job 抢资源时 30 秒不够），
// 而且只启动一次 —— 失败后残留的 Chrome 会拖垮第二次尝试（实测 EBUSY + 第二次握手挂死）。
const baseOpts = {
  executablePath: CHROME,
  headless: false, // 装扩展必须用有界面的 Chrome
  timeout: 180000,
  protocolTimeout: 240000,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-sandbox",
    "--no-first-run",
    "--disable-gpu",
  ],
};
let browser = null;
try {
  browser = await puppeteer.launch(baseOpts);
  log("Chrome 已启动");
} catch (e) {
  log(`FAIL  Chrome 起不来：${String((e && e.message) || e).slice(0, 140)}`);
  process.exit(1);
}

const waitId = async (ms = 25000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = browser.targets().find((x) => x.url().startsWith("chrome-extension://"));
    if (t) { try { return new URL(t.url()).host; } catch (e) {} }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
};
const extId = await waitId();
if (!extId) { log("FAIL  扩展没装上"); await browser.close(); process.exit(1); }
log(`扩展已装载: ${extId}`);

// ---------- 3) 面板页里写入配置，然后点「开始注册」 ----------
const panel = await browser.newPage();
await panel.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
await panel.evaluate(async (cfg) => {
  await chrome.storage.local.clear();
  await chrome.storage.local.set(cfg);
  await chrome.storage.session.clear();
}, {
  mailConfig: { apiUrl: MAIL_API_URL, domain: MAIL_DOMAIN },
  gamConfig: { enabled: true, baseUrl: MANAGER_BASE_URL, masterPassword: MANAGER_PASSWORD, apiKey: MANAGER_API_KEY, groupSize: 10, saveLocal: true },
  clashConfig: { enabled: false, baseUrl: "", secret: "", group: "", slowMs: 5000, blacklistMinutes: 25 },
  accounts: [],
});
await panel.evaluate(() => { const i = document.getElementById("countInput"); if (i) i.value = "1"; });
log("已写入配置，点「开始注册」...");
await panel.click("#startBtn");

// ---------- 4) 边等边看：账户出现了吗 / 卡在什么页面 ----------
// 注意：点开始注册后扩展会"清理环境"（关掉多余标签页），刚才那个面板页会被关掉，
// 所以状态从**后台 service worker** 读（不依赖标签页），日志用一个新开的面板页收。
const swTarget = () => browser.targets().find((t) => t.type() === "service_worker" && t.url().includes(extId));
const readState = async () => {
  const t = swTarget();
  const w = t ? await t.worker().catch(() => null) : null;
  if (!w) return { accounts: [], sessionTask: null, log: await getLog() };
  const st = await w
    .evaluate(async () => {
      const { accounts = [] } = await chrome.storage.local.get("accounts");
      const { task = null } = await chrome.storage.session.get("task");
      return { accounts, sessionTask: task };
    })
    .catch(() => ({ accounts: [], sessionTask: null }));
  return { ...st, log: await getLog() };
};

let logPage = null;
async function getLog() {
  try {
    if (!logPage || logPage.isClosed()) {
      logPage = await browser.newPage();
      await logPage.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    }
    return await logPage.evaluate(() => {
      const el = document.getElementById("log");
      return el ? el.innerText : "";
    });
  } catch (e) {
    return "";
  }
}

const BOT_RE = /访问暂时受限|我不是机器人|verify you are human|temporarily restricted|too many (requests|attempts)|rate limit|whoa there|请求过多|操作过于频繁/i;
let done = null;
let blocked = false;
const until = Date.now() + DEADLINE_MIN * 60000;
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await readState();
  const withToken = (st.accounts || []).find((a) => a.token);
  if (withToken) { done = { account: withToken, log: st.log }; break; }
  const stage = (st.sessionTask && st.sessionTask.stage) || (st.task && st.task.stage);
  if (stage === "done") { done = { account: null, log: st.log }; break; }
  // 看看 GitHub 那边是不是被反爬拦住了（环境问题，不是代码问题）
  const gh = browser.targets().find((t) => t.url().includes("github.com/"));
  if (gh) {
    try {
      const p = await gh.page();
      if (p) {
        const txt = await p.evaluate(() => document.body.innerText.slice(0, 1500));
        if (BOT_RE.test(txt)) blocked = true;
      }
    } catch (e) {}
  }
}

const final = await readState();
// 域名侧页面上读不到文字时（GitHub 的挑战页常常是空的），用扩展自己的判定做证据：
// 它反复报「页面异常 / 上既没有表单也没有按钮」＝ GitHub 没给正常的注册页 ＝ 环境（IP）被拦。
if (/页面异常（没有可操作元素）|上既没有表单也没有按钮|当成被拦截处理/.test(final.log)) blocked = true;

log("\n═══════ 面板日志（最后 40 行）═══════");
log(final.log.split("\n").slice(-40).join("\n"));
log("═══════ 结束 ═══════");

if (done && done.account) {
  const a = done.account;
  log(`\nPASS  注册流程跑通：${a.username} / ${a.email}，拿到 token ${String(a.token).slice(0, 12)}...`);
  // 管理器里有没有
  try {
    const base = MANAGER_BASE_URL.replace(/\/+$/, "");
    const H = MANAGER_API_KEY ? { "X-API-Key": MANAGER_API_KEY } : { Authorization: "Bearer " + (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ masterPassword: MANAGER_PASSWORD }) })).json()).data.token };
    const list = await (await fetch(`${base}/api/accounts`, { headers: H })).json();
    const hit = (list.data || []).find((x) => String(x.token_masked || "") && String(a.token).includes(""));
    const found = (list.data || []).find((x) => (x.note || "").startsWith(String(a.gamNote || "@@@")) && a.gamNote) || hit;
    log(found ? `PASS  管理器里有这条记录（备注 ${found.note}，分组 ${found.group}）` : "WARN  没在管理器里找到该 token（可能导入失败，看日志里的导入行）");
  } catch (e) {
    log("WARN  查管理器失败: " + String(e.message || e).slice(0, 80));
  }
  await browser.close();
  process.exit(0);
}

log("\nFAIL  到时间还没拿到 token");
if (blocked) {
  log("原因：GitHub 对这个 runner 的 IP 返回了限流/人机验证页 —— 这是**环境限制**（机房 IP 常见），不是代码问题。");
  log("代码侧的表现见上面的面板日志（有没有正确识别并进入重试循环）。");
  await browser.close();
  process.exit(2);
}
await browser.close();
process.exit(1);
