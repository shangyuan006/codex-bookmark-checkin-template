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
- 可在主 `bookmarksPath` 之外配置 `additionalBookmarkSources`，为每个 Chrome/Edge 来源分别指定上级文件夹、目标子文件夹和是否可选；也可以直接使用带独立范围的 `bookmarksPath` 来源数组，但两种形态不能混用。运行时会跨来源按精确 URL 和 origin 去重，每个来源可独立回退自己的 `.bak`；若目标数相对上次有效计划骤降超过一半则拒绝生成误导性的空结果。人工登录交接始终只读当前主文件，不会从备份恢复已被用户替换的旧网址。
- 仅当目标尚未写入浏览器书签时，才在被 Git 忽略的 `config/config.local.json` 中使用 `configuredTargets`。每项 `url` 必须是无用户名、密码等内嵌凭据的 HTTPS 地址，`folderName` 必须属于已经确认的 `targetFolderNames`。这些条目会并入签到计划并扩展浏览器实际导航和网络访问范围，不只是为现有书签补充候选路径；修改后应重新运行预检和完整验收。
- 原生 WAF/托管验证预热只访问当前书签目标及站点规则显式声明的关联来源；公共配置中的预热地址只是可匹配规则库，未命中本次书签范围时全部跳过。`nativeWafPreflightUrls` 默认只算 `prepared`，只有经过验证的访问即签到端点才可显式设置 `"trustAsSigned": true`。个别站点可设置位于项目 `data/` 下的 `automationUserDataDir` 使用独立 Edge/Chrome Profile；该目录不能与全局、Agent Router 或其他站点 Profile 冲突，健康检查会验证存在性和唯一性。
- 可见手动登录使用独立用户目录的最小原生 Chrome/Edge，不经过 Playwright 或远程调试；手动目标只接受 origin 或待处理序号，实际网址始终从当前书签重新解析。人工交接会在不降级完整日报权威终态的前提下，读取当天最新定向结果中的登录或验证状态，因此定向诊断不会再与完整日报脱节。自动交接不会为 `no_action` 主动弹窗，但可按当前书签 origin 显式选择此类未确认站点。窗口关闭脚本把记录时间和浏览器进程启动时间统一转换为 UTC 后再核对进程身份，避免 UTC+8 环境把仍在运行的正确窗口误判为失效。运行 `scripts\Close-ManualLogin.ps1` 会正常关闭窗口并让 Cookie、CF 通行状态和站点存储落盘，同时生成本地待复核记录；下一次 `Run-Checkin.ps1` 会定向重跑这些站点，并以页面或接口证据更新结果，不会把人工点击本身当作成功。明确放弃本次人工目标时可使用 `scripts\Close-ManualLogin.ps1 -Abandon`：脚本只在被 Git 忽略的 `tmp` 状态中记录当天日期和 origin，停止当天调度补跑，次日自动失效。
- 对自动化特征敏感的 CF 站点，可在被 Git 忽略的 `config/config.local.json` 预热项中设置 `"passiveOnly": true`。该模式只用无 CDP 的原生浏览器等待并保存会话，等待本身只算 `prepared`，不能作为签到成功证据。
- 对点击后由原生浏览器自动完成 CF 或雷池验证并刷新结果的站点，可在本地 `nativeChallengePreflight` 项中配置 `action`：用精确按钮文本执行唯一同源签到动作，按有限次数关闭公告；出现同源雷池 `#sl-check` 合法用户控件时会有界点击一次并等待其解除，再在 `waitSeconds` 内等待页面刷新。只有页面明确显示今日已签到才记为成功；按钮不唯一、跨来源导航、验证未完成或仅发生点击都会失败关闭并交回常规复核。
- 对只在原生浏览器中保留有效会话的 New API 站点，可在本地 `nativeChallengePreflight` 项中配置 `"newApiCheckin": true`，并将同一 origin 加入 `newApiCheckinOrigins`。该模式只调用同源签到接口，且必须由签到状态接口返回 `signed` 或 `already_signed` 才算成功；页面文字、按钮状态和一次 POST 成功都不能替代接口复核。
- 对必须在原生 Edge 的同一个会话内完成 OAuth 与 New API 签到的站点，可将 origin 加入本地 `nativeOAuthCheckinOrigins`，同时配置 `automaticOAuthProviders`、`oauthLoginUrls`、`savedLoginSessionRules` 和 `newApiCheckinOrigins`。恢复器只为当前书签目标启动短生命周期的本机调试端口，登录后立即签到并由状态接口确认，随后关闭浏览器；不会导出 Cookie、Token 或页面存储，默认配置保持关闭。
- 对必须退出并重新通过 OAuth 登录才发放每日额度的站点，可在被 Git 忽略的 `config/config.local.json` 中配置 `reauthCheckinRules`。流程每天最多退出一次，中断后从本地阶段继续而不会重复退出；只有登录前后额度严格增加，或站点存储中的明确布尔到账信号符合规则时，才会判定 `signed`。本地状态只保存日期、阶段和更新时间，不保存额度、Cookie、Token、页面正文或 OAuth 截图。
- 对无法直达签到页、必须通过头像菜单等站内控件进入的站点，可在本地配置 `preCheckinNavigationRules`。每一步只能使用唯一可见的 CSS 选择器或精确 role/name，执行前后均校验书签允许的同源范围，且最终路径必须与配置完全一致；导航本身不作为签到成功证据。原生 Edge 人工接管会为本次目标生成只匹配对应来源的临时导航扩展，不启用 Playwright 或远程调试端口，窗口关闭后立即删除扩展文件。
- Agent Router 可为同一书签 origin 配置多个隔离账号。每个账号使用稳定的匿名 `accountKey`、固定公开 OAuth 提供方名、独立浏览器目录和状态文件；账号 origin 必须是无路径、查询参数或片段的规范 HTTPS origin，浏览器目录和状态文件必须位于项目 `data` 子目录。旧配置中的 `accountId` 仍按本地 key 兼容。日报仍按一个站点计数，但会保存匿名嵌套账号状态，只有全部账号都得到权威 `signed`/`already_signed` 证据且 provider 与当前账号计划一致时父结果才成功。自由文本账号标签和站点权威账号 ID 不会写入结果；`accountKey` 只使用 `github`、`linuxdo` 这类匿名别名，不要填写邮箱、用户名或真实姓名。
- Agent Router 的 LinuxDO 恢复必须严格分两阶段，禁止一次打开两个站点：正常自动签到会先在同一隔离目录执行供应商阶段并关闭上下文，再执行 Agent Router 阶段；若自动化冷启动仍无法确认已有 LinuxDO 会话，会额外执行一次无 CDP、离屏、有限等待且不点击页面的原生 Edge 会话唤醒，正常关闭后重新探测，仍未确认才交给人工。人工恢复先运行 `Open-AgentRouterLogin.ps1 -AccountKey linuxdo -ProviderOnly`：脚本会立即、1 秒后和 2.5 秒后至多三次通过浏览器请求探测固定的 `linux.do/session/current.json`；仍未确认时，还会在同一隔离 Edge 的后台页面访问 LinuxDO 首页，再由页面内请求读取该固定端点，以纠正冷启动时请求上下文尚未读取加密会话的假阴性。CF challenge、HTML 错误页、无效 JSON 和非会话 JSON 不会判为未登录；同一探针遇到明确 CF 或 429 时停止重复请求，但仍允许另一种探针确认有效会话。浏览器不会直接导航到 JSON/404 页面，且只有规范化后的会话状态及 CF、限流布尔标记会离开页面上下文。请求探针或后台页面任一确认有效就不打开 LinuxDO；只有两种探针都明确无效才打开登录页。`unknown` 且已观察到 CF 拦截时，人工交接会自动打开一个同 Profile 的原生无 CDP LinuxDO 首页窗口处理验证，不会把接口拦截当成登录失效；没有 CF 证据的网络失败或纯限流仍暂停，不误开登录窗口。用户明确要求真实退出重登录验收时，可显式增加 `-OpenProviderWhenIndeterminate`，只打开一个同 Profile 的原生无 CDP LinuxDO 窗口供人工确认，不会把不确定探针或打开页面当作登录成功。启动器遇到专用窗口异常退出留下的临时状态时，只会在确认该隔离 Profile 已无 Edge 进程后清理状态，不会覆盖仍在运行的窗口。探针结果只在被忽略的本地日志中记录阶段、最终状态、次数、耗时、HTTP 状态、响应类型以及 CF、限流标记，不记录账号身份、Cookie 或响应正文。自动任务产生 Agent Router 待处理交接时，调度器会读取匿名未完成 `accountKey`，依次启动 ProviderOnly、AgentRouterOnly 和一次 Complete 复核；若普通人工复核与 Agent Router 交接同时存在，也会继续启动 Agent Router 专用阶段；进程列表不可读时会暂停启动以避免重复窗口。普通人工入口只接收其他站点，不会误开普通 LinuxDO 页面。
- 完成真实 LinuxDO 登录后运行 `Close-AgentRouterLogin.ps1 -AccountKey linuxdo` 保存隔离配置中的会话，再运行 `Open-AgentRouterLogin.ps1 -AccountKey linuxdo -AgentRouterOnly`。第二阶段先读取当前账号的当日签到进度：已完成则同步日报并结束；尚未退出则接回完整每日签到流程；已退出且有本轮证据重置记录才接续 OAuth。需要继续登录时，会再次确认并在后台固定端点唤醒 LinuxDO 会话，关闭该页后才执行 Agent Router OAuth；如果提供方把已登录会话带回 LinuxDO 首页，流程会在同一个 OAuth 页面内最多三次重进 Agent Router，不并行打开新页面。LinuxDO 登录提交后只等待当前页面完成 CF 真人验证或离开登录页；已观察到验证框或已提交登录时不会再次点击登录、重启 OAuth 助手、执行原生会话唤醒或刷新页面，避免把正在进行的人工验证重置。流程仅在精确匹配的 LinuxDO 官方授权页检测到 Cloudflare 验证框时，才临时允许该授权来源上的唯一验证控件进行有限等待和点击；无法点击或验证未解除时分别报告专用阶段，再切换到无 CDP 的原生 Edge 人工入口。离屏自动 OAuth 未完成且其进程已完全关闭时，启动器会先用同一隔离 Profile 做一次权威目标状态复核；只有本账号当天的有效退出记录和本轮新产生的成功标记相互印证，才进入 `PostOAuthVerify`，保存账号完成记录并合并日报后结束，不打开人工窗口，否则才打开一个无 CDP、无 Playwright 的原生 Edge 窗口供人工通过 CF 或授权；启动器按本轮随机标记重新绑定真实浏览器 PID，等待唯一可见窗口连续稳定后将其前置，稳定性确认失败时不会记录或报告人工窗口已打开。流程不会保留 Playwright 可见窗口反复触发验证，也不会同时打开第二个窗口。OAuth 一旦返回目标站，`Complete-AgentRouterLogin.ps1` 只执行一次 `PostOAuthVerify` 账号定向权威复核；复核阶段不会发起第二次 OAuth，最终账号结果必须为 `signed` 或 `already_signed`，不会仅凭页面跳转报告成功。GitHub 账号仍使用 `Open-AgentRouterLogin.ps1 -AccountKey github` 的单阶段入口；自动流程可让独立 Profile 的密码库填充 GitHub 登录字段，但只读取“是否已填充”的布尔值，不读取账号或密码，遇到账号选择、2FA、设备验证或 Passkey 时立即转人工。普通站点入口 `Open-ManualLogin.ps1` 不接受 Agent Router origin，避免误用普通机器人配置；不要用普通入口代替专用账号入口。
- 重认证不会单凭浏览器中留存的成功布尔值判断今日签到。退出前仅重置配置指定的成功标记，保留其他登录字段；恢复只接受本账号、上海时区当日且时间不在未来的阶段记录。缺失、旧日、未退出或未重置证据的记录须重新执行完整流程；验证或日报保存失败会保留待处理状态，不提前清除恢复记录或报告完成。
- LinuxDO SSO 的 iframe 坐标回退默认关闭，不会进入每日计划任务。需要诊断时可显式运行 `Test-AgentRouterLinuxDoTurnstile.ps1 -AccountKey linuxdo`：脚本先完成供应商会话阶段，再在精确的 `linux.do/session/sso_provider` 页面上尝试一次实验流程。它优先点击唯一语义 checkbox/label；仅在没有语义控件、Cloudflare iframe 唯一且边框宽 180–500 像素、高 40–180 像素时，才按斑马规则点击一次左侧复选框区域。结果只报告固定分类，不记录 iframe 地址、坐标、页面正文或截图；点击后仍必须完成官方“允许”授权并由 Agent Router 返回 `signed` 或 `already_signed`，否则实验不算成功。
- 君の公益等 New API 站点如果前面有 Cloudflare，必须先通过 CF/托管验证，之后页面和 New API 接口才会加载；New API 适配器不能绕过站点前置 WAF。通过 CF 后再复用保存的会话进入个人页并点击“立即签到”，最终以页面或接口权威证据确认。
- 相同来源和相同逻辑签到入口会去重，仍为每个书签保留结果。
- 内置适配器覆盖 NexusPHP、New API、Linux DO OAuth、图片验证码、站内问答、Cloudflare/Turnstile，以及将“申请额度”作为每日签到动作的公益站流程。托管验证达到有限等待上限后会刷新一次并再次读取权威签到状态；只有刷新后仍未确认才进入低频重试。显式配置的 New API 验证码流程复用本地 OCR，并固定校验五位候选；OpenCD/Nexus 六位 OCR 低于置信度门槛时拒绝提交。U2 作品封面优先查询 AniList，只有候选不足时才为缺失选项查询 MyAnimeList，并只接受标题匹配的官方 CDN 图片。普通页面明确显示签到当前关闭、暂停或未开放时，本次访问记为 `not_available`，但不会据此假设站点永久停运或自动加入长期缓存名单。直接签到流程在提交前后读取同源状态、日志或额度。HTTP 成功、按钮点击或响应提示本身都不能作为签到成功证据。
- 保存密码和凭据登录可按 origin 显式启用条款确认与有限 Turnstile 等待/点击。辅助流程在提交前后都检查同源、控件唯一性和挑战就绪状态；未明确通过时返回待处理，不继续提交。原生 CDP 检查采用有限连接重试，且不会把页面正文或账号标识写入父进程结果。
- 未知站点先走通用入口发现；Codex 只把经过页面成功确认的规则写入本机 `config/config.local.json`。
- 单站重试、异常复查和任务级断点续跑只重新访问未确认目标。需要显式复核已人工确认的站点时，使用 `scripts\\Run-Checkin.ps1 -Origins https://one.example,https://two.example -Attempts 1`；参数只接受当前书签中的规范 HTTPS origin，选中站点取得 `signed`/`already_signed` 后会写入分次报告并提升到当天累计日报，不再使用不会落盘的临时诊断调用。今天已放弃的 origin 会被定向运行拒绝；确认确需重新访问时，必须同时显式增加 `-OverrideTodayAbandonment`，该开关不能脱离 `-Origins` 单独使用。`-DryRun` 仍可检查选择范围，不受今日放弃状态影响。
- 限频站点会记录 `nextEligibleAt` 并按时间定向补跑；共享 OAuth/上游故障会按配置分组熔断，上午达到上限后仍保留当天 `21:05` 的最后一次恢复机会，晚间仍失败才转到次日。超时续跑只接受当天的新检查点，避免复用旧日报或重复整批执行。
- 自动签到发现需要人工处理的站点时，会在所有自动尝试结束后向 `tmp/manual-handoff.json` 写入当天的待接管状态；交接调度仅在运行锁释放后启动，人工窗口仍在处理时不会另起自动尝试。用户级调度器启动人工入口前也会核对同一运行锁，避免与自动重试争用浏览器。关闭手动窗口生成权威复核记录后，调度器会立即定向补跑，未完成的复核按退避继续，不会因为自动阶段结束而丢失流程状态。若前台直接运行 `scripts\Run-Checkin.ps1`，增加 `-DispatchManualHandoff` 会在自动阶段结束后启动一次交接调度；后台调度器无需传入该开关。
- Windows 计划任务从签到时间起按 `schedulerProbeIntervalMinutes` 做无副作用探测，健康检查会核对实际动作和整日触发器；计划任务空闲时不要求常驻 heartbeat。回退用户级调度器前会停用旧计划任务，并且只清理确属本项目的启动入口；两种模式都受每日次数上限和运行锁保护。
- 主浏览器配置只作为只读来源；后台运行和可见原生登录始终使用独立配置，不直接控制用户正在使用的主浏览器窗口。
- 默认不配置外部通知。用户可选择安全的命令型通知器，敏感值应从环境变量或凭据管理器读取。
- 主浏览器保存密码同步和外部问答搜索默认关闭；初始化问卷获得明确授权后才启用，未授权时不会读取密码库或访问搜索引擎。同步器只复制已保存的加密记录，并报告有记录与缺记录来源数量；缺少保存记录时仍需在主浏览器中完成一次交互式登录并允许浏览器保存密码。
- 机器人浏览器默认关闭 Chromium 的本地大模型下载；限频重试采用有界指数退避，达到当日上限后转到次日计划时间，避免空转。

