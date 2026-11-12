<h1 align="center">dsh-api-cost</h1>

<p align="center">看得清每一分 DeepSeek 花费，也省得下贵的那一半。</p>

<p align="center">
  <a href="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml"><img src="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="https://www.npmjs.com/package/dsh-api-cost"><img src="https://img.shields.io/npm/v/dsh-api-cost.svg" alt="npm"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT">
  <img src="https://img.shields.io/badge/DSH-plugin-4c8bf5" alt="DSH plugin">
</p>

<p align="center"><a href="README.en.md">English</a> · <b>中文</b></p>

---

<p align="center">
  <img src="assets/panel-session.png" width="760" alt="dsh-api-cost 会话明细面板（高峰时段）：本会话估算花费与官方美元列、当前时段与下次切换倒计时、把花费按高峰和空闲切开的琥珀/蓝色峰谷条、覆盖状态、当前费率，以及按本会话树生效的避开高峰区块">
</p>

<p align="center"><i>高峰时段看一个会话：花了多少、贵在哪、离便宜还有多久，以及这棵会话树有几个请求正在等谷时。</i></p>

## 为什么是 dsh-api-cost

`dsh-api-cost` 是 DeepSeek Harness 的成本仪表：宿主把每一笔已结算的调用折叠进一个纯 `apiCost` 会话投影，告诉你这个会话、这棵委派树、这个团队各花了多少。它不是日志聚合器——不重放日志、不另攒账本，数字直接来自宿主持有的事件流与持久检查点。

- **峰谷一眼看清** —— 胶囊上直接写「峰」或「谷」，面板顶栏给出当前时段和距下次切换的倒计时；一条琥珀/蓝的峰谷条把花费按贵的那一半和便宜的那一半切开。
- **避开高峰** —— 开关打开且当前是高峰时，本会话及其委派子会话的模型请求会被暂缓，等到谷时原样发出：最多省一半，而模型全程无感。
- **结算语义正确** —— 投影优先：每个 `assistant/message` 计一次，按其自身结算时刻定价；fork 继承的前缀不计入子会话；历史会话恢复时从持久日志折叠，不从 ¥0 起算，也不会翻倍。
- **归属清楚** —— `self` / `tree` / `team` 三种范围；团队名单逐人列出金额，Lead 标 ★；`others` 永远是 `total − own`，fork 不会被重复计入。
- **轻** —— 没有重放框架、没有数据库、没有自有轮询循环：客户端约 **13.7 KiB gzip**，宿主约 **15.3 KiB gzip**。
- **诚实** —— 是估算而不是账单；价目表外的模型标为未定价，而不是猜一个价；覆盖缺口用文字如实写出。

**为什么不是又一个用量面板。** 用量面板通常在插件侧重放日志、自己攒一份账本；`dsh-api-cost` 注册的是宿主持有的 `apiCost` 会话投影——事件驱动、每会话水位、持久化检查点都由 Harness 负责，客户端通过框架自带的 `useProjection` 座位读取同一份投影。差别是结构性的：历史不用手动补、重启不会翻倍；`tree` / `team` 归集直接复用持久的委派目录与团队名单，fork 继承的前缀被明确排除，看某个分支时不会把祖先重复计一遍。

## 安装

需要 DeepSeek Harness **0.2.0-rc.2+**（已在 **0.2.2-rc.2** 上验证），且装配了 `sessionProjections`、`sessionProjectionCache`、`sessionQuery` 三项能力（自带的 `web` 与 `desktop` profile 都有）。仓库自带预构建的 `dist/`，**安装不需要编译器**；Node.js 24 只在开发时需要。

```sh
# Web / CLI profile —— 从 GitHub 仓库安装（现在就能用）
dsh plugin --profile web add github:NIRVANA-APOC/dsh-api-cost

# 桌面端 profile
dsh plugin --profile desktop add github:NIRVANA-APOC/dsh-api-cost
```

桌面版请在执行安装命令前**完全退出** DSH（Windows 上从托盘退出；只关窗口会留下进程锁），安装后重新打开；如果桌面版还没有 `dsh` 命令，先在它的菜单里用 **Manage dsh Command → Install** 注册一次。Web 版也可以直接用 `npx @deepseek-ai/dsh plugin --profile web add github:NIRVANA-APOC/dsh-api-cost`。GitHub 源安装要求本机有可用的 `git`（pnpm 通过 git 拉取仓库）；npm 上的 2.3.0 已发布，也可用 `dsh plugin --profile web add dsh-api-cost`（同一个包，不需要 git；npm 渠道由仓库的 release 工作流带 provenance 发布，见 [docs/releasing.md](docs/releasing.md)）。宿主侧能力（投影、`/cost`、`session_cost`、HTTP 读取）立即生效，输入框那枚胶囊要等启动时合成客户端包，所以**重启 DSH 一次**。

