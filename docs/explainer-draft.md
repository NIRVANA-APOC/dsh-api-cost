---
template: sheet
title: dsh-api-cost 2.0 重构
subtitle: 投影优先的 TypeScript 重写：精确计价、有界状态、可验证的轻量化
---

Lead: 插件不再自己重放日志与轮询。它注册一个纯会话投影，宿主负责事件驱动、水位与持久检查点。

## A 结论 {bare}

```callout ok 宿主负责驱动，插件只做纯折叠
114 项测试、严格类型检查、体积与性能预算全部通过。
客户端 gzip 从 13.1 KB 降到 9.6 KB，宿主从 27.8 KB 降到 10.3 KB。
```

## B 数据流

```flow
(持久会话事件) -> 宿主投影驱动: 每个已提交事件
宿主投影驱动 -> apiCost 纯折叠: init / apply
apiCost 纯折叠 -> wire.view: 整体值加 seq
wire.view -> useProjection: 胶囊与面板
宿主投影驱动 -> 宿主检查点: 冷读只补尾部
SessionQuery -> 范围解析: self / tree / team
范围解析 -> 汇总: own 加 others 等于 total
汇总 -> HTTP v2 与命令与工具
```

## C 统计范围

| 范围 | 含义 | 状态 |
|---|---|---|
| self | 只读本会话 | ok |
| tree | 本会话加持久委派后代 | ok |
| team | 团队成员及其后代 | ok |
| auto | 可验证团队，否则委派树 | ok |
| 未验证团队 | team 请求直接报错 | ok 不再假装成功 |

## D 已修复的缺陷

| 缺陷 | 旧后果 | 现在 |
|---|---|---|
| 首次读取前已有实时调用 | 漏算历史 | 统一由宿主投影折叠 |
| 账本上限 64 | 71 会话只算出 64 个 | 完整汇总 71 个 |
| 团队 own 取首行 | 成员看到 Lead 的金额 | own 永远是本会话 |
| 并发树查询 | 第二个请求结果不完整 | 单飞共享 |
| 损坏事件与畸形用量 | 抛错并污染后续状态 | 显式标记，不入账 |
| 无效报告被计价 | 出现无调用解释的金额 | 一律不计价 |

## E 轻量化实测

| 指标 | 1.0.0 | 2.0 |
|---|---|---|
| 客户端 gzip | 13,094 B | 9,827 B |
| 宿主 gzip | 28,445 B | 10,512 B |
| 10 万次结算计价 | 22.7 ms | 12 ms |
| 71 会话历史树冷读 | 只算 64 个 | 1.4 ms 完整 |
| 每会话投影状态 | 最多 500 条调用 | 10 万次后低于 6 KiB |
| 本会话刷新 | 每 2.5 秒轮询 | 投影推送，零轮询 |

## F 破坏性接口

```flow
- GET /dsh-api-cost/api
- GET /dsh-api-cost/api/reconcile
+ GET /dsh-api-cost/v2/view
+ GET /dsh-api-cost/v2/pricing
- routePrefix 配置
+ 固定 /dsh-api-cost/v2
- 插件侧重放与 LRU 账本
+ 宿主投影与持久检查点
- 浮点金额
+ BigInt 纳元与十进制字符串
```

## G 尚未验证

```callout warn 边界要讲清楚
测试用的是契约替身，不是真实服务。插件未装入任何 profile，也未在真实页面验证。
dist 已构建并打包检查：25 个文件。远程仓库需提交 dist 才支持 Git 安装。
```