浏览器保存密码和 OAuth 都无法恢复的站点，可选择使用 Windows DPAPI 凭据。运行 `scripts\Set-ProtectedSiteCredential.ps1 -Origin https://example.com` 交互录入，用户名和密码不会显示；密文只写入被 Git 忽略的 `data\credentials\`，且仅能由当前 Windows 用户解密。随后在本机 `config/config.json` 的 `protectedCredentialOrigins` 中加入站点，并为每个来源配置同源 HTTPS 的 `protectedLoginVerificationPaths`；缺少权威验证路径会失败关闭，不再把普通页面返回 200 当作已登录。登录器复用保存密码登录的表单展开规则，并只输出固定的登录阶段码；从 Windows PowerShell 5.1 启动且检测到 PowerShell 7 时会优先转交 PowerShell 7，避免受污染的模块路径阻断 DPAPI。临时明文只通过子进程标准输入传递，不写命令行或日志；登录后的 Cookie 和站点会话由独立 Edge/Chrome 配置目录加密持久化，不另行导出 `localStorage` 或 `sessionStorage`。

### LinuxDO 接管防误判

- 自动 OAuth 与专用人工入口共用会话探针。后台页面遇到 CF 时，先在当前页面内被动等待最多 20 秒，不刷新、不重新导航、不连续请求受拦截接口；正常 Discourse 内容连续稳定 2 秒后，只补读一次固定会话端点。页面加载完成不等于登录有效，仍必须取得会话 JSON 的明确有效结果。遇到 429 时不进行这次等待或补读。
- 调度器使用 `Open-AgentRouterLogin.ps1 -AccountKey linuxdo -ProviderOnly -ContinueToAgentRouter`。探针确认登录有效后立即关闭供应商上下文并接续 Agent Router，不再等下一次调度或要求用户重新登录。手动调用不带此选项时仍保留独立两阶段操作。
- 调度器按账号配置的提供方分派：GitHub 使用不带 LinuxDO 阶段参数的单阶段入口，LinuxDO 才使用上述供应商和目标站两阶段入口。账号选择同时核对当前待处理目标的 origin 和匿名 key，不猜测旧交接中缺失的账号。
- 必须人工处理时仍只打开一个原生无 CDP 的隔离 LinuxDO 窗口。连续入口会等待用户关闭窗口最多 10 分钟，随后重新探测会话；关闭窗口本身不是登录成功证据。只有复核有效才记录供应商阶段并继续目标站。等待到期不会强制关闭窗口，调度器也能接续稍后已关闭的专用阶段。
- 关窗后先原子保存 `provider_pending` 阶段，再移除活动窗口记录。CF、网络失败、未知结果或探针中断不会丢失恢复位置，也不会重复打开 LinuxDO；调度器只在到期后复核。重试等待按 2、4、8、16 分钟递增，最长 30 分钟，限流时至少等待 10 分钟；直接重调打开或关闭入口也遵守这项退避。有效会话接续 Agent Router，明确失效才允许回到供应商登录。LinuxDO 等待期间仍可接管待处理的 GitHub 账号，不影响普通站点入口。阶段文件仍被 Git 忽略，仅保存匿名 key、本地 Profile 引用、固定状态码、次数和时间，不保存身份或凭证。
- 探针日志仅增加页面稳定等待结果和关闭后的复核阶段，不记录页面正文、身份或凭证。最终签到完成仍由 Agent Router 账号的权威结果确认，供应商登录有效不等于签到完成。

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
npm.cmd run health
pwsh -NoProfile -File .\scripts\Scan-PublicSafety.ps1
```

