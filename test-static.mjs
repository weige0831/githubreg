// 项目的静态检查（不跑逻辑，只查结构/引用/不该出现的东西）—— CI 里第一条就跑它
// 本地也可以直接跑：node test-static.mjs
import fs from "node:fs";

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!ok) failures++;
};

// ---------- 1) manifest 与引用完整性 ----------
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
check("manifest 是 MV3", manifest.manifest_version === 3, String(manifest.manifest_version));
check("manifest 版本号形如 x.y.z", /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);

const refs = [
  manifest.action && manifest.action.default_popup,
  manifest.side_panel && manifest.side_panel.default_path,
  manifest.background && manifest.background.service_worker,
  ...((manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js) || []),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);
const missingManifestRefs = refs.filter((f) => !fs.existsSync(f));
check("manifest 引用的文件都存在", missingManifestRefs.length === 0, missingManifestRefs.join(", "));

for (const page of ["popup.html", "panel.html", "accounts.html", "offscreen.html"]) {
  const html = fs.readFileSync(page, "utf8");
  const local = [...html.matchAll(/(?:src|href)="([^"/:]+\.(?:js|css))"/g)].map((m) => m[1]);
  const missing = local.filter((f) => !fs.existsSync(f));
  check(`${page} 引用的资源都存在`, missing.length === 0, missing.join(", "));
}

// ---------- 2) 所有 JS 语法可解析 ----------
const jsFiles = fs.readdirSync(".").filter((f) => f.endsWith(".js"));
check("目录里有 JS 文件", jsFiles.length > 0, jsFiles.join(", "));

// ---------- 3) 弹窗与面板的配置区块结构一致 ----------
const gamUi = fs.readFileSync("gam-ui.js", "utf8");
const ids = [...new Set([...gamUi.matchAll(/\$id\("([^"]+)"\)|getElementById\("([^"]+)"\)/g)].map((m) => m[1] || m[2]))];
const idSets = {};
for (const page of ["popup.html", "panel.html"]) {
  const html = fs.readFileSync(page, "utf8");
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  check(`${page} 含有配置区块需要的全部 id`, missing.length === 0, missing.join(", "));
  idSets[page] = [...html.matchAll(/id="((?:gam|mail|clash|backup|perm)[A-Za-z]+)"/g)].map((m) => m[1]).join(",");
}
check("弹窗与面板的配置区块 id 一致", idSets["popup.html"] === idSets["panel.html"], "");

// ---------- 4) 公开仓库里不能带私人服务默认值 ----------
const bg = fs.readFileSync("background.js", "utf8");
const gamDefault = bg.match(/const GAM_DEFAULT = \{([\s\S]*?)\};/);
check("代码里有 GAM_DEFAULT", !!gamDefault, "");
if (gamDefault) {
  const body = gamDefault[1];
  const baseUrl = (body.match(/baseUrl:\s*"([^"]*)"/) || [])[1];
  const password = (body.match(/masterPassword:\s*"([^"]*)"/) || [])[1];
  check("管理器地址默认留空（不把私人服务写进公开仓库）", baseUrl === "", `baseUrl="${baseUrl}"`);
  check("管理密码默认留空", password === "", password === "" ? "" : "(有值，不该)");
}
const mailDefault = bg.match(/const MAIL_DEFAULT = \{([\s\S]*?)\};/);
check("代码里有 MAIL_DEFAULT", !!mailDefault, "");
if (mailDefault) {
  const apiUrl = (mailDefault[1].match(/apiUrl:\s*"([^"]*)"/) || [])[1];
  check("邮局地址默认留空", apiUrl === "", `apiUrl="${apiUrl}"`);
}

// ---------- 5) 推送脚本的私人信息闸门还在（脚本只在本机存在，不进公开仓库）----------
let push = "";
try { push = fs.readFileSync("push-to-github.mjs", "utf8"); } catch (e) {}
if (push) {
  check("推送脚本有私人信息闸门", /scanPrivateInfo/.test(push) && /private-patterns\.json/.test(push), "");
  check("推送脚本会跳过 .zcode/", /\.zcode/.test(push), "");
  check("推送脚本不会把自己推上去", /SKIP_FILES/.test(push) && /push-to-github\.mjs/.test(push), "");
} else {
  console.log("SKIP  推送脚本只在本机（公开仓库里没有它），跳过它的闸门检查");
}

// ---------- 6) 不许把本地配置/密钥提交进来 ----------
const gitignore = fs.readFileSync(".gitignore", "utf8");
for (const must of [".zcode/", "github-token.txt"]) {
  check(`.gitignore 忽略了 ${must}`, gitignore.includes(must), "");
}

console.log(failures ? `\nFAILED: ${failures}` : "\nALL PASS（静态检查）");
process.exit(failures ? 1 : 0);
