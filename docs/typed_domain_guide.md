# 领域知识进类型系统:落地对照(本仓实践版)

> 2026-11-04 · 对照通用模式指南,盘点 quake-harness 已用/待用/不适用
> 上游指南六件套:品牌类型、可辨识联合、类型守卫、模板字面量、智能构造器 + Zod、as const + satisfies

## 一、已落地(与通用模式的对应)

| 通用模式 | 本仓落地 | 位置 |
|---|---|---|
| 品牌类型 | `Brand<T,B>` 八品牌:DocId/TaskId/CacheKey/Month/DomainName/CveId/FaviconHash/IpCidr;DataTime/SeenTime(时间轴禁互串) | src/types.ts |
| 类型守卫(伴生智能构造器) | 守卫即校验即铸造唯一入口:isDocId(三形态)/isTaskId/isMonth/isDomainName(兼注入防线)/isCveId/isFaviconHash/isIpCidr | src/types.ts |
| 字面量联合(闭集) | Transport('tcp'/'udp')、RawMethod(含 `fields_${FieldsDataset}` 模板字面量)、CacheableMethod、FieldsDataset | src/types.ts |
| as const + satisfies | TTL_HOURS `satisfies Record<CacheableMethod, number>` 穷尽闭合(新增可缓存方法漏配 TTL 编译失败) | src/cache.ts |
| 智能构造器 + Zod(边界) | API 入口守卫 -> Brand 域;响应侧 detectQuakeError/parseListBody/parseAggBody 选择性解析(passthrough 保留原文) | src/schemas.ts + 各命令 |
| 守卫即校验的失败语义 | toAssetRow 返 null 拒收非法 id;upsertAssets 自防御二次防线 | src/quake.ts + archive.ts |

## 二、可辨识联合

**已用近似**:Quake 信封成功/失败由 `detectQuakeError` 返回 `null | {code,message}` 二态,命令侧 null 检查即收窄。

**已升级(2026-11-04 落地,commit 6bd49d1)**:

1. ~~ScanStatus 判别联合~~:src/types.ts `scanStatus()`,known 闭集
   Calculating/Running/Paused/Finished(仅实测+官方钉死;假设词不占位,未知走 unknown 兜底) + {kind:'unknown';raw} 兜底;
   词表证据见下表。scan-result 不再推导状态(只更新 result_count)。
2. ~~QuakeEnvelope 判别联合~~:src/schemas.ts `parseEnvelope()` 返回
   {kind:'ok';body}|{kind:'err';code,message},quakeRequest 消费侧 switch 收窄;
   detectQuakeError 保留为 err 判别便捷形。
3. ~~EndpointDocId 模板字面量~~:src/types.ts,类型层端点形约束。

**ScanStatus 词表证据表**(服务端原词,采集于 2026-11-04 真实任务 6aea9f2f…):

| 词 | 来源 | 证据强度 |
|---|---|---|
| Calculating | status_records 时间线(「加载扫描任务配置」) | 实测直查 |
| Running | scan-status 顶层 status(任务 6ae98749…/6aea9f2f…) | 实测直查 |
| Paused | scan-status 顶层 status(任务 6ae98749…) | 实测直查 |
| Finished | 官方 API 文档明示「Finished 表示已完成」(fast_scan/custom_scan 详情响应注释) | 官方文档 |
| 其他词(Stop/Fail 等) | 不预置假设词;未观测到的状态一律落 {kind:'unknown';raw} 兜底,实测到再升级 known | 设计裁定(用户 2026-11-04) |
| Unknown | 本地兜底词(scan-status 缺 status 字段时构造),非服务端词 | 代码定义 |

doctor 检查项维持半可辨识(status 判别键 + 统一 detail 形),完全联合收益低暂不升级。

## 三、模板字面量:已用一处,可扩展

- 已用:`fields_${FieldsDataset}`(RawMethod 成员)。
- 可扩展:`type AssetEndpoint = \`${string}_${number}_${Transport}\``(doc_id 端点形,当前 isDocId 正则承担;升级为类型层可让 join(',') 拼接场景编译期校验)。
- 不建议:Query 语法串不品牌化(kimi review 结论一致:`/^select/` 不是只读证明,安全交给 SQLite authorizer 而非类型伪装)。

## 四、反模式自查(kimi review 抓到的即此类)

| 反模式 | 本仓案例 | 处置 |
|---|---|---|
| 到处 as Brand | toAssetRow 曾 `'' as DocId` 空串偷渡 -> 月库主键碰撞(F01) | 改守卫窄化 + null 拒收 |
| 双断言 as unknown as | 无(kimi 复查确认) | 保持 |
| 内部重复运行时校验 | 守卫后冗余 as(fts --month 窄化局部变量保留一处,防 isMonth 演进) | 已最小化 |
| 布尔标志表互斥态 | data_time_is_observed(列约束,非类型问题) | TimeAxis 接口已类型化注释 |

## 五、新增代码的类型化检查单

1. 跨边界标识符:先查 src/types.ts 有无对应品牌,没有则新建(类型 + 守卫 + 注释写实测形态依据)
2. 状态字段:能否穷举?能则字面量联合 + satisfies;不能则 `{kind:'known'}|{kind:'unknown';raw}` 联合
3. 响应消费:一律走 src/schemas.ts 解析器,新响应形加解析器而非命令内 as
4. 配置常量:as const + satisfies 穷尽
5. as 双断言 = 代码味道,review 必拦