`npm run health` 输出带 `schemaVersion`、`failedChecks` 和当前计划计数的 JSON：退出码 `0` 表示当天完整结果与当前书签及嵌套账号计划一致，`2` 表示未初始化或检查未通过，`3` 表示健康检查自身执行失败。它会逐一验证所有必需书签来源的主文件或独立 `.bak`，缺失的可选来源不单独判为故障；健康检查只读，不会启动签到或恢复已暂停的调度。

GitHub Actions 使用只读仓库权限和固定 commit 的 Actions，除测试、公开安全扫描和依赖审计外，还会下载固定版本且校验 SHA256 的 Gitleaks，对完整 Git 历史做脱敏密钥扫描。

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

自定义通知器应接受参数数组，支持 `{status}`、`{summary}`、`{taskId}`、`{name}`、`{source}` 和 `{eventKey}` 占位符。`{eventKey}` 按“日期 + 站点状态指纹”生成：相同结果重复执行会去重，异常解决后的新结果仍可发送；嵌套账号状态变化也会产生新的指纹。同一任务和日期只投递最新待发送事件，旧事件标记为 `superseded`；已送达条目按 `outboxRetentionDays` 清理。`executable` 只直接接受原生 `.exe/.com`；脚本通知应使用 `pwsh.exe -File script.ps1` 或 `node.exe script.mjs` 的参数形式，避免站点文本经过命令解释器。通知先原子写入本地 `data/notification-outbox`，再由独立投递器执行命令；命令需返回包含 `accepted=true` 或 `duplicate=true` 的 JSON 才算送达。缺失或不匹配 `payloadHash` 的合法 outbox 条目会进入 `quarantine`，失败只按退避时间重发通知，不会重新运行浏览器签到。`mode=none` 和预览模式不会发送、也不会创建 outbox 条目。实现不会使用 `Invoke-Expression`，也不会读取任何 Telegram Bot Token。

