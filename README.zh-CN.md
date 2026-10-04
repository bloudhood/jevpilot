# jevpilot — 给 AI agent 用的快速 Jev 浏览器 MCP

[English](README.md) | 简体中文

jevpilot 是一个 MCP 服务器，让 agent 拥有一个能自己把任务做完的浏览器。agent 只需给出目标，jevpilot 驱动真实的 Chrome 一步步执行，每一步由 [Jev](https://typesafe.ai) 决定，最后返回经过验证的结果，或者一个具体的问题。

jevpilot 不是 TypeSafe 官方项目。Jev 是 TypeSafe 的付费模型，需要自备 TypeSafe API 或 OpenRouter 的密钥。

## 亮点

- **按目标完成任务**：一个任务一次工具调用，而不是每次点击一次；Jev 每步决策约 0.3–0.9 秒。
- **拿不准就交回，不硬猜**：没把握、缺少必要的值或需要批准时，会话停下并给出明确的状态和问题，agent 回复后在同一会话里继续。
- **规则先于模型**：登录墙、人机验证、错误页由规则识别；购买、支付、删除类按钮要等批准；提交表单前复核已填写的字段。
- **密码不进提示词**：密码以引用形式传入，由服务器只在你允许的网站上填写，agent 和 Jev 都看不到明文。
- **网络防护**：默认拦截云元数据地址，可选内网拦截模式和域名白名单。
- **桌面和服务器都能跑**：Windows 和 Linux 默认使用无头 Chrome；Docker 镜像在 Xvfb 下运行 Chromium；支持 stdio 和带令牌的 HTTP。
- **好运维**：浏览器崩溃后自动恢复，`jevpilot-mcp doctor` 检查配置，可选的用量与决策日志，没有遥测。

## 为什么不直接用 Playwright MCP？

用 [Playwright MCP](https://github.com/microsoft/playwright-mcp) 时，agent 要自己读每个页面、发出每一次点击；用 jevpilot，agent 把整个任务交出去：

|                                 | Playwright MCP          | jevpilot                   |
| ------------------------------- | ----------------------- | -------------------------- |
| 谁来决定每一次点击              | agent                   | 服务器内的 Jev             |
| 每个任务的工具调用次数          | 7.1                     | 1.5                        |
| 每个任务的 agent token          | 4.9 万                  | 1.1 万                     |
| 成功率：多步任务                | 83%                     | 100%                       |
| 成功率：未参与开发的真实网站    | 66%                     | 89%                        |
| 成功率：有反爬保护的网站        | 0%                      | 100%                       |
| 墙钟中位数：多步任务 / 真实网站 | 9.0 s / 16.9 s          | 5.1 s / 9.6 s              |
| 密码                            | 以明文进入 agent 上下文 | 由服务器填写，agent 看不到 |
| 购买 / 支付 / 删除按钮          | 由 agent 自行判断       | 等 agent 批准后才执行      |
| 人机验证和登录墙                | 需要 agent 自己发现     | 自动识别，说明原因后交回   |

测量于 2026 年 9 月，Windows 上两边都使用无头 Chrome，由同一个 agent 模型驱动，背靠背运行。样本较小、且是会变化的公开网站，数字仅供参考。

## 平台与浏览器

| 平台              | 默认浏览器                                                              | 运行方式                                     |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Windows x64       | Google Chrome（未安装时用 Microsoft Edge）                              | 默认无头，使用临时配置目录                   |
| Linux x64 / arm64 | `PATH` 中的 `google-chrome` 或 `chromium`（Docker 镜像已自带 Chromium） | 默认无头；Docker 镜像在 Xvfb 下运行 Chromium |
| macOS             | 暂不支持                                                                |                                              |

其他 Chromium 内核浏览器、长期保留的配置目录，或附加到你已打开的浏览器，都可以配置，见[配置文档](docs/configuration.md)（英文）。需要 Node.js 22 或以上。
设置 `JEVPILOT_DISPLAY=headed` 可改用有界面的浏览器（Windows 上窗口放在屏幕外；Linux 上使用 Xvfb 或已有的桌面显示）。

## 快速开始

每个版本在 [GitHub Releases](https://github.com/bloudhood/jevpilot/releases) 提供安装包 `jevpilot-X.Y.Z.tgz` 和 `SHA256SUMS.txt`。把它加到 MCP 客户端里，密钥放在环境变量中，不要写进配置文件。

Claude Code（`.mcp.json`）：

```json
{
  "mcpServers": {
    "jevpilot": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "https://github.com/bloudhood/jevpilot/releases/download/v0.3.1/jevpilot-0.3.1.tgz",
        "jevpilot-mcp"
      ],
      "env": { "JEV_PROVIDER": "openrouter", "JEV_API_KEY": "${JEV_API_KEY}" }
    }
  }
}
```

Codex（`config.toml`）：

```toml
[mcp_servers.jevpilot]
command = "npx"
args = ["-y", "--package", "https://github.com/bloudhood/jevpilot/releases/download/v0.3.1/jevpilot-0.3.1.tgz", "jevpilot-mcp"]
env = { JEV_PROVIDER = "openrouter" }
env_vars = ["JEV_API_KEY"]
```

使用 TypeSafe 密钥时设 `JEV_PROVIDER=typesafe`。在原生 Windows 上，Claude Code 需要写成 `"command": "cmd"`、`"args": ["/c", "npx", ...]`。用 `jevpilot-mcp doctor` 检查配置（同一条 `npx` 命令，末尾加 `doctor`）。

## 工具

`browser_run` 按目标开始一个会话；`browser_resume` 在补充值、批准操作或更新目标后继续。`browser_observe`、`browser_act`、`browser_navigate`、`browser_tabs` 和 `browser_close` 供 agent 需要时手动操作，`browser_screenshot` 把页面（或单个元素）作为图片交给 agent，或保存成文件交给用户，`jev_decide` 直接调用 Jev。

## 文档（英文）

- [配置](docs/configuration.md)：设置项、浏览器配置、网络安全、HTTP 传输、Docker
- [工具](docs/tools.md)：输入、返回结果和兼容性约定
- [隐私](docs/privacy.md)：每一步发给 Jev 的内容
- [架构](docs/architecture.md)、[贡献指南](CONTRIBUTING.md)、[安全](SECURITY.md)、[更新日志](CHANGELOG.md)

请只在你有权自动化的网站和账号上使用 jevpilot。它不破解验证码：识别到人机验证会交回处理。

## 许可证

MIT