## 界面

### 胶囊

和官方的会话统计胶囊并排，它安静地待在输入框旁：本会话估算花费、一条细分隔线，以及用该时段计价色写出的「峰」/「谷」——是文字，从不只靠颜色区分。数字直接读宿主投影，结算发生时重绘而不是靠定时器；范围内有未定价、被截断或读不到的会话时出现「部分统计」标记；有请求在等谷时，胶囊再多出「等待谷时」几个字和等待数量（如 `×2`）。

| 空闲 | 高峰 |
| --- | --- |
| ![空闲时段的胶囊：本会话估算花费、一条细分隔线，以及用谷时的蓝色写出「谷」字](assets/pill-off-peak.png) | ![高峰时段的同一枚胶囊：时段用高峰的琥珀色写出「峰」字](assets/pill-peak.png) |

### 明细面板

点胶囊（或对它按回车）弹出明细面板。它围绕两种计价方式组织，而不是一张行列表：

- 顶栏写当前时段和距下次切换的倒计时——什么时候便宜，和花了多少同样重要；
- 本会话估算花费是视觉重心，用应用的品牌字体书写，旁边是官方公布的美元列，下面是该范围的统计数字；
- 一条峰谷条把花费按高峰/空闲切成琥珀/蓝两段，每段写自己的金额与「峰 / 谷」；
- 接着是本会话/其他会话拆分、覆盖状态（每条口径提示都用文字写出）、当前生效的费率与单位行；
- 一个按会话树生效的避开高峰区块：开关、范围说明，以及等待状态——这棵树共暂缓了几个请求（其中多少来自子会话）、何时放行、已等多久，以及无关的**其他会话**里还有几个请求在等；
- 一个刷新按钮——它重新读取该范围，而不是重放日志。

token 明细与按模型拆分刻意不放进面板，仍可通过 `/cost`、`session_cost` 与 `detail=full` 获取。

### 命令与工具

| 出口 | 行为 |
| --- | --- |
| `/cost [sessionId] [auto\|self\|tree\|team]` | 在会话里打印与胶囊一致的摘要，包含覆盖告警。 |
| `session_cost` | 让助手自己查询某个会话的估算；不传即当前会话。 |

## 三种范围

默认的 `auto` 能验证到团队时看整个团队，否则看自己的委派树；`self` / `tree` / `team` 把范围钉死。

| 范围 | 含义 |
| --- | --- |
| `auto`（默认） | 能验证到团队时用整个团队，否则用自己的委派树。 |
| `self` | 只看本会话。 |
| `tree` | 本会话加全部持久化的子智能体后代。 |
| `team` | 整个团队：Lead、成员及其后代；成员身份无法验证时报错，而不是假装成功。 |

`team` 范围会在「团队成员」下列出每名成员自己的金额，Lead 前置 ★：

![团队范围的明细面板：团队合计用品牌字体书写、整条为蓝色的谷时峰谷条、七个会话的完整覆盖，以及 Lead 前置 ★、每名成员一行金额的名单](assets/panel-team.png)

## 避开高峰

高峰时段的价格是谷时的两倍：Flash 每百万 tokens 的缓存未命中 ¥2、输出 ¥8，谷时是 ¥1 / ¥4；V4 Pro 高峰 ¥9 / ¥27，谷时 ¥4.5 / ¥13.5。如果一个请求不必**此刻**得到回答，它就不必按贵的那一档计费。

### 一个开关，管住一棵会话树

每个会话的面板都有一个**避开高峰**开关，默认关闭。开启后、只要当前处于高峰，**本会话及其委派的子会话**发出的模型请求都会被暂缓，等到时段转为谷时立刻原样放行。范围是一棵会话树而不是整个进程：另一个对话不会因为你在这里等谷时而一起停住。子智能体默认跟随上级，除非它自己的面板被手动切换过——最近的一次手动选择胜出：本会话有手动选择就听本会话的，否则沿上级找到最近的，再否则用配置里的默认值。这是用户对某个会话的选择，宿主按会话持久化，重启后每个会话的位置都还在；从未被切换过的会话树会继承配置里的默认值。

### 模型感知到的是「慢」，不是「错」