签到进程锁同时校验 PID、进程启动时间和随机 nonce。进程崩溃、PID 被系统复用或外层超时强杀后，旧锁会安全回收；仍在运行的签到进程会继续阻止并发访问同一个自动化浏览器配置。

## 手动接管中的今日放弃

定向签到、账号复核和原生预热使用同一个目标范围，并排除当天放弃的站点。长期不再参与签到的站点可在本机 `config/config.local.json` 的 `disabledCheckinOrigins` 中填写规范 HTTPS origin，并同步到生成的 `config/config.json`；这些来源不会成为签到目标、关联候选页面或人工接管目标。取消停用时删除对应配置项即可，收藏夹本身不受修改。

第二轮自动补跑的预热范围直接取自本轮执行参数。原生签到逐站原子保存检查点，明确的完成证据在关闭浏览器前先保存；后续站点或关窗失败不会丢失前面的确认。当天确认结果会合并保留，重试跳过已确认站点，主流程在 OAuth 和浏览器启动前先将选中站点的确认写入进度；普通预热、点击和等待不算完成。每条确认保留原始时间，拒绝前一天或未来证据，不因超过十分钟而重复签到；定向运行结束也保留其他站点的当天确认。保存失败仍在 finally 中尝试关窗，若关窗也失败则保留原始错误并报告清理失败。超时清理会先记录进程树及启动时间，即使父进程在正常关窗期间退出，也会核对身份并清理已记录的独立子进程。

