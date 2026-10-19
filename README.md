# Command Code for DeepSeek Harness

[![Release](https://img.shields.io/github/v/release/Plocr/dsh-commandcode-goat)](https://github.com/Plocr/dsh-commandcode-goat/releases)
[![dsh-market 收录](https://img.shields.io/badge/dsh--market-已收录-4D6BFE)](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933)](package.json)
[![MIT](https://img.shields.io/github/license/Plocr/dsh-commandcode-goat)](LICENSE)

把 **Command Code 的 Go / GOAT / Pro / Max 订阅**接入 DeepSeek Harness（dsh）：自动同步可用模型、查看账户用量，并可用同一把密钥提供联网搜索。

插件将模型发布到官方 `llm-pi-ai` 供应商配置中，流式响应、工具调用、图片与历史重放由 dsh 自带的模型适配器处理。

**[市场收录页面](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/) · [最新版下载](https://github.com/Plocr/dsh-commandcode-goat/releases/latest) · [反馈问题](https://github.com/Plocr/dsh-commandcode-goat/issues)**

## 快速开始

### 1. 安装

在 dsh 的「插件 → 添加插件」中粘贴：

```text
github:Plocr/dsh-commandcode-goat
```

也可以安装 Release 包：

```text
https://github.com/Plocr/dsh-commandcode-goat/releases/latest/download/dsh-commandcode-goat.tgz
```

命令行安装到 Web profile：

```sh
dsh plugin --profile web add github:Plocr/dsh-commandcode-goat
```

桌面端请优先使用插件面板。命令行安装时，应选用桌面端实际使用的 profile 和 DSH_HOME，避免装进另一份配置。

本插件已被 [dsh-market](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/) 收录，也可在已安装的市场中搜索 `dsh-commandcode-goat`。dsh 0.2.1 的「插件 → 发现 → 索引源」可添加以下社区索引后搜索安装（[市场说明](https://dshmarket.com/zh/)）：

```text
https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json
```

### 2. 选择套餐并同步

安装后按宿主提示重启。默认开启自动同步，加载后等待约十几秒，供应商会出现在「设置 → 模型」。

打开「插件 → 已安装 → dsh-commandcode-goat」的配置页，选择与你账户一致的 `Go`、`GOAT`、`Pro` 或 `Max`，点击「创建 / 更新」。默认选择 `GOAT`；读取账户订阅后会提示档位差异，但不会自动替你切换。

### 3. 配置密钥并选择模型

在「设置 → 模型」中找到生成的 `Command | <档位>` 供应商，填写 Command Code API Key 并保存，然后在会话中选择模型。

也可以在启动 dsh 前设置环境变量，例如 PowerShell：

```powershell
$env:COMMANDCODE_API_KEY = '你的 Command Code API Key'
dsh web
```

聊天、账户用量和可选搜索默认共用该凭据。需要使用其他凭据引用时，修改 `targetApiKeyEnv`。

## 功能

| 功能 | 行为 |
|---|---|
| 模型同步 | 合并网关实时模型列表与套餐能力目录，按档位筛选并生成供应商 |
| 协议分流 | 根据模型支持的端点选择 OpenAI Chat、Anthropic Messages 或 OpenAI Responses |
| 调用诊断 | 同步后对各条生成路由发送最小请求，展示 HTTP 状态、耗时和错误详情 |
| 账户用量 | 展示账户、组织、生效订阅、5 小时与每周窗口、余额及请求和 Token 汇总 |
| 联网搜索 | 可选用 Command Code 账户提供 `web_search`，默认关闭 |
| 用量工具 | 默认注册 `commandcode_usage`，让模型读取账户用量 |
| 长会话恢复 | 在高上下文压力时尝试剪枝；对特定网关拒绝尝试减少上下文后重试 |
| 档位清理 | 手动同步后可清理旧档位的生成路由，并提示仍在引用它们的配置 |

路由探测会产生真实的模型请求，可能计入账户用量。探测结果用于诊断，不代表该路由下所有模型、长上下文和工具调用都已验证。

## 界面预览

以下为 0.7.5 的界面截图，账户信息与用量数字已打码；当前版本的诊断信息可能有所不同。

**套餐与模型通道**

![套餐与模型通道](assets/subscription-tiers.png)

**生成的模型供应商**

![生成的供应商](assets/generated-providers.png)

**账户用量**

![账户用量](assets/account-usage.png)

<details>
<summary>更多截图：选项与插件入口</summary>

![选项](assets/options.png)

![插件入口（旧版宿主）](assets/plugins-panel.png)

</details>

## 模型与同步规则

模型列表来自 `https://api.commandcode.ai/provider/v1/models`；能力与套餐信息来自 Command Code 套餐文档页。模型数量、价格和账户额度会变化，以同步结果、账户用量及官方套餐页为准。

| 通道 | 供应商 key | 显示名 |
|---|---|---|
| OpenAI Chat | `commandcode-<档位>-autosync` | `Command \| <档位>` |
| Anthropic Messages | `commandcode-<档位>-anthropic` | `Command \| <档位> · Claude` |
| OpenAI Responses | `commandcode-<档位>-responses` | `Command \| <档位> · Responses` |

- 一条供应商路由对应一种协议；同一套餐出现多条供应商是正常现象。
- 只有分配到模型的通道才会创建。模型同时支持 Chat 和 Responses 时优先使用 Chat，因此没有 Responses 路由也可能正常。
- 能力目录读取失败时会提示降级：仍可生成模型，但无法可靠补充能力与套餐过滤。实时模型列表读取失败则停止同步。
- 默认启动后自动同步，并每 6 小时刷新一次。后台同步不删除旧档位路由。
- 手动「创建 / 更新」后默认清理其他档位的生成路由。带非空 `modelOverrides` 的路由会被保留并报告；可用 `pruneOtherPlans: false` 关闭清理。
- 同步会重写生成路由的 `models` 列表。在「设置 → 模型」手动编辑其中的模型能力或推理档位，后续同步可能覆盖这些修改。
- 已有的凭据引用、协议和非空兼容设置通常会保留。插件会刷新自己生成的显示名，并修正 Claude 路由末尾多余的 `/v1`，避免请求变成 `/v1/v1/messages`。

推理模型默认不生成额外的推理档位映射。`includeReasoningEfforts` 为可选开关，启用后写入 `low/medium/high/xhigh/max` 映射；能力目录并未证明每个模型都接受这些值，调用支持以网关为准。

## 常用配置

在插件配置页修改即可。完整字段及默认值见 [配置定义](lib/index.js)。

| 配置 | 默认值 | 说明 |
|---|---|---|
| `plan` | `goat` | `go` / `goat` / `pro` / `max` |
| `autoSync` | `true` | 启动后自动创建并定时刷新模型 |
| `autoSyncIntervalMs` | `21600000` | 同步间隔，单位毫秒，最小 60 秒 |
| `targetApiKeyEnv` | `COMMANDCODE_API_KEY` | 凭据引用名；配置为空时使用该默认值 |
| `pruneOtherPlans` | `true` | 手动同步后清理旧档位生成路由 |
| `webSearch` | `false` | 使用 Command Code 提供联网搜索 |
| `enableUsageTool` | `true` | 注册 `commandcode_usage` |
| `includeReasoningEfforts` | `false` | 为推理模型生成档位映射 |
| `recoverUpstreamOverflow` | `true` | 特定网关拒绝后的上下文恢复与重试 |
| `contextGuardRatio` | `0.7` | 请求前剪枝的压力比例；`0` 关闭该保护 |
| `maxContextWindow` | `0` | 写入模型的窗口上限；`0` 保留上游声明 |

高级配置还包括 `sourceURL`、`catalogURL`、`targetBaseURL`、`targetCompat`、`extraIds`、`usageBaseURL` 和 `enableBridge`。

开启搜索后，插件会选择 Command Code 搜索供应商；关闭或卸载时，若搜索选择仍由本插件持有，则恢复此前的供应商。用量与搜索请求在宿主侧使用凭据，配置卡片不接收密钥内容。

## 常见问题

**安装后没有出现供应商？**

确认安装到了当前 profile，按提示重启并等待首次同步。打开插件配置页查看错误：`fetch-failed` 通常表示模型源读取失败；`provider-plugin-missing` 表示当前 profile 未加载官方 `llm-pi-ai`；关闭自动同步时需要手动点击「创建 / 更新」。

**Claude 返回 404？**

先更新到 v0.7.9 或更新版本，再同步一次。插件会修正旧配置的 Anthropic 基地址；Claude 客户端自行追加 `/v1/messages`，基地址末尾不应再带 `/v1`。同时检查探测结果与自定义网关地址。

**同步成功，模型调用仍失败？**

配置写入和实际调用是两件事。查看同步后的通道诊断，并核对 API key、所选套餐和网络。单个探测模型成功也不能证明所有模型都可调用。

**切换套餐后旧供应商还在？**

执行一次手动同步，或使用配置页的清理操作。后台同步不清理；带 `modelOverrides` 的路由会受到保护。清理后如有默认模型或子代理仍引用旧路由，请一并调整。

**更新 dsh 后需要改插件吗？**

v0.7.9 使用 dsh 0.1.7 起的设置接口；旧版 0.1.6 用户应使用插件 0.4.8。截至 2026-10-19，已对照 dsh 0.2.1-rc.2 的 provider schema 和上下文恢复接口，未发现必须修改才能加载的接口变化。这是源码核对，尚不代表在该宿主版本完成了真实模型调用验证。

**长会话保护是否保证不超限？**

不保证。插件依赖宿主提供的计量、剪枝和压缩服务，只对自己生成的路由生效。默认保留上游窗口声明；自定义压缩策略、网关限制和模型行为都会影响结果。

## v0.7.9 更新

- 修复 Claude 路由重复 `/v1` 导致的 404，并在同步时修正旧配置。
- 同步后展示通道请求的状态、耗时和错误信息。
- 解释通道缺失原因，区分套餐筛选、端点支持与协议优先级。
- 包含 v0.7.6–v0.7.7 的上下文保护、同步原子性、取消处理和配置卡片改进。

完整版本记录与安装包见 [Releases](https://github.com/Plocr/dsh-commandcode-goat/releases)。

## 开发

需要 Node.js 20 或更新版本，无额外构建步骤。

```sh
npm install
npm test
```

v0.7.9 发布提交包含 384 项通过的离线测试。真实服务验证脚本为 `npm run verify:live`，需要相应凭据和网络，可能产生调用费用。

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主装配、同步与工具注册 |
| `lib/catalog.js` / `lib/plans.js` | 模型目录、档位与通道路由 |
| `lib/pi-ai.js` | 官方供应商配置的写入与清理 |
| `lib/probe.js` | 通道调用诊断 |
| `lib/recovery.js` | 上下文保护与失败恢复 |
| `lib/usage.js` / `lib/search.js` | 账户用量与搜索 |
| `lib/bridge.js` / `lib/client.js` | 宿主接口与设置卡片 |

## English

Connect a Command Code **Go / GOAT / Pro / Max** subscription to DeepSeek Harness. The plugin publishes provider profiles to the official `llm-pi-ai` adapter, syncs the model catalog, displays account usage, and optionally provides web search with the same credential.

```sh
dsh plugin --profile web add github:Plocr/dsh-commandcode-goat
```

Restart the profile when prompted, select your subscription tier in the plugin configuration, and configure `COMMANDCODE_API_KEY` under **Settings → Models** or in the environment. Automatic sync is enabled by default. Generated model lists are replaced during sync, so manual model-level edits may be overwritten.

Listed on [dsh-market](https://dshmarket.com/p/Plocr/dsh-commandcode-goat/). Download the latest package and read release notes on [GitHub Releases](https://github.com/Plocr/dsh-commandcode-goat/releases/latest).

## License

[MIT](LICENSE)