关键在于模型看到了什么：**什么都没有**。闸门挂在 `llm/stream` 瀑布上、早于任何 provider 派发，所以不会报告失败、不会往会话日志追加错误、不会消耗重试次数、也不会注入任何 chunk。请求本身一个字节都没变——同样的 messages、同样的工具——拿到的还是同一个回答，账单却按谷时算。从循环的视角看，这次调用只是「慢」，而等待只在胶囊和面板里可见：当前时段、距谷时的倒计时、这棵树有几个请求在等（其中多少来自子会话）、已经等了多久。

### 只暂缓，不拆分；失败一律放行

它不拆分一次调用：高峰开始时已经在飞的请求不受影响，谷时发出、却在高峰结算的调用仍按高峰计价，因为费率由结算时刻决定。但任何内部故障——时钟读不到、时段读不到、定时器装不上——都会立即放行，这个功能的失败模式是「你按高峰价付了钱」，永远不会是「你的会话卡住了」。关掉某个会话的开关、按下停止、或卸载插件，都会立即放行真正在等待的请求。

## 费率

DeepSeek 官方公布价格，2026-09-10 12:00 +08:00 起生效（元 / 百万 tokens）：

| 模型 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 高峰 | 0.04 | 2 | 8 |
| `deepseek-flash` | 空闲 | 0.02 | 1 | 4 |
| `deepseek-v4-pro` | 高峰 | 0.30 | 9 | 27 |
| `deepseek-v4-pro` | 空闲 | 0.15 | 4.5 | 13.5 |

面板上的 $ 列按官方单独公布的美元价计算，不用猜测的汇率换算。高峰为北京时间周一至周五 09:00–12:00 与 14:00–18:00（不含法定节假日），夜晚、周末、节假日与调休上班日都按空闲价。金额用精确整数（纳元单位）累计，只在展示时舍入；节假日表未收录的年份按**空闲价**估算，并标为 `holiday-data-missing`。

## 配置

写进 profile 补丁即可，通常只需要这几行：

```yaml
- id: dsh-api-cost
  name: 'dsh-api-cost'
  config:
    defaultScope: auto    # auto | self | tree | team
    tool: true            # 注册 session_cost
    command: true         # 注册 /cost
    gate:                 # 按会话树生效的避开高峰；每个会话的面板有一个开关
      enabled: false      # 从未被手动切换过的会话所用的默认位置
      persist: true       # 跨重启保留每个会话的位置
      models: all         # all | priced
```

完整配置参考（节假日日历、`gate.path`、`gate.models` 的取舍等）见 [docs/configuration.md](docs/configuration.md)。

## 诚实边界

- **是估算，不是账单。** 只用官方价目表与上报的 token 数；赠送余额、优惠、失败重试的真实扣费与第三方路由在这里看不到。
- **只给 DeepSeek 官方模型计价。** 未知 id 记为 `unknown-model` 且金额为 0，不猜价。
- **按结算时刻计价。** 跨时段的那一次调用不做按时长比例拆分，因为官方文档未规定这种拆法。
- **读不到的会话如实上报。** 标为 `session-unavailable`、覆盖状态为 `partial`；遍历超过 400 个会话的预算时标为 `scope-truncated`。
- **畸形的用量报告一律不计价。** 该调用只计为一次 settlement 并标记 `invalid-usage` / `missing-usage`，金额与 token 都不入账。
- **避开高峰只暂缓，不拆分。** 已在飞的请求不受影响；在谷时发出、却在高峰结算的调用仍按高峰价。

完整清单与口径见 [docs/limitations.md](docs/limitations.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/off-peak-gate.md](docs/off-peak-gate.md) | 闸门的冻结接口与每条约定的理由 |
| [docs/verification-gate.md](docs/verification-gate.md) | 闸门逐条断言的验证记录（含变异证伪） |
| [docs/http-api.md](docs/http-api.md) | HTTP 路由、参数与错误 |
| [docs/configuration.md](docs/configuration.md) | 完整配置参考 |
| [docs/limitations.md](docs/limitations.md) | 估算边界与如实上报的口径 |
| [docs/development.md](docs/development.md) | 开发命令与体积/性能预算门禁 |
| [docs/migration-1x.md](docs/migration-1x.md) | 从 1.x 迁移到 2.x |
| [docs/releasing.md](docs/releasing.md) | 发布到 npm 的流程 |

开发命令 `pnpm typecheck && pnpm test && pnpm bench` 见 [docs/development.md](docs/development.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
