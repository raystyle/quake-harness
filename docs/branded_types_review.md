# 品牌类型、联合类型与类型守卫审查

## 审查范围与验证

- 审查 `src/types.ts`、`src/archive.ts`、`src/quake.ts`。
- 审查 `src/commands/` 下的命令边界。
- 追踪 `src/cache.ts` 与 `src/ratelimit.ts` 的关联数据流。
- 本次审查未修改代码。
- `bun check` 通过，Git 工作区在审查前无改动。
- 无网络探针复现了 F01、F02、F03、F05、F06 的关键行为。
- 未运行消耗积分的 API 冒烟测试。

## 高严重度

### F01：无效 DocId 会引发归档主键碰撞

- 位置：`src/quake.ts:150-167`、`src/archive.ts:137-149`、`src/archive.ts:231-249`。
- 问题：守卫失败的 ID 会变成 `'' as DocId`。
- 同月库中的非法文档因此共享空串主键。
- 后续 UPSERT 会覆盖前行，`archived` 仍按输入条数计数。
- 无网络探针已确认非法 ID 会产出空串 `doc_id`。
- 建议：让 `toAssetRow` 返回 `AssetRow | null` 或显式结果。
- 拒绝或隔离非法文档，并报告拒绝数量。
- 增加缺失 ID、非法 ID、同批重复 ID 测试。

### F02：非法时间会被标成真实采集时间

- 位置：`src/types.ts:108-128`、`src/archive.ts:19-38`、`src/archive.ts:214-249`。
- 问题：`Boolean(a.time)` 只判断时间串是否非空。
- 非法时间会让 `dataMonth` 回落到当前月。
- `enriched.time` 仍保存非法值，观测标记却为 `0`。
- `DataTime`、`SeenTime`、`TimeAxis` 未进入实际存储路径。
- `AssetRow.transport` 也未使用现有的 `Transport` 联合。
- 建议：区分原始输入与已校验的存储行。
- 拒绝非法时间，或写入合法 ISO 回落时间并设置观测标记。
- `transport` 经守卫窄化后再写入 `AssetRow`。

## 中严重度

### F03：API 信封守卫与契约不一致

- 位置：`src/quake.ts:11-23`、`src/quake.ts:52-75`。
- 契约位置：`docs/data_contract_review.md:21-34`。
- 问题：契约允许 `code` 为字符串或数字。
- 守卫却把字符串 `"0"` 误判为失败。
- `message` 只检查属性存在，未检查属性类型。
- `message: null` 会在 `msg.includes` 处触发 `TypeError`。
- 两种行为均已通过 mock fetch 复现。
- 建议：用 schema 解析成功信封与失败信封。
- 明确定义成功码，并验证失败码和消息的实际类型。

### F04：外部响应仍依赖断言，集中接口未形成边界

- 位置：`src/commands/service.ts:70`、`src/commands/service.ts:143`。
- 其他位置：`src/commands/host.ts:13`、`src/commands/scan.ts:76-90`、`src/cache.ts:170`。
- 问题：`QuakeServiceDoc`、`QuakeHostDoc` 未进入解析路径。
- 各命令重复声明局部结构，再用 `as` 定型。
- 上游或缓存数据漂移时，命令可能崩溃或生成默认值。
- 建议：网络响应与缓存回放共用选择性 schema。
- 只校验消费字段，同时保留原始对象。
- 原始 L0 保持裸字符串，解析后的 DTO 才使用品牌。

### F05：API_SIZE_MAX 防线缺少完整数值域

- 位置：`src/commands/service.ts:19-20`、`src/commands/host.ts:48`。
- 游标位置：`src/commands/service.ts:109`、`src/commands/host.ts:109`。
- 其他位置：`src/commands/vuln-scroll.ts:12`、`src/commands/reference.ts:40-41`。
- 问题：`z.coerce.number()` 会接受 `-1`、`0`、`1.5`。
- search 与 domain 命令只检查上限。
- `API_SIZE_MAX` 的注释宣称 scroll 上限为 500。
- 该限额仍需用 API 文档或服务端样本确认。
- 聚合 `by` 未限制为最多 2 项。
- `icon.similar` 也未落实 0 至 1 的范围。
- 建议：在 zod 入口统一使用 `int()`、`min()`、`max()`。
- 按端点确认独立上限，并限制聚合字段数量。

### F06：isDocId 未校验端点语义，双形态丢失能力差异

- 位置：`src/types.ts:33-40`、`src/commands/compare.ts:20-32`。
- 问题：非法 IP 与越界端口仍能通过守卫。
- 探针确认 `999.999.999.999_999999_tcp` 可以通过。
- 零端口形式 `1.2.3.4_0_tcp` 也可以通过。
- compare 文档只承诺 `ip_port_transport` 形式。
- 统一 `DocId` 无法表达 compare 是否接受 24 位十六进制 ID。
- 同形 `DocId` 也必然通过 `isTaskId`，正则无法区分来源。
- 建议：校验 IPv4 各段，并限制端口为 1 至 65535。
- 按 API 能力拆分 ID 类型，或增加 compare 专用守卫。
- 通过响应来源和解析上下文区分 TaskId 与 DocId。
- IPv6 形态需取得真实样本后再扩展。

