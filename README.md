# GitHub 自动注册（浏览器扩展）

把 GitHub 注册流程做成 Chrome 扩展，带中文界面，无需 Python 环境。

## 功能

- 🚀 一键开始：自动创建临时邮箱（走你自己配置的临时邮箱 API）
- 📌 常驻侧边栏面板：固定在窗口右侧，切页/跳转都不消失，可一直看进度
- 📝 自动填表：打开 GitHub 首页 → 点 Sign up → 填邮箱/密码/用户名（重名自动换）
- 📧 验证码自动输入：后台轮询临时邮箱提取 launch code，自动逐位填入
- 🔁 批量连续注册：一次可设置 1~999 个，自动逐个注册，面板显示进度条
- 🔊 成功提示音 + 系统通知：注册成功即播放和弦提示音
- 📒 账户管理页：列表展示、复制、删除、清空、导出
- 📥 token 自动导入管理器：注册成功后自动把 key 导入你自建的账户管理器（分组 / 备注自动编号），
  每 10 个号一组（分组名 = 日期 + 6 位随机字符，当天不重复），组内备注依次是 `分组名-0` … `分组名-9`
- �💾 账户自动保存：存到扩展本地（可一键导出为 `github_accounts.txt`）
- 🔒 防检测：配合 Cloak 浏览器使用效果最佳

## 安装

1. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`（Edge 用 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹 `extension/`
4. 点击工具栏的扩展图标（📧 图标），即可看到中文面板

> 建议搭配 Cloak 浏览器使用：`python -m cloakbrowser install` 安装后，
> 在 Cloak 的浏览器配置里加载本扩展（`--load-extension=<本目录>`）。

## 使用

1. 点扩展图标 → 自动打开右侧**常驻面板**（或在注册时自动呼出）
2. 在面板里点「开始注册」（可先设置连续注册数量 1~999）
3. 扩展自动打开 GitHub 页面并开始填表，面板实时显示日志和批量进度条
4. 注册成功会播放提示音 + 系统通知
5. 点「📒 管理账户」可查看列表、复制、删除、清空
6. 点「导出」下载 `github_accounts.txt`

> 面板是侧边栏常驻的：即使切到别的标签页或 GitHub 页面跳转，面板和日志都一直显示，
> 方便盯着批量注册过程。

账户格式：`用户名:密码--邮箱`（每行一个）

## 运行前配置（面板 / 弹窗里填，改完即生效）

两个折叠区块，都在 popup 和侧边栏面板里，不开注册也能改：

### 📥 导入管理器

| 字段 | 说明 |
| --- | --- |
| 地址 | 管理器地址，形如 `http://你的服务器:端口`（自己填，代码里不带默认值） |
| API Key | 填了就优先用 `X-API-Key` 鉴权（长期有效），此时不需要管理密码 |
| 管理密码 | 只在「生成 API Key」或没填 API Key 时使用（用密码换 JWT，7 天有效期、过期自动重登） |
| 每组 | 一个分组放多少个号，默认 10 |
| 本地也存一份 | 默认勾选（本地存一份 + 导入管理器）。取消后**只导入管理器、本地不留明文副本**；没拿到 token 或导入失败的号仍会本地留一份并在日志里提示，避免丢号 |
| 生成 API Key | 用管理密码调 `POST /api/apikeys` 建一个永久 Key 并自动填入、保存 |
| 测试连接 | 用表单里的地址/凭据请求一次 `/api/accounts/groups` |
| 补导入 | 重试之前导入失败的账户 |

> 「已导入 N 个」是扩展自己的累计计数，不依赖本地列表——清空本地记录或取消「本地也存一份」后数字照旧准确；
> 管理器里的真实数量以管理器页面为准。

### 📧 临时邮箱

| 字段 | 说明 |
| --- | --- |
| 邮局地址 | 临时邮箱服务的地址（自己填，代码里不带默认值） |
| 邮箱域名 | 收信域名，注册时邮箱 = `gh_随机名@这里填的域名` |
| 测试建邮箱 | 真去邮局建一个临时邮箱，验证地址和域名能用 |

> 两个区块里的地址都要自己填：点「保存」时浏览器会弹窗申请该域名的访问权限
> （扩展只预授权了 `github.com`）点「允许」即可；拒绝的话配置不会保存，会提示未授权。
> 填一次就存在扩展本地存储里，之后不用再填。

分组与备注规则：

- 分组名 = `日期(YYYYMMDD)` + 6 位随机字符（字符集剔除了 `l/o/0/1`），生成时会和
  管理器里已有的分组名以及当天已用过的名字比对，保证当天不重复
- 组内备注依次是 `分组名-0`、`分组名-1` … `分组名-9`，满 10 个自动开下一个分组
- 只有导入成功才占用编号，失败重试会复用同一个备注，所以一个组里不会出现缺号

失败处理：管理器临时不可用（网络/5xx）会重试 3 次，仍失败则进「待重试队列」，
不影响后续注册；下一次注册完成时自动补导入，也可以点「补导入」手动重试。
重复账户、空 token、鉴权失败这类永久性错误直接跳过、不排队。