New API 的登录探测失败时，会同时检查页面：明确的已签到控件可确认完成，可用的签到控件允许继续页面流程；可见登录表单仍要求登录。已提交请求但无法复核时保留待确认状态，避免自动重复提交。接口明确返回未启用签到时，结果包含来源、时间和关闭证据；缺少证据的 `unconfirmed` 与仅点击的 `clicked`、仅访问的 `visited` 均可进入人工接管。

登录恢复成功后，若该站点配置了带 `action` 或 `newApiCheckin` 的 `nativeChallengePreflight`，自动复查会先接续原生签到，并读取同站点的当天确认；其他保存登录恢复也会在同一个恢复上下文中强制重新导航复核一次，只有复核仍无权威证据时才进入 `deferred`。这样不会在登录已恢复后直接把本轮签到留到下一次任务，也不会切回另一种浏览器会话反复判定未登录。

原生按钮或链接入口可以等待延迟加载，实际点击后重新开始完整的结果确认等待，不使用猜测路径代替可见入口。预热项可用 `maxAttempts: 1` 限制重开窗口；默认最多两次。明确的雷池“客户端异常，请确认您是合法用户”会标记为交互验证和 `retryable: false`，停止后续候选地址、自动复查及任务级预热重试，并保留人工接管。原生预热发现的阻塞通过本轮唯一标记交给主流程，不会紧接着用普通浏览器再次访问；旧轮次的阻塞不能拦住人工处理后的首次定向复核，次日也不会复用。该状态不能作为正文已加载或签到成功证据。

