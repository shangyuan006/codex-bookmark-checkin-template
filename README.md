# Codex Bookmark Check-in

一个可由 Codex 部署的 Windows + Chrome/Edge 每日书签签到模板。它会先询问用户使用的浏览器、配置文件以及签到书签所在的上级文件夹和目标子文件夹，再在每次运行时重新读取这些目录，自动执行签到、登录恢复、验证码/问答处理、异常重试和结果汇总。项目不预设任何用户的文件夹名称。

公开仓库只保存通用引擎和站点适配器。账号、密码、Cookie、PIN、本机路径、签到结果、截图和通知密钥都只留在本机并被 Git 忽略。

## 推荐使用方式

1. 在 Windows 10/11 上准备 Chrome 或 Edge，以及 Codex。
2. 克隆本仓库并用 Codex 打开仓库目录。
3. 对 Codex 说：`按照 AGENTS.md，使用仓库内 deploy-bookmark-checkin 技能为我部署每日书签自动签到。`
4. Codex 会先运行不假设浏览器或文件夹名称的只读环境预检，并列出 Chrome/Edge 候选书签目录。存在环境缺项时，它会解释影响和可选补全方式。
5. 在读取签到目标前，Codex 会优先询问使用 Chrome 还是 Edge、哪个浏览器配置、哪个上级书签文件夹、哪些目标子文件夹；确认后才验证范围并继续其他问卷。不要在对话或配置文件中提供明文密码、Cookie、Token 或 PIN。
6. Codex 完成可见登录测试、逐站验收、异常恢复测试和隐藏调度安装后，才会宣布部署完成。

也可以先手动运行只读预检：

```powershell
pwsh -NoProfile -File .\scripts\Test-Environment.ps1
```

确认文件夹名称后，可再次验证所选范围：

```powershell
pwsh -NoProfile -File .\scripts\Test-Environment.ps1 `
  -Browser Edge `
  -ContainerFolderNames '你的上级文件夹' `
  -TargetFolderNames '目录一','目录二'
```

## 运行模型

- 每次启动动态读取书签，因此后续新增书签会自动进入下一次任务。
- 原生 WAF/托管验证预热只访问当前书签目标及站点规则显式声明的关联来源；公共配置中的预热地址只是可匹配规则库，未命中本次书签范围时全部跳过。
- 可见手动登录使用独立用户目录的最小原生 Chrome/Edge，不经过 Playwright 或远程调试；手动目标只接受 origin 或待处理序号，实际网址始终从当前书签重新解析。运行 `scripts\Close-ManualLogin.ps1` 会正常关闭窗口并让 Cookie、CF 通行状态和站点存储落盘，同时生成本地待复核记录；下一次 `Run-Checkin.ps1` 会定向重跑这些站点，并以页面或接口证据更新结果，不会把人工点击本身当作成功。
- 对自动化特征敏感的 CF 站点，可在被 Git 忽略的 `config/config.local.json` 预热项中设置 `"passiveOnly": true`。该模式只用无 CDP 的原生浏览器等待并保存会话，等待本身只算 `prepared`，不能作为签到成功证据。
- 对点击后由原生浏览器自动完成 CF 验证并刷新结果的站点，可在本地 `nativeChallengePreflight` 项中配置 `action`：用精确按钮文本执行唯一同源签到动作，按有限次数关闭公告，并在 `waitSeconds` 内等待页面自动刷新。只有页面明确显示今日已签到才记为成功；按钮不唯一、跨来源导航、验证未完成或仅发生点击都会失败关闭并交回常规复核。
- 对必须退出并重新通过 OAuth 登录才发放每日额度的站点，可在被 Git 忽略的 `config/config.local.json` 中配置 `reauthCheckinRules`。流程每天最多退出一次，中断后从本地阶段继续而不会重复退出；只有登录前后额度严格增加，或站点存储中的明确布尔到账信号符合规则时，才会判定 `signed`。本地状态只保存日期、阶段和更新时间，不保存额度、Cookie、Token、页面正文或 OAuth 截图。
- 相同来源和相同逻辑签到入口会去重，仍为每个书签保留结果。
- 内置适配器覆盖 NexusPHP、New API、Linux DO OAuth、图片验证码、站内问答、Cloudflare/Turnstile，以及将“申请额度”作为每日签到动作的公益站流程。
- 未知站点先走通用入口发现；Codex 只把经过页面成功确认的规则写入本机 `config/config.local.json`。
- 单站重试、异常复查和任务级断点续跑只重新访问未确认目标。
- 限频站点会记录 `nextEligibleAt` 并按时间定向补跑；超时续跑只接受当天的新检查点，避免复用旧日报或重复整批执行。
- Windows 计划任务从签到时间起按小时做无副作用探测，用户级调度器按分钟探测；两者都受每日次数上限和运行锁保护。
- 主浏览器配置只作为只读来源；后台运行和可见原生登录始终使用独立配置，不直接控制用户正在使用的主浏览器窗口。
- 默认不配置外部通知。用户可选择安全的命令型通知器，敏感值应从环境变量或凭据管理器读取。
- 主浏览器保存密码同步和外部问答搜索默认关闭；初始化问卷获得明确授权后才启用，未授权时不会读取密码库或访问搜索引擎。
- 机器人浏览器默认关闭 Chromium 的本地大模型下载；限频重试采用有界指数退避，达到当日上限后转到次日计划时间，避免空转。

浏览器保存密码和 OAuth 都无法恢复的站点，可选择使用 Windows DPAPI 凭据。运行 `scripts\Set-ProtectedSiteCredential.ps1 -Origin https://example.com` 交互录入，用户名和密码不会显示；密文只写入被 Git 忽略的 `data\credentials\`，且仅能由当前 Windows 用户解密。随后在本机 `config/config.json` 的 `protectedCredentialOrigins` 中加入站点，并按需配置 `protectedLoginVerificationPaths`。登录器只通过子进程标准输入接收临时明文，不写命令行或日志；登录后的 Cookie 和站点会话由独立 Edge/Chrome 配置目录加密持久化，不另行导出 `localStorage` 或 `sessionStorage`。

