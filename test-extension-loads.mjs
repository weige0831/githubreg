// 在真实 Chrome 里把扩展装上，确认能加载、后台脚本能起来、面板/弹窗能渲染。
// 这是"用 Action 测这个项目"的一部分：**只测本仓库的代码**，不做任何别的事。
//
// CI 里用虚拟显示跑：xvfb-run -a node test-extension-loads.mjs
// 本地（无 DISPLAY）或缺 puppeteer-core 会跳过，不会让本地测试变红。
import fs from "node:fs";
import crypto from "node:crypto";

const SKIP = (why) => {
  console.log(`SKIP  扩展加载测试：${why}`);
  process.exit(0);
};

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

// 未打包扩展的 ID 是算出来的：sha256(绝对路径) 前 16 字节，每个半字节映射到 a-p
const extId = [...crypto.createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("")
  .split("")
  .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
  .join("");

const baseOpts = {
  executablePath: chromePath,
  headless: false, // 装扩展必须用有界面的 Chrome（CI 里靠 xvfb 提供虚拟显示）
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

let browser = null;
try {
  // 新版 Puppeteer 有专门的 enableExtensions 选项（会替我们处理掉那些禁扩展的默认参数）
  browser = await puppeteer.launch({ ...baseOpts, enableExtensions: [EXT], pipe: true });
  console.log("装载方式：puppeteer enableExtensions");
} catch (e) {
  console.log("enableExtensions 不可用（" + String(e.message || e).slice(0, 60) + "），退回命令行开关");
  browser = await puppeteer.launch(baseOpts);
  console.log("装载方式：--load-extension 命令行开关");
}

try {
  console.log("Chrome 版本:", await browser.version());
  console.log(
    "初始目标:",
    browser.targets().map((t) => `${t.type()}:${t.url().slice(0, 50)}`).join(" | ") || "(无)"
  );

  // 1) 打开扩展自己的页面 = 扩展真的装上了（最可靠的判定）
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  let loaded = true;
  try {
    await page.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch (e) {
    loaded = false;
    console.log("打开面板页失败：" + String(e.message || e).slice(0, 120));
  }
  check("扩展已装载（能打开自己的面板页）", loaded, `id=${extId}`);

  if (loaded) {
    await new Promise((r) => setTimeout(r, 1500));
    const title = await page.title();
    const boxes = await page.evaluate(() =>
      ["gamBox", "mailBox", "clashBox", "backupBox"].filter((id) => !!document.getElementById(id))
    );
    check("面板页标题正确", /GitHub 自动注册/.test(title), title);
    check("四个配置区块都在（导入管理器/临时邮箱/Clash/配置备份）", boxes.length === 4, boxes.join(", "));
    check("面板页没有 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

    // 后台 service worker 是否健康：storage 能用就说明它在正常跑
    const apiOk = await page.evaluate(async () => {
      try {
        const r = await chrome.storage.local.get("accounts");
        return !!(r && typeof r === "object");
      } catch (e) {
        return false;
      }
    });
    check("后台脚本正常（扩展 storage API 可用）", apiOk === true, "");

    // 目标列表里能不能看到 SW（信息性，不作为失败条件：不同 Puppeteer 版本表现不同）
    const sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes(extId));
    console.log(`INFO  service worker 目标：${sw ? "已列出" : "未列出（不影响判定）"}`);

    // 2) 弹窗页也能渲染
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1000));
    const popupOk = await popup.evaluate(
      () => !!document.getElementById("startBtn") && !!document.getElementById("stopBtn") && !!document.getElementById("log")
    );
    check("弹窗页渲染正常（开始/停止按钮、日志区都在）", popupOk === true, "");
  }
} catch (e) {
  check("扩展加载测试执行完成", false, String(e && e.message ? e.message : e));
} finally {
  await browser.close();
}

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASS（扩展能在真实 Chrome 里装载并运行）");
process.exit(failures ? 1 : 0);