### F07：Scan 状态未联合化，结果接口会写入错误状态

- 位置：`src/archive.ts:92-103`、`src/commands/scan.ts:39-55`。
- 状态位置：`src/commands/scan.ts:119-122`。
- 问题：`scan-result` 用 `total > 0` 推导 `Done`。
- 完成但零结果的任务会被写成 `Running`。
- 运行中已有部分结果的任务会被写成 `Done`。
- 同一路径还把 `progress` 固定写为 `1`。
- `TaskId | ''` 会生成必然无效的状态查询 CTA。
- 建议：以 `scan-status` 的服务端状态为唯一权威。
- `scan-result` 只更新结果数量。
- 确认状态全集后建立 `ScanStatus`，保留未知状态原文。
- 任务 ID 解析失败时返回 `null` 或错误，不生成空 ID CTA。

### F08：RawMethod 不是闭集，CacheKey 与 TTL 类型链断开

- 位置：`src/types.ts:130-134`、`src/cache.ts:132-147`、`src/cache.ts:192-201`。
- 其他位置：`src/quake.ts:92-95`、`src/archive.ts:189-197`。
- 问题：``fields_${string}`` 接受任意后缀。
- `method as keyof typeof TTL_HOURS` 绕过穷尽检查。
- 新增方法会静默使用 TTL `0`。
- `cacheKey()` 返回裸 `string`，`CacheKey` 与 `isCacheKey` 未接入。
- `RunRecord` 写入路径也接收裸 `method` 和 `cacheKey`。
- 注释写 MD5，实现实际使用 SHA-256 并截断。
- 建议：抽取 `FieldsDataset` 闭集，限制字段方法后缀。
- 用 `satisfies Record<RawMethod, number>` 检查 TTL 表。
- 也可拆分可缓存方法与不可缓存方法。
- 让哈希构造器返回 `CacheKey`，并接入缓存读写与 `recordRun`。
- 历史未知数据库行另设读取 DTO，并修正哈希注释。

## 低严重度

### F09：限流持久化状态只有断言

- 位置：`src/ratelimit.ts:63-76`。
- 问题：除 `minIntervalMs` 外，数值字段缺少有效性检查。
- `updatedAt` 也未验证，损坏文件会进入等待与计数运算。
- 建议：增加 schema 解析和逐字段默认回落。
- `EpochMs`、`DurationMs` 品牌属于可选增强。

### F10：Month 的生产端绕过 isMonth

- 位置：`src/archive.ts:35-38`、`src/archive.ts:161-168`。
- 命令位置：`src/commands/fts.ts:38-47`。
- 问题：`2026-13.sqlite` 会被 `listMonths()` 断言为 `Month`。
- `dataMonth` 对异常 Date 或极端年份也不保证满足守卫。
- `fts` 中守卫后的 `as Month` 当前安全，但属于冗余断言。
- 建议：所有 Month 构造统一经过 `isMonth`。
- 文件列表使用 `filter(isMonth)`，命令保存窄化后的局部变量。

### F11：FTS 重新解析未校验的原始 ID

- 位置：`src/archive.ts:247-255`、`src/archive.ts:299-315`。
- 问题：`ftsUpsert` 未接收已经窄化的 `AssetRow.doc_id`。
- `ftsDocId` 从 `raw_json` 重取 ID，缺失时回落为 rowid 串。
- 这可能造成 FTS 行与资产行的 `doc_id` 不一致。
- 建议：直接传递 `assets.doc_id`，回填时同时查询该列。
- 显式处理历史坏行，不生成另一种 ID。

### F12：pickToken 的空串导致认证边界不一致

- 位置：`src/quake.ts:169-186`、`src/commands/account.ts:19-30`。
- 问题：只有 `user` 在请求前检查空 token。
- 其他网络命令会携带空 token 发请求。
- 建议：在请求层或统一 `requireToken` 中检查空 token。
- 返回 `NOT_AUTHENTICATED`，无需为 token 新增品牌。

## 覆盖建议

- `PaginationId` 可品牌化，并标记 scroll 数据集来源。
- 游标是不透明值，不应凭单个样本限制为 24 位十六进制串。
- `AggFacet` 来自可扩展字段面，不宜直接建立闭集。
- 优先校验聚合字段数量与数据集归属。
- 不应把 export SQL 品牌化为安全 SQL。
- `/^select/` 不是只读证明，只读保证应交给 SQLite。

## 守卫成本与保留建议

- 现有入口正则的成本相对网络与 SQLite 很低。
- 静态审查未发现明显的灾难性回溯。
- 建议保留 domain、cve、icon、ip、doc、task、month 守卫。
- `isCacheKey` 当前未执行，没有实际运行时开销。
- 若不接入 `CacheKey`，可删除这个未使用的守卫。
- 应删除守卫后的冗余断言，而不是删除守卫。
- 未发现 `as unknown as Brand` 双断言。
- 主要风险是 F01、F02、F04、F08 中的直接断言。