> 导入时会把 GitHub 密码和临时邮箱一起作为 `password` / `recovery_email` 提交（管理器会加密存储）。

## 代码仓库与自动推送

代码公开在 <https://github.com/weige0831/githubreg>，改动会自动推上去。

**推送方式**：`node push-to-github.mjs`

- 优先用本机 git（工作区是 git 仓库时）：`git add -A` → `git commit` → `git push origin HEAD:main`；
  没有 git 的机器会退回 GitHub API（用 blob sha 比对本地与远端，只上传变化的文件，删除同步，
  没变化就退出、不产生空提交）。用 `PUSH_FORCE_API=1` 可以强制走 API 那条路。
- 手动推送也可以直接用 git：`git add -A && git commit -m "..." && git push`。

**本机 git**（已装好，2.55.0）

- 安装位置 `C:\Program Files\Git`（Chocolatey 装的；`choco install git -y` 可复现）。
- 身份：`user.name=WG`、`user.email=135250405+weige0831@users.noreply.github.com`（用 GitHub 的 noreply 邮箱，不暴露真实邮箱）。
- 凭据：`credential.helper = store --file=<用户目录>/.zcode/git-credentials`，
  token 存在仓库目录之外，`git push` 不需要交互输入。
- `core.autocrlf=false`：仓库里的文件都是 LF，关掉换行转换才能保证推送的字节和本地完全一致。
- 装完 git 后 PATH 对已开着的程序不生效，重启 ZCode（或新开一个终端）后 `git` 命令才直接可用；
  推送脚本里用的是绝对路径，所以 hook 不受影响。

**私人信息闸门**（防止把私人服务信息推到这个公开仓库）

- 推送前会扫一遍工作区，命中 `.zcode/private-patterns.json` 里任何一条关键字就**拒绝推送**并列出命中位置；
  该文件只在本机（`.zcode/` 不推送），自己新增私人服务时把地址/域名/密码关键字加进去即可。
- 确认要推：`PUSH_ALLOW_SECRETS=1 node push-to-github.mjs`。
- 代码里本身也不带任何私人服务默认值：管理器地址、管理密码、邮局地址、邮箱域名全部在扩展面板里填，
  存在浏览器本地存储（`chrome.storage.local`），不落在源码里。

**自动化触发**（`.zcode/config.json`，本机配置、不推送）

| 事件 | 时机 |
| --- | --- |
| `PostToolUse`（`Write\|Edit`） | 每次改完文件立刻推送 |
| `Stop` | 每轮对话结束兜底扫一次 |
| `SessionStart` | 会话启动时补推（覆盖在 ZCode 之外手改的文件） |

- 不推送：`.zcode/`、`.git/`、`.tmp-*`、`node_modules/`；仓库里的 `.gitignore` 也挡了这些。

> 仓库里不含任何密钥：管理器地址、管理密码、API Key 都在扩展面板里填，只存在浏览器本地存储；
> 推送用的 GitHub token 放在仓库目录之外的 `~/.zcode/github-token.txt`（API 方式）和
> `~/.zcode/git-credentials`（git 方式）。

## 文件结构

```
extension/
├── manifest.json    # Manifest V3 配置
├── background.js    # 后台：邮件 API、验证码轮询、批量队列、提示音、账户管理、管理器导入
├── content.js       # 页面脚本：首页点按钮、填表、验证码
├── panel.html       # 常驻侧边栏面板（主界面）
├── panel.css
├── panel.js
├── gam-ui.js        # 运行前配置区块：导入管理器 + 临时邮箱（面板/弹窗共用）
├── gam.css
├── offscreen.html   # 离屏文档（播放成功提示音）
├── offscreen.js
├── popup.html       # 弹窗（旧入口，可随时打开）
├── popup.css
├── popup.js
├── accounts.html    # 账户管理页（含管理器分组/备注列）
├── accounts.css
├── accounts.js
├── test-manager-import.mjs  # 管理器导入逻辑的离线测试（node test-manager-import.mjs）
├── push-to-github.mjs       # 推送脚本：把工作区同步到 GitHub（无需本机 git）
├── .gitignore
└── icons/           # 扩展图标
```

## 流程说明

首页点 Sign up → 跳注册页填表提交 → 等验证码邮件（90s 没到自动点 Resend 催信）
→ 自动填 8 位 launch code → 注册成功保存账户。

注册流程按 `stage`（start → fill → code → done）驱动，跨页面导航状态存在
`chrome.storage.session`，刷新/跳转不会丢进度。

**邮箱已被注册过**（GitHub 提示 `The email you have provided is already associated with an account.`）：

1. 识别到就**直接换一个新邮箱重开这个位置**——后台先清一遍环境（GitHub cookie + 多余标签页），
   再用新邮箱开一个新任务；**批次名额不消耗**（还是同一个位置，不会白跑一个号）。
2. 换邮箱最多 3 次，超过就按「无 token」保存这个账户收尾，避免整批卡死在一步。
3. 任务被标记 `emailTaken` 之后不会再重复提交注册表单（GitHub 只会再报一次同样的错）。
