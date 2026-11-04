# CONTRIBUTING:加一个命令的完整清单

> 维护者/agent 视角。CLAUDE.md 的一句话版(「写 command + 注册」)只覆盖入口;这里是不漏配套的全清单。
> 改动必跑:`bun check` + `bun test`(离线组恒可跑;付费冒烟见第 7 节选择)。

## 1. 命令本体

- [ ] 新建 `src/commands/<族>.ts` 或并入既有族,`export function registerXxxCommands(cli: QuakeCli)`
- [ ] `src/cli.ts` 注册块按序调用(**注册顺序 = help/--llms 面顺序**)
- [ ] 命令定义带:description、args/options zod schema、examples、hint(有边界要说明时)

## 2. 类型与守卫(领域知识进类型系统)

- [ ] 输入标识符有品牌 + 守卫(src/types.ts);守卫即构造唯一入口,失败在 run() 顶部 `c.error` USAGE 快速失败
- [ ] 闭集字段用字面量联合;可缓存方法要进 `CacheableMethod` 并配 TTL_HOURS(satisfies 穷尽,漏配编译失败)
- 详见 [typed_domain_guide.md](typed_domain_guide.md),勿用 `'' as Brand` 类空串偷渡(kimi review F01 实案)

## 3. 请求与解析

- [ ] API 调用走 `cachedQuake`(缓存 + 限流 + query_runs)或 `quakeRequest`,勿裸 fetch
- [ ] 响应消费走 src/schemas.ts 解析器(parseListBody/parseAggBody);新响应形加解析器,不在命令内 `as` 断言
- [ ] size 类参数过 `validSize`;查询串过 `isBalancedQuery`

## 4. 归档副作用

- [ ] 命中即归档的命令:items -> toAssetRow(过滤 null)-> upsertAssets;缓存命中跳过归档
- [ ] scan_tasks 写入用部分更新语义(undefined = 不改列),勿抹既有 target

## 5. output schema 与 MCP

- [ ] 声明 `output:` zod schema(结构化用显式 schema;透传形 `z.object({}).passthrough()`)
- [ ] output schema 即 MCP 工具输出契约(direct 直出面),CTA 字段经 passthrough 保留
- [ ] `bun src/cli.ts --llms` 确认新命令出现在手册面

## 6. 测试

- [ ] 离线组(零网络):守卫用例、本地逻辑单测
- [ ] fixture 组:`tests/fixture_preload.ts` 加路由 + `tests/fixtures/quake_responses.json` 收割真实响应(**脱敏:域名/IP 视来源处理,敏感样本用结构等价替代**)
- [ ] API 冒烟组(标 `nt`,需 .env Key):最小 size,特权账户走长效积分池(非免费,大量拉取前 `user` 看余量)
- [ ] 全端点回归后跑 `QuakeAPIKey= QUAKE_API_KEY= bun test`(冒烟 skip)再全量

## 7. 文档与 CHANGELOG

- [ ] README 基础使用(高频命令)或 advanced(高级用法)按需补行;独立任务复杂度才开新篇
- [ ] 接口行为实测结论进 quake_api_notes.md(六态标注:实测/官方文档/推断)
- [ ] CHANGELOG.md 记用户可见变化;发版流程见 RELEASE 节

## 附:发版 runbook(维护者)

1. `package.json` + `src/quake.ts` 版本号一致(两处)
2. CHANGELOG.md 补本节
3. `bun check && bun test` 全绿
4. `git tag vX.Y.Z && git push origin vX.Y.Z` -> CI(release.yml:三平台测试 + 七目标编译 + sha256 + Release;冒烟断言二进制版本 == tag,不一致即失败)
5. 失败处理:Actions 重跑(rerun failed jobs);代码问题修复后删 tag 重打,或直接发补丁版本
6. 验收:Release 页七目标 14 产物齐全,下载任一二进制 `--version` 与 tag 一致