登录自动恢复后再次执行的原生签到也使用独立的本轮标记读取阻塞记录，保留雷池错误码及 `retryable: false`，不降级成普通未确认结果而触发第二轮预热。其他站点、旧轮次及过期阻塞不会混入本次恢复；同日权威成功证据仍优先保留。

### 证据、API 执行与站点周期

终止路径和消失的入口默认只停止操作，返回待处理，不能直接生成已签到结果。只有用户明确确认了这种站点约定，才能在私有 `preCheckinNavigationRules` 对应项加入 `terminalAssumeSigned: true`；此时证据来源标为 `user_rule`，不会冒充页面或接口的权威确认。已有此类私人约定应显式迁移，不要把例外写入公共默认配置。`visitCheckinRules.after` 默认只控制开放时间，访问后还需等待明确完成文字。对于用户明确确认的“登录访问即签到”站点，可在该站私有规则中加入 `assumeSignedAfterVisit: true`，并配置 `savedLoginSessionRules`：仅在开放时间内、页面就绪且无未完成验证、登录会话核查有效时按 `user_rule` 记为完成；登录失效或状态未知不会误报成功。

对于“首页签到入口消失即完成”的私人约定，可同时设置 `terminalRequireAuthenticatedPage: true` 与 `terminalMissingControlPaths`（精确同源首页路径，默认 `/`、`/index.php`）。程序会核查完整加载、可见退出控件、无密码表单或未完成验证，并连续两次确认入口消失；加载不完整、未确认登录、入口重新出现或页面跳转都保留待复核状态。页面正文或完成控件确认成功时记录 `page_text` 证据，不保留奖励数值或正文；仅有成功标题不能确认完成。同日定向复核即使状态仍是“已签到”，也能以有效且不早于原记录的更强证据替换人工确认，已完成状态不会因此降级。

日报合并会先校验新结果的完成证据，包括未确认状态提升和新增书签扩充；缺少证据、未知来源、无效或未来观察时间都不能合并为成功。有效的显式私人约定仍可使用 `user_rule`。旧日报的已有记录保持不变，不按状态字符串伪造补填证据。

