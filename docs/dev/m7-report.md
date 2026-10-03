# M7 实施报告

分支 `dev`，起点 a840ea0（M7 plan 提交）。共 4 个提交，每个提交前 `npm run typecheck`、`npm run format:check`、`npm run test:unit` 全部通过。

---

## 提交清单

### 1. `M7a-0: golden tools/list test`

- 新增 `test/mcp/tools-list.test.ts`（标题 "M7a: tools/list output is unchanged"），用 `fakeMcpDeps()` 起 `createServer`，经 `InMemoryTransport` + `Client` 取 `listTools()` 全量结果，与 `test/mcp/fixtures/tools-list.json` 深比较；`JEVPILOT_UPDATE_GOLDEN=1` 时改写金样。
- 金样在**未改动的代码**（起点 a840ea0）上生成。
- 比较用 `JSON.stringify` 后字符串相等：`listTools()` 结果含 `title: undefined` 等键，JSON 序列化会丢弃 undefined 键，从文件读回后 `deepEqual` 会因键存在性差异误报。序列化比较也正是客户端实际收到的形式。
- 本提交只含这两个文件。

### 2. `M7a: split the MCP server into core, dispatch and tool modules`

目录结构完全按计划 2.2：

- `src/mcp/host.ts` — `ToolHost` 类，全部可变状态（sessions、screenshotDirs、creatingScreenshotDirs、busySessions、sessionChains、disconnectedSessions、closingSessions、openingSessions、browser/launching/selectedEngine、closing/closePromise、idleTimer）搬入；`McpDeps` 类型搬入并继续从 server.ts re-export（测试导入路径不变）。
- `src/mcp/dispatch.ts` — 未单独成文件。理由见下方「偏差」第 1 条：registerTool / tools/call handler / result() / failure() / handle() / 错误映射原样搬入 host.ts，职责等价。
- `src/mcp/schemas.ts` — nonempty、httpUrl、requireHttpUrl、abortableNavigation、values、session、runInput、op、closeResultSchema、decideResultSchema、tabsResult 原样搬入。
- `src/mcp/tools/` — index.ts 固定顺序清单（run, resume, observe, act, navigate, tabs, close, decide）+ 每工具一个模块。browser_run 无决策服务的 `noDecisionPort()` 分支与 `too_many_sessions` 结果对象按计划留在 tools/run.ts。
- `src/mcp/server.ts` — 只剩组装：建 ToolHost → 按序挂载 → 惰性建 McpServer → 返回 `{server, createMcpServer, close}`；`createMcpServer()` 每次重放全部注册并共享同一 host 状态。

逐段照搬核对过 `runNewSession`、`sessionDir`、`closeSession`、sweepIdle、markBrowserDisconnected、inSession、close() 的每个检查顺序；金样测试原样通过。

新增测试 `test/mcp/architecture.test.ts` 两条（标题照抄计划 2.5）："tool modules import only allowed modules"、"tool modules keep no module-level mutable state"。

测试总数：改前 695 → 698（+3），0 失败。

### 3. `M7b: browser_screenshot and tool toggles`

- **engine**：`PageHandle.capture?()` 可选方法 + `CaptureOptions`/`Capture`/`EmptyCaptureError` 进 `src/engine/types.ts`；CDP 实现在 `CdpPageHandle.capture`（driver.ts）：`Page.getLayoutMetrics` → dpr = visualViewport.clientWidth / cssVisualViewport.clientWidth（非有限正数取 1）→ 区域与视口取交集（空交集抛 `EmptyCaptureError`）→ `Page.captureScreenshot`（jpeg、clip 带 pageX/pageY 偏移与 scale=1/dpr，**不带** captureBeyondViewport）→ 超时经 pageCallError 转 `PageUnresponsiveError`。`width`/`height` 为 CSS 像素四舍五入。fake-engine 只新增 `capture`，未改现有假实现。
- **observer**：`locateRef()` 进 `src/observer/page-snapshot.ts`，路由与 `waitForRef` 相同（frame: 前缀、FrameGoneError→missing、先 installObserverLibrary、mapFrameRect 换算），`precheck=false` 解析；结果 ok 但元素不完全在视口内时，用自包含页面函数 `scrollIntoView({block:"center",inline:"center"})` 后再解析一次返回第二次结果。未复用 waitForRef。
- **session**：`screenshotAllowed()` = 无 secret_ref 值且 secretLiterals 为空；`screenshot(options)` 按 3.3 顺序：beginInvocation → switchPendingPopup → secrets/unsupported 检查 → ref 定位（unknown_ref）→ capture（EmptyCaptureError→not_visible、PageUnresponsiveError→unresponsive）→ url（targetUrl ?? lastObservation.url）→ title（callIsolated document.title，1s 超时，失败 ""）。交接截图条件改为 `this.screenshotAllowed()`（session.ts 原 813 行），文件名 `handoff-<steps>.png`→`.jpg`。
- **工具**：`src/mcp/tools/screenshot.ts`，挂在 observe 之后（清单顺序 run, resume, observe, **screenshot**, act, navigate, tabs, close, decide）；不声明 outputSchema；描述逐字照抄计划；执行包 `host.handle → host.inSession`；成功返回 `{content:[text,image]}`（output=file 无 image 项；text 为一行 JSON，含 note 字段）；`imageResponses:"omit"` 一律按 output=file 并在 text 加 `images:"disabled by server configuration"`；五条失败文本照抄；`browser_observe` 的 screenshot 文件名同步 `.jpg`、判定改用 `instance.screenshotAllowed()`。
- **文件**：`screenshotDir` 存 `jevpilot-<yyyyMMdd-HHmmss>-<uuid 前 8>.jpg` 永不删；否则存 `host.sessionDir()` 下 `screenshot-<uuid>.jpg`，sessionDir 返回 undefined 或写后 sessionOpen 为 false 不返回路径（竞态测试覆盖）。
- **配置**：McpDeps 新增 imageResponses/screenshotDir/disabledTools；server.ts 校验 disabledTools（两条错误文本照抄）；main.ts 解析三个环境变量（IMAGE_RESPONSES 非法值、SCREENSHOT_DIR 非绝对路径或不存在、空项忽略）。
- **文档**：tools.md 新增 browser_screenshot 一节、configuration.md 三行环境变量、architecture.md 模块结构小节、CHANGELOG.md [Unreleased] 三类（由并行的文档任务完成，已 review 并入本提交）。

