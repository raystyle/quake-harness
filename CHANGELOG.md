# Changelog

## 未发布(2026-11-04 review 修复)

- 聚合计费实测纠正:聚合会扣长效积分(与 size 正相关,单账户四次对照 1/3/5 扣 1/3/5);全仓 12 处「聚合免费」表述已改,措辞按证据边界收敛(未测多 facet/不足 size,非官方承诺)
- latest 输出面:service-search 返回 latest_note 口径注记;--latest false 字符串写法实测不生效(zod boolean 不收),文档统一 --no-latest;对比 CTA 沿用原查询过滤条件
- output schema 补声明:latest_note 与 CTA(service-search 存量 CTA 一并),MCP tools/call 不再 Output validation error(回归入档)
- fields CTA 按 dataset 分流(host 系走 host-agg,原固定 service-agg 跳错数据面)
- doctor --net 与积分类 CTA 统一长效积分口径(persistent_credit;原月度口径在特权账户恒 0 误导)


## v0.2.1(2026-11-04)

### 修复

- **domain 缓存失效**:近一年时间窗曾精确到秒,cache_key 每次都变,同参数重复查询永远不命中缓存(每次实扣积分);取整到天后同天同参二跑命中(`cache_hit: true` 实证),回归测试入档
- **冒烟测试随机超时**:冒烟组子进程超时 30s -> 90s(限流静默期叠加下单条命令可超 60s,30s 下 service-scroll/domain/host-honeypot 轮流随机失败)

### 文档

按缺口盘点补齐九篇/节:QUICKSTART(五分钟上手)、troubleshooting(症状->code->下一步全表)、CONTRIBUTING(加命令七步清单 + 发版 runbook)、export 食谱(SQL/Parquet 任务篇)、数据文件运维附录与敏感性边界(并入 data_contract)、icon 扩簇任务节(playbook)、fields vs syntax 对照(advanced)、fts 独立文档(索引结构/检索语义/跨月机制)


## v0.2.0(2026-11-04)

### 新命令

- **`domain <域名>`**:域名资产枚举,对齐官方 quake_rs domain 子命令。`--noCdn/--noHoneypot/--filterRequest` 三过滤器,近一年时间窗,命中即归档;`DomainName` 守卫兼 Quake 语法注入防线
- **`fts <MATCH>`**:归档库 SQLite FTS5 全文检索,离线零积分。title/body/server/host 四列,列限定(`title:b374k`)与布尔组合(`server:"Apache" AND host:gov.cn`),snippet 高亮,`--month` 定向,`--backfill` 存量回填
- **`doctor`**:环境体检。token 解析链/三目录可写探针/归档库/限流节奏/旧目录残留七项离线检查,`--net` 免费探活报延迟与积分余量

### 命令与 MCP 面

- MCP 工具面改 **direct 直出**:每命令注册为常规工具(完整 input/output schema),弃渐进发现四件套
- 服务查询族加 `service-` 前缀:search/scroll/agg,与 host 族对称
- `scan` 提交形三选一:query / `--ip-list` / `--domain-list`(官方数组形)
- `scan-ls` 补 `--refresh`(逐任务拉服务端状态)与 `--from-cache`(从 raw 缓存找回失联任务 id,API 无列表端点的唯一恢复途径)
- 业务输入守卫族:cve 编号/favicon md5/ip CIDR/compare doc id/scan task id 入口 USAGE 快速失败;`validSize` 完整数值域(积分事故防线);查询语法平衡守卫(未闭合引号/括号本地拦截)

### 类型系统(领域知识编码)

- 品牌类型八枚:DocId/TaskId/CacheKey/Month/DomainName/CveId/FaviconHash/IpCidr,守卫即构造器
- 可辨识联合:`ScanStatus`(状态机四词 Calculating/Running/Sent/Finished + unknown 兜底)、`QuakeEnvelope`(ok/err 判别)
- `TTL_HOURS satisfies Record<CacheableMethod, number>` 穷尽闭合;`FieldsDataset`/`Transport`/`RawMethod` 闭集
- 响应选择性解析器(src/schemas.ts):parseEnvelope/parseListBody/parseAggBody,网络与缓存回放共用,meta 三形 total 兼容
- 命令级 zod output schema 22/24 覆盖

### 数据与归档

- 月库 FTS5 虚表(assets_fts)随 UPSERT 同步;scan_tasks 补 runtime_id 列与部分更新语义(undefined = 不改列)
- 三时间语义钉清:DataTime/SeenTime 品牌,data_time 缺失或非法回落观测时刻并打标
- doc_id 三形态实测(hex / ip_port_transport / host_port_transport),端点语义校验

### 测试

- 全端点 fixture 回归(tests/fixtures.test.ts):16 真实付费响应转离线 mock,bun --preload 注入,业务逻辑全覆盖零网络
- 76 项测试全绿(单元 + 离线集成 + schemas 单元 + fixture + API 冒烟 + MCP stdio)

### 文档

- 新增:数据契约 review(C0-C4 五层)、类型系统对照指南、漏洞狩猎 playbook
- scan API 产出模型实测钉死:状态机/三提交形/result 恒空/产出经 task.runtime_id 检索延迟高/无列表端点
- kimi 三轮 review 共 46 findings 全闭环(品牌类型 12 / 文档注释 17 / 发版门禁 12+6)

### 已知限制(实测)

- 扫描产出经 `task.runtime_id` 检索获取,入索引延迟较高;result 端点对常规目标恒空
- custom_scan 族被 `front.api.custom_scan` 权限挡(特权账户亦无),命令未封装
- 任务 target 仅存本地簿,API 不回显提交参数
