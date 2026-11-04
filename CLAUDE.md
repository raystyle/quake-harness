# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

360 Quake 网络空间测绘 API 的 CLI 与 MCP 双形态客户端,技术栈 Bun + incur + zod,面向 qiye.quake.360.net 企业版 API。结构四层:`src/cli.ts` 薄入口(注册顺序 = help/llms 面顺序)+ `src/quake.ts` 基础设施(cli 工厂/请求层/缓存包装)+ `src/types.ts` 品牌类型与领域契约 + `src/schemas.ts` 响应选择性解析器;`src/commands/` 按族命令模块。

## 常用命令

```sh
bun src/cli.ts <cmd>            # 开发运行(如 user / search / cve)
bun check                       # 类型检查(改动必须过;测试门见下行 bun test)
bun build --compile --minify --sourcemap src/cli.ts --outfile dist/quake   # 编译单文件二进制
bun src/cli.ts --llms           # agent 手册面(命令树自省)
bun src/cli.ts --mcp            # MCP stdio server
bun src/cli.ts <cmd> --json     # 机器形输出(调试信封)
bun src/cli.ts doctor           # 环境体检(离线;--net 免费探活)
```

测试 `bun test`(两文件:cli.test.ts 单元与集成 + fixtures.test.ts 全端点离线 fixture 回归;项数以实跑为准不手维护):单元层(cache/archive/syntax/schemas)+ 离线 CLI 集成 + 全端点 fixture 回归(真实付费响应转 mock,零网络)+ API 冒烟(需 .env Key,自动节流防 q3005)+ MCP stdio。改命令后必跑。

凭据:项目 `.env` 的 `QuakeAPIKey`(bun 自动加载),或导出 `QUAKE_API_KEY`。

## 架构要点

- **三面同源**:命令注册表单一来源,派生 CLI 人读面、`--json` 信封、`--mcp` 工具面。加命令在 `src/commands/` 对应族文件写 `cli.command()` 并在 `src/cli.ts` 注册块按序调用,勿手维护清单。
- **缓存/归档两层**:src/cache.ts(A 层 raw 落盘 + TTL 回放)与 src/archive.ts(B 层 bun:sqlite,assets UPSERT + query_runs);查询命令经 src/quake.ts 的 cachedQuake 包装,勿绕过。
- **自适应限流**:src/ratelimit.ts(AIMD,q3005 指数退避)在 cachedQuake 内闭环,状态持久化 ratelimit.json 跨进程共享;勿在命令层另做节流。
- **统一请求层** `quakeRequest()`(src/quake.ts):所有 API 调用走它;Quake 服务端错误(code != 0)抛 `IncurError`,`code` 保留 Quake 原生错误码(q2001/q3012/u3009),权限与积分类错误在 message 尾拼『下一步:』提示。
- **token 取用** `pickToken()`(src/quake.ts):直接回落 `process.env`,勿依赖 `c.env`。

## 已钉死的坑(改动前必读)

1. 入口禁止 `export default cli`:cli 对象带 `.fetch` 方法,默认导出会触发 Bun 把入口当 Workers 应用自动起 localhost:3000 dev server。用具名导出 `export { cli }`。
2. incur 0.7.1 子命令 run context 的 `c.env` 只含命令级 env schema,CLI 级 `env` 不并入,故 token 走 `process.env` 回落。
3. `c.error()` 只在 `run()` 顶层返回值位置生效,嵌套函数里调用会被静默丢弃;错误一律抛 `IncurError`(Errors 命名空间导出)。
4. 数组选项用 `stringList()` helper:同时支持逗号分隔(`--include ip,port`)与重复旗标,incur 原生只认后者。

## API 实测档案

- 文档索引:上手 [quickstart](docs/quickstart.md) / 排障 [troubleshooting](docs/troubleshooting.md) / 贡献清单与发版 [contributing](docs/contributing.md) / 导出食谱 [export_recipes](docs/export_recipes.md)。

- `docs/quake_api_notes.md`:全部接口状态总表、CVE 详情返回结构、接口权限说明(compare/scan 族需 front.api.doc.compare / front.api.fast_scan,漏洞索引需漏洞数据角色)。
- `docs/compare_docs_api_notes.md`:compare/docs 参数规则与错误码轨迹(doc_ids 至少 3 个,格式 ip_port_transport)。
- `docs/vuln_hunting_playbook.md`:漏洞资产测绘搜索分析经验(L0-L3 分层确证、语法坑、低成本定形付费抽样工作流、噪声剔除)。