普通人工窗口在启动前写入忽略的 `tmp/manual-handoff-launch.json`，记录启动标记及进程身份。窗口助手继续持有自动任务使用的互斥锁，直到人工会话写好或启动失败；启动期间不能再开自动任务或重复人工窗口。进程退出或 PID 被复用时，旧启动标记不再阻塞后续任务；状态损坏或进程无法核实时保持保护状态。Agent Router 专用分阶段入口不使用这个普通窗口启动标记。

GitHub 保存登录恢复只在同时包含账号和密码字段的唯一表单内查找提交按钮，其他表单的提交控件不影响定位。GitHub OAuth 授权页不会被当成密码登录页；诊断区分未自动填充、账号选择、二次验证、表单不唯一和提交后仍未登录，只记录固定阶段码，不读取或输出凭据。需要人工处理的明确阶段会停止账号内部的重复登录尝试。

读取签到状态或滑块结构时，若导航使页面执行上下文失效，会在当前来源内有限等待并重新读取，最多三次；旧页面的成功内容不会与新页面混用。该恢复仅重做只读观察，不重复点击、拖动、导航或提交，页面关闭、跨来源跳转和其他错误仍会停止处理。

New API 的浏览器协议代码独立放在 `src/new-api-browser.mjs`，HTTP 和浏览器适配器共用探测、执行、复核接口。新适配器成功结果由 `checkin-evidence.mjs` 校验证据来源和观察时间；未知能力继续走页面流程。既有其他站点适配器和旧日报兼容保留，历史记录没有证据字段时，状态页显示空缺，不伪造补填。

可在忽略的 `config/config.local.json` 配置 `apiFirstOrigins`，仅选择已在 `newApiCheckinOrigins` 中声明的普通站点。执行器复用隔离浏览器的请求上下文及 Cookie 容器，先查 `/api/user/self` 和签到状态，再决定是否发送一次签到请求；不导出 Cookie，不保存新的凭据。自定义验证码、Bearer、重认证、前置导航、原生验证和顺序动作站点不走这个快捷入口。身份探测失败或接口未知时回到页面；POST 已发送而结果不明确时转人工，不重复提交。此能力默认未启用，需逐站验收后加入名单；结果包含请求数、页面加载数和耗时，不能仅凭源码推断提速比例。

`newApiSignInRules` 可用 `quotaIncludesUsage: true` 启用同语义的 `quota + used_quota` 辅助比较。必须同时有签到接口的成功响应及匹配的预期奖励，或对应奖励日志，才使用这项证据；累计消费回退、字段缺失、单纯总额度增加不能证明签到。重认证规则可配置 `usedQuotaField` 和原始额度单位的 `expectedReward`，记录消费与奖励匹配的布尔诊断；不会因此替代该流程的明确成功信号。原始余额和累计消费值不写入结果。

普通站点可配置独立周期，例如：

```json
{
  "siteCycleRules": {
    "https://api.example.test": {
      "timeZone": "Asia/Shanghai",
      "resetAt": "08:30"
    }
  }
}
```

这表示每日 08:30 至次日 08:30。普通站点成功缓存、原生成功检查点、断点续跑和用户级调度器的到期判断使用相同周期；原始观察时间保持不变，新周期会重新确认。默认不改变已有站点时间。每日失败次数上限、分组熔断和人工暂停仍按既有规则执行。Agent Router 等重认证账号保留专用自然日状态契约，当前拒绝为其配置自定义周期。夏令时跳跃中不存在的重置时刻会明确报错，建议选用该时区稳定存在的时刻。

### 本地只读状态页

状态页会读取当天的本地跳过记录，将仍未解决的站点显示为“今日跳过”，不再显示待人工处理或下次重试；原始错误报告保持不变。记录必须与报告日期及本机当天一致，次日自动失效；明确的已签到或无签到功能结果优先于旧跳过记录。

运行 `npm run status` 生成 `outputs/status.html`；加 `-- --profiles` 可统计项目隔离配置目录的占用空间，不读取其中的登录数据。页面提供搜索和状态筛选，显示完成证据、失败原因、下次重试、人工待处理和已有性能指标；旧结果没有指标时显示空缺。它是本地快照，需重新运行命令刷新，不启动服务器、不开网络端口，也不提供重试、登录或删除按钮。文件包含个人站点列表，位于 Git 忽略目录，应仅在本机查看。

对原生被动等待方案的验收应区分两件事：已签到页面可用于验证“无 CDP 等待 → 正常关窗保存会话 → 只读复核”，但不能证明新的验证挑战能够自动通过。只有未签到时的实际验证取得明确完成信号，才据此启用站点自动签到方案；等待或关闭窗口本身不算签到成功。

用户确认关闭签到功能的来源保存在本地 `knownNoCheckinFeatureOrigins` 中。程序在启动浏览器前生成带配置证据的 `not_available` 结果，并从预热中排除；日报与健康检查也优先显示这项明确结论，不再被当天的旧放弃记录覆盖。恢复签到功能时删除对应配置项。

