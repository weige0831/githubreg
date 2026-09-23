// 参数化集成测试：把「邮局」和「导入管理器」的设置传进来，验证扩展代码能连通这两个服务。
//
// 参数来源（环境变量，工作流里由 workflow_dispatch 输入 / Secrets 传入）：
//   MAIL_API_URL / MAIL_DOMAIN        临时邮局地址与邮箱域名
//   MANAGER_BASE_URL / MANAGER_PASSWORD / MANAGER_API_KEY   管理器地址与凭据
// 没传参就跳过（不报错），传了就跑：
//   · 用**扩展自己的代码**建一个临时邮箱（验证邮局地址+域名可用）
//   · 用**扩展自己的代码**登录管理器并读一次分组（验证地址+密码/API Key 可用）
//
// 明确不做的事：不碰 Clash（GA 版本舍弃换节点部分）、不创建任何 GitHub 账号。
import fs from "node:fs";
import vm from "node:vm";

const MAIL_API_URL = (process.env.MAIL_API_URL || "").trim();
const MAIL_DOMAIN = (process.env.MAIL_DOMAIN || "").trim();
const MANAGER_BASE_URL = (process.env.MANAGER_BASE_URL || "").trim();
const MANAGER_PASSWORD = (process.env.MANAGER_PASSWORD || "").trim();
const MANAGER_API_KEY = (process.env.MANAGER_API_KEY || "").trim();
const MANAGER_GROUP_SIZE = parseInt(process.env.MANAGER_GROUP_SIZE, 10) || 0;
const MANAGER_SAVE_LOCAL = (process.env.MANAGER_SAVE_LOCAL || "").trim();

if (!MAIL_API_URL && !MANAGER_BASE_URL) {
  console.log("SKIP  集成测试：没有传入邮局/管理器设置（workflow 里填 mail_api_url / manager_base_url，或配 Secrets）");
  process.exit(0);
}

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!ok) failures++;
};

// ---------- 最小 chrome stub：只给被测代码需要的部分 ----------
const store = {
  local: {
    // Clash 换节点在 GA 版本里舍弃：显式关掉，代码就不会去碰本机控制器
    clashConfig: { enabled: false, baseUrl: "", secret: "", group: "", slowMs: 5000, blacklistMinutes: 25 },
    mailConfig: { apiUrl: MAIL_API_URL, domain: MAIL_DOMAIN },
    gamConfig: {
      enabled: true,
      baseUrl: MANAGER_BASE_URL,
      masterPassword: MANAGER_PASSWORD,
      apiKey: MANAGER_API_KEY,
      groupSize: MANAGER_GROUP_SIZE || 10,
      saveLocal: MANAGER_SAVE_LOCAL ? MANAGER_SAVE_LOCAL !== "false" : true,
    },
    accounts: [],
  },
  session: {},
};
const logs = [];
const area = (name) => ({
  get: async (k) => {
    const o = store[name];
    if (k == null) return { ...o };
    const out = {};
    for (const key of [].concat(k)) if (key in o) out[key] = o[key];
    return out;
  },
  set: async (obj) => Object.assign(store[name], obj),
  remove: async (k) => {
    for (const key of [].concat(k)) delete store[name][key];
  },
});
globalThis.chrome = {
  storage: { local: area("local"), session: area("session"), onChanged: { addListener() {} } },
  runtime: {
    sendMessage: async (msg) => {
      if (msg && msg.type === "log") logs.push(msg.text);
    },
    getURL: (p) => "chrome-extension://test/" + p,
    onMessage: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
  },
  permissions: { contains: async () => true, request: async () => true },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
  notifications: { create: async () => {} },
  tabs: { create: async () => ({ id: 1 }), remove: async () => {}, query: async () => [], update: async () => {} },
  browsingData: { remove: async () => {} },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  offscreen: { createDocument: async () => {} },
};

// ---------- 加载扩展真实代码 ----------
globalThis.importScripts = (...files) => {
  for (const f of files) vm.runInThisContext(fs.readFileSync(f, "utf8"), { filename: f });
};
vm.runInThisContext(fs.readFileSync("background.js", "utf8"), { filename: "background.js" });

// ---------- 1) 邮局：用扩展的 createTempEmail 真建一个临时邮箱 ----------
if (MAIL_API_URL) {
  try {
    const mail = await globalThis.createTempEmail();
    check("邮局可用（扩展代码建邮箱成功）", !!(mail && mail.email && mail.token), String((mail && mail.email) || ""));
    if (MAIL_DOMAIN) check("邮箱域名生效", String(mail.email).endsWith("@" + MAIL_DOMAIN), String(mail.email));
  } catch (e) {
    check("邮局可用（扩展代码建邮箱成功）", false, String(e.message || e).slice(0, 100));
  }
} else {
  console.log("SKIP  邮局检查（没传 mail_api_url）");
}

// ---------- 2) 管理器：用扩展的 gamRequest 登录并读分组 ----------
if (MANAGER_BASE_URL) {
  try {
    const groups = await globalThis.gamRequest("/accounts/groups");
    check("管理器可用（扩展代码登录并读到分组）", Array.isArray(groups), `分组 ${Array.isArray(groups) ? groups.length : "?"} 个`);
    const status = await globalThis.gamStatus();
    check("管理器配置被正确读取", status.baseUrl === MANAGER_BASE_URL && !!status.authMode, `鉴权=${status.authMode}`);
    if (MANAGER_GROUP_SIZE) {
      check(`每组数量按传入参数生效（${MANAGER_GROUP_SIZE}）`, status.groupSize === MANAGER_GROUP_SIZE, `groupSize=${status.groupSize}`);
    }
    if (MANAGER_SAVE_LOCAL) {
      check(`本地保存开关按传入参数生效（${MANAGER_SAVE_LOCAL}）`, status.saveLocal === (MANAGER_SAVE_LOCAL !== "false"), `saveLocal=${status.saveLocal}`);
    }
    check("GA 版本里 Clash 是关掉的（不碰本机控制器）", status.enabled === true && store.local.clashConfig.enabled === false, "");
  } catch (e) {
    check("管理器可用（扩展代码登录并读到分组）", false, String(e.message || e).slice(0, 100));
  }
} else {
  console.log("SKIP  管理器检查（没传 manager_base_url）");
}

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASS（集成检查：邮局 + 管理器）");
// 不要用 process.exit()：这里的 fetch 是真实请求、连接池还在收尾，
// 硬退出在 Windows 上会命中 libuv 断言（看起来像测试失败）。交给事件循环自然结束。
process.exitCode = failures ? 1 : 0;
