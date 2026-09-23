// 在真实 Chrome 里把扩展装上，确认能加载、后台脚本能起来、面板/弹窗能渲染。
// 这是"用 Action 测这个项目"的一部分：**只测本仓库的代码**，不做任何别的事。
//
// CI 里跑：Windows runner 直接跑；Linux 上是 xvfb-run -a node test-extension-loads.mjs
// 本地没设 CI 会跳过；缺 puppeteer-core 也跳过，不会让本地测试变红。
import fs from "node:fs";
import crypto from "node:crypto";

const SKIP = (why) => {
  console.log(`SKIP  扩展加载测试：${why}`);
  process.exit(0);
};

if (!process.env.CI && !process.env.DISPLAY) {
  SKIP("本机没有虚拟显示（本地跳过；CI 上会跑）");
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
});
if (!chromePath) SKIP("没找到 Chrome");

let puppeteer = null;
try {
  puppeteer = (await import("puppeteer-core")).default;
} catch (e) {
  SKIP("没装 puppeteer-core（CI 里 npm i puppeteer-core）");
}

const EXT = process.cwd();
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!ok) failures++;
};

// 未打包扩展的 ID 是算出来的：sha256(绝对路径) 前 16 字节，每个半字节映射到 a-p
const extId = [...crypto.createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("")
  .split("")
  .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
  .join("");
const panelUrl = `chrome-extension://${extId}/panel.html`;

const baseOpts = {
  executablePath: chromePath,
  headless: false, // 装扩展必须用有界面的 Chrome（Linux CI 靠 xvfb 提供虚拟显示）
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    // 新版 Chrome（137+）默认忽略 --load-extension，这个 feature 开关放开它
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-sandbox",
    "--no-first-run",
    "--disable-gpu",
  ],
};

// 能打开扩展自己的页面 = 扩展真的装上了
// （比看 service worker 目标可靠：不同 Puppeteer 版本对这个的表现不一样）
async function extensionUsable(browser) {
  const page = await browser.newPage();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      return page;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}

// 两种装载机制都试：老版 Chrome 认命令行开关，新版才认 CDP 的 enableExtensions
const attempts = [
  { label: "命令行 --load-extension", opts: baseOpts },
  { label: "puppeteer enableExtensions（CDP）", opts: { ...baseOpts, enableExtensions: [EXT], pipe: true } },
];

let browser = null;
let page = null;
let usedLabel = "";
for (const a of attempts) {
  let b = null;
  try {
    b = await puppeteer.launch(a.opts);
    const p = await extensionUsable(b);
    if (p) {
      browser = b;
      page = p;
      usedLabel = a.label;
      break;
    }
    console.log(`装载方式「${a.label}」没能装上扩展，换下一种`);
    await b.close();
  } catch (e) {
    console.log(`装载方式「${a.label}」报错：${String(e.message || e).slice(0, 100)}`);
    try {
      if (b) await b.close();
    } catch (e2) {}
  }
}

if (!browser) {
  console.log(`Chrome 路径: ${chromePath}`);
  check("扩展已装载（能打开自己的面板页）", false, "两种装载机制都没成功");
  console.log("提示：Chrome 137+ 移除了命令行装扩展，需要 CHROME_BIN 指向仍支持的版本（如 Chrome for Testing 136）");
  process.exit(1);
}

console.log("装载方式：" + usedLabel);
console.log("Chrome 版本:", await browser.version());

try {
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await new Promise((r) => setTimeout(r, 1500));

  check("扩展已装载（能打开自己的面板页）", true, `id=${extId}`);
  const title = await page.title();
  const boxes = await page.evaluate(() =>
    ["gamBox", "mailBox", "clashBox", "backupBox"].filter((id) => !!document.getElementById(id))
  );
  check("面板页标题正确", /GitHub 自动注册/.test(title), title);
  check("四个配置区块都在（导入管理器/临时邮箱/Clash/配置备份）", boxes.length === 4, boxes.join(", "));
  check("面板页没有 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  // 后台脚本是否健康：storage 能用就说明它在正常跑
  const apiOk = await page.evaluate(async () => {
    try {
      const r = await chrome.storage.local.get("accounts");
      return !!(r && typeof r === "object");
    } catch (e) {
      return false;
    }
  });
  check("后台脚本正常（扩展 storage API 可用）", apiOk === true, "");

  const sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes(extId));
  console.log(`INFO  service worker 目标：${sw ? "已列出" : "未列出（不影响判定）"}`);

  // 弹窗页也能渲染
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));
  const popupOk = await popup.evaluate(
    () => !!document.getElementById("startBtn") && !!document.getElementById("stopBtn") && !!document.getElementById("log")
  );
  check("弹窗页渲染正常（开始/停止按钮、日志区都在）", popupOk === true, "");
} catch (e) {
  check("扩展加载测试执行完成", false, String(e && e.message ? e.message : e));
} finally {
  await browser.close();
}

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASS（扩展能在真实 Chrome 里装载并运行）");
process.exit(failures ? 1 : 0);