需要原生页面验证的本地规则可在 `nativeChallengePreflight` 中设置 `nativeMinimal: true`，配合 `action.actionTexts`、`action.clickChallenge` 和 `action.challengeFrameStableMs`。自动任务保留离屏模式；执行前等待 Cloudflare frame 稳定，执行后等待明确完成信号，结果由每日运行统一落盘。登录恢复超时时先正常关闭项目浏览器，再终止辅助进程树；无法确认安全清理时停止该轮，避免继续争用配置目录。

Cloudflare 状态读取同时检查页面选择器和浏览器 frame 树，覆盖位于闭合 Shadow DOM 中的验证组件；仅接受可见的 HTTPS Cloudflare frame。验证响应只在浏览器内转为布尔状态，不记录响应值，也不会将“验证已通过”直接判为签到成功。原生动作会等待迟到的明确签到结果，已签到或登录失效时不继续点击验证框。

LinuxDO 会话探测在同一页面内有限等待验证自动结束，并以固定会话端点复查。等待后仍被 CF 阻塞或受到限流时，登录助手传递专用失败阶段，停止该账号的重复 OAuth 探测和原生预热；如果所有未完成账号都只能人工处理，整站也停止自动任务级重试，但仍保留在人工接管队列。普通网络异常保留原有有限重试，无法确认不等同于登录失效；供应商会话确认并保存后，继续目标站授权及签到证据复核。

原生预热的即时检查点与最终报告使用同一状态分类：读取既有完成信号保留 `already_signed`，明确的新完成信号或本次点击后取得完成确认记录为 `signed`。New API 返回今日已签到时不改写为本次新签到；仅点击、验证通过或未确认的页面不计作成功。

需要防止旧页面误导的站点可在本地 `savedLoginSessionRules` 中显式配置同源会话校验。原生页面加载后先读取权威会话端点：会话失效进入登录恢复，无法确认时不点击签到，尚未加载完成时继续有界等待；只有会话有效且页面允许继续处理，才执行配置的签到动作。未配置的站点保留原有行为。

Bearer 站点可在同一条会话规则中设置 `type: "bearer_refresh"`、`refreshPath` 与 `selfPath`，独立校验登录而不启用直接 API 签到。认证刷新和查询只在浏览器中执行，访问凭证不离开浏览器；这与依赖 Cookie 和用户标识请求头的普通 New API 会话规则分别处理，不能混用。

关闭手动接管窗口时，`scripts\Close-ManualLogin.ps1 -Abandon` 仍会放弃当前会话内的全部目标。多站点会话也可以只放弃其中一部分：`-Selection 2,4` 使用与打开手动会话时相同的 1-based 序号，`-Origins https://one.example,https://two.example` 使用当前会话内的规范 HTTPS origin；`Selection` 与 `Origins` 不能同时使用。脚本会关闭整个机器人专用 Edge 会话，把选中的目标记录为当天放弃，并把未选中的目标继续写入权威复核队列。

当天放弃状态只保存在被 Git 忽略的 `tmp/manual-abandon.json`，次日自动失效。执行器不会再次创建这些目标的人工交接；调度器、统一日报和健康检查会使用同一份严格解析后的状态。日报中的 `abandonedCount`、`selectedAbandonedCount` 和 `selectedSummary.abandoned` 会单独显示今日放弃数量，放弃项不计为签到成功、未开放签到或待处理问题。

没有活动人工窗口时，也可运行 `scripts\Set-TodayAbandonment.ps1 -Origins https://one.example` 直接放弃当天目标而不打开浏览器。该入口只接受当前书签中、当天完整结果里尚未取得权威终态的规范 HTTPS origin，包括上游故障、限流等 `deferred` 结果，不受人工登录窗口的筛选条件限制；已签到、已放弃、跨日或非书签目标会被拒绝。若存在当天有效的待复核记录，所选 origin 还必须属于该记录：选中项会直接从待复核转为今日放弃，未选项继续保留，全部待复核项均已处理时删除该记录。所有目标均具有权威终态的 `verification_complete` 历史记录不会阻挡新的今日放弃操作，也不会被覆盖；伪完成、损坏或过期的待复核记录仍会拒绝操作。

统一日报区分 `feature_disabled`（功能关闭）、`temporary_unavailable`（今日暂不可用）、`task_disabled`（配置停用）和今日放弃。兼容保留 `selectedSummary.not_available` 总数，并新增 `availabilitySummary`、`selectedAvailabilitySummary` 分类计数；不可用类别变化也会更新通知事件键。502/522 等临时错误及疑似取消签到不自动加入永久停用配置，也不计作签到成功。