金样只新增 browser_screenshot 一项（位置 observe 之后），其余逐字节不变（已用 JSON 反序列化逐项比对验证）。3.8 允许清单外的现有测试改动见下方偏差第 2、3 条。

### 4. `docs(dev): M7 report`

本文件。

---

## 测试命令与结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（每个提交前） | 通过 |
| `npm run format:check`（每个提交前） | 通过 |
| `npm run test:unit`（提交 1/2 前） | 695+1=696 通过（M7a-0）；698 通过（M7a，基线 695+3） |
| `npm run test:unit`（提交 3 前，最终） | **712 通过 / 0 失败**（695 基线 + 金样 1 + architecture 2 + screenshot 13 + session 新增 1） |
| `npm run test:integration` | **未运行**（arm64 Linux 无 Chrome，`findChrome()` 返回 undefined，describe 整体 skip）。17 条集成测试已写好：新文件 `test/mcp/screenshot.test.ts` 之外，`test/orchestrator/integration/screenshot.test.ts` 6 条（15–20 号标题照抄、SOF0/SOF2 尺寸解析、本地 fixture server 照抄 session.test.ts 的写法） |

## 允许清单（3.8）外的现有测试改动

1. `test/mcp/server.test.ts:923`（"unexpected engine errors are diagnosed without exposing secrets"）：`frame=.*src[/]mcp[/]server\.ts:\d+` 改为 `(?:server|host)\.ts`。原因：sourceFrame() 取 error stack 第一个 src/ 帧，launch 的 await 链整段搬进 host.ts 后，该帧从 server.ts:288 变为 host.ts:367，日志**格式**未变。这是搬代码的必然结果，不在 3.8 清单内，报请裁定。
2. `test/mcp/stdio.test.ts:16`：tools.length 8→9。新增 browser_screenshot 使无决策服务的工具总数 +1，同类断言在 3.8 只列了 server.test.ts 的两处。
3. `test/mcp/server.test.ts:776-780`（"MCP tools list schemas…" 循环）：outputSchema 断言对 browser_screenshot 分支为 undefined（该工具不声明 outputSchema 是计划本身的要求），并在 762 行清单加入 "browser_screenshot"（3.8 明确允许）。

除上述三处外，现有测试零改动、零删除、无 skip/todo。

## 不确定 / 请验收时留意

- `locateRef` 的滚动判定用了两个自包含页面函数（`refOutsideViewport`/`scrollRefIntoView`），符合规则 10；frame 内元素的滚动发生在子框架内，`locateRef` 对 frame ref 的第二次解析走同一路径，跨域 iframe 场景依赖集成测试验证（未运行）。
- `host.sessionDir` 与原 browser_observe 内联逻辑等价搬迁，并从 tools/observe.ts 与 tools/screenshot.ts 共用；竞态语义（closing/closingSessions 复查、失败删除刚建目录）逐行保留。
- `Page.getLayoutMetrics` 在个别 Chrome 版本可能缺少 `cssVisualViewport` 字段（老版本协议）；实现按计划只读该字段，未做降级，如验收环境 Chrome 过旧需确认。
- 变异检查自测：删除 screenshotAllowed 检查 → "refuses sessions with secret values" 失败；删掉 sessionDir 的 closing 复查 → 竞态测试失败；金样测试对 schema 任何字节变化敏感。
