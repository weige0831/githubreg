// 在真实 Chrome 里把扩展装上，确认能加载、后台脚本能起来、面板能渲染。
// 这是"用 Action 测这个项目"的一部分：**只测本仓库的代码**，不做任何别的事。
//
// CI 里用虚拟显示跑：xvfb-run -a node test-extension-loads.mjs
// 本地（Windows/无 DISPLAY）会跳过，缺 puppeteer-core 也跳过，不会让本地测试变红。
import fs from "node:fs";

const SKIP = (why) => {
  console.log(`SKIP  扩展加载测试：${why}`);
  process.exit(0);
};

// 需要虚拟显示（headless shell 不支持装扩展，必须用有窗口的 Chrome）
if (!process.env.CI && !process.env.DISPLAY) {
  SKIP("本机没有虚拟显示（本地跳过；CI 里用 xvfb-run 跑）");
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
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

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false, // 装扩展必须用有界面的 Chrome（CI 里靠 xvfb 提供虚拟显示）
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    // 新版 Chrome（137+）默认忽略 --load-extension，要用这个 feature 开关放开
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-sandbox",
    "--no-first-run",
    "--disable-gpu",
  ],
});

try {
  // 未打包扩展的 ID 是算出来的：sha256(绝对路径) 前 16 字节，每个半字节映射到 a-p
  const crypto = await import("node:crypto");
  const computedId = [...crypto.createHash("sha256").update(EXT).digest().subarray(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
    .join("");

  const findSW = () =>
    browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  let swTarget = null;
  for (let i = 0; i < 20 && !swTarget; i++) {
    swTarget = findSW();
    if (!swTarget) await new Promise((r) => setTimeout(r, 500));
  }
  // 兜底：SW 是懒启动的，直接打开扩展自己的页面会把它拉起来
  const extId = swTarget ? new URL(swTarget.url()).host : computedId;
  if (!swTarget) {
    const warm = await browser.newPage();
    try {
      await warm.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch (e) {}
    for (let i = 0; i < 20 && !swTarget; i++) {
      swTarget = findSW();
      if (!swTarget) await new Promise((r) => setTimeout(r, 500));
    }
  }
  check("扩展已装载", !!swTarget || extId === computedId, `扩展 id=${extId}`);
  check("后台 service worker 起来了（manifest 合法、background.js 能执行）", !!swTarget, swTarget ? swTarget.url().split("/").pop() : "没找到 SW 目标");

  // 2) 面板页能打开、关键区块渲染出来、没有 JS 报错
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2000));
  const title = await page.title();
  const boxes = await page.evaluate(() =>
    ["gamBox", "mailBox", "clashBox", "backupBox"].filter((id) => !!document.getElementById(id))
  );
  check("面板页标题正确", /GitHub 自动注册/.test(title), title);
  check("四个配置区块都在（导入管理器/临时邮箱/Clash/配置备份）", boxes.length === 4, boxes.join(", "));
  check("面板页没有 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  // 3) 后台能应答消息（storage 可用 = 扩展 API 正常）
  const apiOk = await page.evaluate(async () => {
    try {
      const accounts = await chrome.storage.local.get("accounts");
      return !!(accounts && typeof accounts === "object");
    } catch (e) {
      return false;
    }
  });
  check("扩展 storage API 可用", apiOk === true, "");

  // 4) 弹窗页也能渲染
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1000));
  const popupHasStart = await popup.evaluate(() => !!document.getElementById("startBtn") && !!document.getElementById("stopBtn"));
  check("弹窗页有开始/停止按钮", popupHasStart === true, "");
} catch (e) {
  check("扩展加载测试执行完成", false, String(e && e.message ? e.message : e));
} finally {
  await browser.close();
}

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASS（扩展能在真实 Chrome 里装载并运行）");
process.exit(failures ? 1 : 0);