## 目录边界

- `config/site-rules.public.json`：可公开复用的站点规则。
- `config/config.json`：由初始化流程生成的本机配置，不提交。
- `config/config.local.json`：本机新增适配规则，不提交。
- `config/config.local.example.json`：私有站点规则示例。
- `data/`、`logs/`、`tmp/`、`outputs/`：本机状态、日志、截图和结果，不提交。
- `skills/deploy-bookmark-checkin/`：供 Codex 使用的部署技能。

## 开发与检查

```powershell
npm.cmd install
npm.cmd test
pwsh -NoProfile -File .\scripts\Scan-PublicSafety.ps1
```

机器人浏览器未运行时，可先只读查看可清理缓存；确认后再显式应用。脚本只允许操作项目 `data` 下的独立资料目录，不删除 Cookie、保存密码、站点存储、IndexedDB 或 Service Worker：

```powershell
pwsh -NoProfile -File .\scripts\Clear-AutomationChromeCache.ps1
pwsh -NoProfile -File .\scripts\Clear-AutomationChromeCache.ps1 -Apply
```

不使用 GitHub 时，可在完成本地提交后生成只包含 Git 已跟踪文件的安全分享包：

```powershell
pwsh -NoProfile -File .\scripts\Export-PublicBundle.ps1
```

升级旧部署后，可运行 `node src\repair-local-results.mjs` 清理历史结果中的奖励额度数值，并将当天后续定向补跑的权威终态合并进完整日报。原始分次报告仍保留，合并不会用错误、延迟或未确认状态覆盖已确认结果。

项目目前面向 Windows 10/11 与桌面版 Chrome 或 Edge。电脑休眠或关机错过计划时间后，用户级调度器会在当天恢复登录后补跑。

自定义通知器应接受参数数组，支持 `{status}`、`{summary}`、`{taskId}`、`{name}`、`{source}` 和 `{eventKey}` 占位符。`{eventKey}` 按“日期 + 站点状态指纹”生成：相同结果重复执行会去重，异常解决后的新结果仍可发送。`executable` 只直接接受原生 `.exe/.com`；脚本通知应使用 `pwsh.exe -File script.ps1` 或 `node.exe script.mjs` 的参数形式，避免站点文本经过命令解释器。通知先原子写入本地 `data/notification-outbox`，再由独立投递器执行命令；命令需返回包含 `accepted=true` 或 `duplicate=true` 的 JSON 才算送达。缺失或不匹配 `payloadHash` 的条目会进入 `quarantine`，失败只按退避时间重发通知，不会重新运行浏览器签到。`mode=none` 和预览模式不会发送、也不会创建 outbox 条目。实现不会使用 `Invoke-Expression`，也不会读取任何 Telegram Bot Token。

签到进程锁同时校验 PID、进程启动时间和随机 nonce。进程崩溃、PID 被系统复用或外层超时强杀后，旧锁会安全回收；仍在运行的签到进程会继续阻止并发访问同一个自动化浏览器配置。
