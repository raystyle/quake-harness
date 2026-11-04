# 数据契约 Review:原始结构与本仓结构对照

> 2026-11-04 · 基于 raw 落盘真实样本(search/host_search/agg/vuln_scroll/cve/icon 各取最新落盘)+ 源码类型定义逐层核对
> 标注约定:[实测] = 落盘样本核对;[代码] = 源码事实;[推断] = 由前两者推出

## 0. 数据流总览

```
Quake API 信封            A 层缓存                 命令投影                B 层归档             导出面
code/message/data/meta -> {fetched_at, body}  ->  docs[] 紧凑视图    ->  assets 月库       ->  SQL 结果
  (原始响应,字段最全)      raw/<method>/<date>/      (人读/机器形输出)     query_runs/aggs      json/csv/parquet
                           <key>.json                                     scan_tasks
```

关键性质:**单向有损**。每一层都是上一层的投影;唯一的无损保全点是 A 层 raw 原文与 B 层 `raw_json` 列。

## 1. L0:Quake 原始响应契约 [实测]

### 1.1 统一信封

```ts
interface QuakeEnvelope<T> {
  code: string | number   // 0 = 成功;q3005 限流/q2001 权限/u3009 参数等
  message: string
  data: T
  meta?: {
    pagination?: { count: number; page_index: number; page_size: number; total: number }  // search/host 族
    pagination_id?: string                                            // scroll 族游标(5 分钟有效)
    total?: { value: number }                                          // scroll 族总量
  }
}
```

实现位置:`src/quake.ts` 的 `isQuakeError()` 只消费 code != 0 分支;data/meta 由各命令以 `as` 断言消费,无运行时校验。[代码]

### 1.2 服务文档(search/scroll 的 data[] 元素) [实测]

```ts
interface QuakeServiceDoc {
  id: string                  // 6aea744d3600298f35d503a2(24 位 hex;doc_id 主键)
  ip: string
  port: number
  transport: 'tcp' | 'udp'
  time: string                // 2026-11-03T23:54:53.393Z(Quake 采集时间)
  asn: number                 // 4837
  org: string                 // China Unicom
  domain: string              // 顶级请求域名(空串常见)
  hostname: string            // 服务文档里是 string;主机文档里是 string[](两态坑,见 3.2)
  is_ipv6: boolean
  location: QuakeLocation     // 18 键,见 1.3
  service: {
    name: string              // http / http/ssl 在 app 层面,此处为协议名
    version: string           // 1.1
    response: string          // 端口原始响应全文(信息最丰富)
    response_hash: string
    dns?: { a: string[]; support_ipv6: boolean }
    http?: QuakeHttp          // 25 键,见 1.4(非 http 服务无此键)
  }
  task: { runtime_id: string; task_id: string }
}
```

### 1.3 location(服务/主机/漏洞文档共用) [实测]

```ts
interface QuakeLocation {
  country_cn: string; country_en: string; country_code: string
  province_cn: string; province_en: string
  city_cn: string; city_en: string
  district_cn: string; district_en: string
  street_cn: string; street_en: string
  gps: [number, number]; radius: number
  isp: string; owner: string
  scene_cn: string; scene_en: string   // 数据中心/Hosting 等场景标签
}
```

### 1.4 service.http(25 键) [实测]

```ts
interface QuakeHttp {
  body: string                    // 页面正文(可能巨大)
  title: string; path: string; host: string
  status_code: number
  server: string                   // Server 头
  x_powered_by: string             // 有值但服务端不支持该检索字段(u3017,语法面坑)
  response_headers: string         // 原始响应头全文
  html_hash: string; header_order_hash: string
  robots: string; robots_hash: string
  sitemap: string; sitemap_hash: string
  favicon: { hash?: string; ... }  // md5
  dom_tree: object; cookie_element: object
  http_load_count: number; http_load_url: string[]
  page_type: string[]; page_type_2: string[]; page_type_keyword: string[]
  icp: object; meta_keywords: string
  data_sources: number
}
```

### 1.5 主机文档(host-search 的 data[] 元素) [实测]

```ts
interface QuakeHostDoc {
  id: string                  // 即 ip(非 hex doc id)
  ip: string
  asn: number; org: string
  hostname: string[]          // 注意:数组,与服务文档的 string 不同
  os_name: string; os_version: string | null
  is_ipv6: boolean
  location: QuakeLocation
  time: string
  services: Array<{          // 该 IP 全端口服务聚合视图
    port: number; name: string; transport: string; time: string
    // 实际样本还含 service 明细(缩略)
  }>
}
```

### 1.6 漏洞文档(vuln-scroll 的 data[] 元素) [实测]

```ts
interface QuakeVulnDoc {
  ip: string; port: number
  org: string; is_domain: boolean; is_ipv6: boolean
  domain: string; url: string
  time: string
  location: QuakeLocation
  vulnerability: {
    number: string[]             // QH-xxxx 漏洞 id 数组(命令投影为 vuln_ids)
    evidence_str: string         // 证据串(命令裁剪为 evidence_prefix 前 120 字)
    // 共 8 键
  }
  unit: object                   // 归属单位(9 键)
  task: object
}
```

### 1.7 其余数据形 [实测]

- cve 详情:data 为单对象,vul_qhv_id / vul_cve_id / vul_other_id[] / vul_name / vul_hazard_rating / vul_type / vul_influence[] / vul_solution_temp / vul_solution_official / vul_references[] / vul_cpe[](11 键全量)
- agg / host_agg:data 为 `{ [facet]: Array<{key, doc_count> } }`,facet 键即 aggregation_list 字段名
- icon:data 为 `Array<{key, doc_count, data}>`,data 为 favicon 的 base64

## 2. L1:A 层缓存契约 [代码]

```ts
interface CacheEntry {
  fetched_at: string    // ISO 时间,TTL 判据
  body: unknown         // Quake 信封原文(data+meta 之外的完整 body)
}
```

落盘形:`raw/<method>/<YYYY-MM-DD>/<md5(key)>.json`;method 为内部键(search/scroll/agg/host_search/vuln_scroll/cve/icon/fields_*),与命令名解耦(service-search 改名后缓存不作废即此设计)。[代码]

TTL 表(小时):search=24, scroll=0(不回放), host_search=24, host_scroll=0, agg/host_agg=168, cve=720, icon=168。[代码]

**契约状态**:`body: unknown` 即「信封内不校验」——回放时直接当新鲜响应用。风险:上游信封变更(字段改名/移位)不会被缓存层发现,只会以命令层 `undefined` 静默降级。[推断]

## 3. L2:命令投影契约

### 3.1 各命令输出形(代码中的实际返回形) [代码]

| 命令 | 投影 | raw 全量保留? |
|---|---|---|
| service-search | docs[]:id/ip/port/transport/service/country/time | 归档进 assets(raw_json) |
| service-scroll | docs[]:id/ip/port/service | 归档进 assets(raw_json) |
| service-agg | aggregations 原文透传 + saveAgg | raw 落盘 |
| host-search/host-scroll | hostRow:ip/asn/org/hostname/os/country/province/city/isp/time/services[]/raw_host | raw_host 保留全量 |
| host-agg | 同 service-agg | raw 落盘 |
| vuln-scroll | docs[]:ip/org/is_domain/vuln_ids/evidence_prefix(120 字)/raw | raw 保留全量 |
| domain | docs[]:domain/title/ip/port/time(近一年窗+shortcuts) | 归档进 assets |
| cve | data 原文透传(--fields 可选列) | raw 落盘 |
| compare/scan 族/fields/icon | data 原文或近透传 | icon raw 落盘 |

### 3.2 hostname 双态坑 [实测+代码]

服务文档 `hostname: string`,主机文档 `hostname: string[]`。`toAssetRow` 与 `hostRow` 均以 `Array.isArray(d.hostname)` 分支兼容。若上游将服务文档 hostname 改为数组,现有分支已兼容;反向(数组改标量)会走 join 之前先 Array.isArray=false 取原值,同样安全。[推断]

### 3.3 zod output 契约覆盖现状 [代码]

**仅 user 与 doctor 两命令声明了 output schema**;其余 21 个命令返回裸对象,输出形状只由 TS 推断与人工约定保证,`--json` 面无运行时校验。这是当前最大的契约空档:[推断] 输出字段改名/漏字段只会在消费方发现。

## 4. L3:B 层归档契约 [代码]

```ts
interface AssetRow {                    // 服务文档 -> 月库行
  doc_id: string                        // = QuakeServiceDoc.id
  ip: string; port: number | null
  transport: string; service_name: string   // = service.name
  hostname: string                      // 数组已 join(',')
  country: string                       // = location.country_cn
  time: string                         // = Quake 采集 time
  raw_json: string                     // 全量原文(无损保全点)
}
```

assets 月库表(YYYYMM.sqlite,按 data_time 分桶):

```sql
doc_id TEXT PRIMARY KEY, ip TEXT, port INTEGER, transport TEXT,
service_name TEXT, hostname TEXT, country TEXT,
data_time TEXT, data_time_is_observed INTEGER,   -- 三时间语义分离
first_seen TEXT, last_seen TEXT, raw_json TEXT
```

UPSERT 语义:同 doc_id 重查只推进 last_seen,不覆盖既有投影(幂等)。[代码]

三时间契约(src/types.ts `TimeAxis`,品牌类型 DataTime/SeenTime 禁互串):

| 列 | 语义 | 来源 | 变更规则 |
|---|---|---|---|
| `data_time` | Quake 引擎采集该资产的时刻 | 服务文档 `time` 字段 | UPSERT 跟进新文档时间 |
| `data_time_is_observed` | data_time 是否为回落值 | 文档缺 time 时置 1 | 与 data_time 同步 |
| `first_seen` | 本地首次观测(查询到)时刻 | 本地时钟 | UPSERT 永不改 |
| `last_seen` | 本地最近观测时刻 | 本地时钟 | 每次重查 UPSERT 推进 |

实数据验证:doc `116.228.18.70_4443_tcp` 的 data_time=2025-06-30(Quake 半年前采集)、first_seen=last_seen=2026-11-03(昨天首查)—— 两个时间轴相差 4 个月,语义分离在真实数据上成立。文档缺 time 的回落行 data_time_source 会标 `observed-fallback`,分析时可 `WHERE data_time_is_observed=0` 剔除降级数据。[实测]

其余三表(恒在 runs 库,不分月):
- `query_runs(ts, method, query, cache_key, total, count, pagination_id, raw_path)`:查询行为流水
- `aggs(query_key, facet, bucket_key, doc_count, ts)`:聚合快照,PK 含 ts 支持时序对比
- `scan_tasks(task_id PK, target, port_list, status, progress, total/send/success/failed, result_count, created_at, updated_at)`

**实体模型与唯一键**(实测钉死,统计口径由此定):

| 实体 | 唯一键 | 实测证据 |
|---|---|---|
| 服务文档 | `doc_id`(PK) | 同一端点多 vhost 即多行:81.70.185.165:8144 四行(s2.bytebytego.cn/allyworld.cn/lxgj/lingxiang 四个 vhost) |
| 资产端点 | `(ip, port, transport)` 业务复合键 | 全库 45 文档行 vs 38 端点:按 doc_id 数资产高估 18% |
| 域名资产 | `(domain, ip, port)`(domain 命令业务视角;经 doc_id 归档进 assets) | 实测 qq.com 查询即归档,`fts 'host:"qq.com"'` 立即可检 |
| 主机 | `ip`(host 文档 id 即 ip) | — |
| 扫描任务 | `task_id`(PK) | — |

结论:**doc_id 是文档去重键,不是资产数**。`export --sql` 统计资产量必须 `COUNT(DISTINCT ip || ':' || port)`,数文档行数只是「观测到的文档面」。类型层:`AssetKey` interface 表达端点身份三件套,`DocId` 注释明示非端点键。[实测+代码]

**domain 命令业务契约**(三件齐):
- 输入契约:`DomainName` 品牌类型 + `isDomainName` 守卫(纯域名形校验)。该守卫同时是 **Quake 语法注入防线** —— domain 以 `domain:*.<输入>` 直拼查询,`evil.cn OR service:telnet` 类输入会改变查询语义,入口即拦(USAGE)。[代码+实测]
- 数据契约:与 service-search 同链路,命中即归档(`archived` 字段 + assets 月库 + FTS 同步);缓存命中不重复扣行。[代码]
- 输出契约:docs[] {domain,title,ip,port,time} + archived + CTA(host 短语 fts 检索)。[代码]

**投影损失清单**(assets 可 SQL 直查列 vs raw_json):丢 asn/org/province/city/isp/scene/title/body/response 等;`raw_json` 全在,`export --sql` 可 `json_extract(raw_json, '$.service.http.title')` 补救。[实测+代码]

## 5. L4:导出面契约 [代码]

export 把用户 SQL 里 `FROM assets` 重写为跨月 UNION ALL 子查询(附 `month` 列);parquet 流式导出固定列集 = assets 全列;CSV 按 SQL 结果列。跨库层每行带 `month` 来源标注。

## 6. 契约强度总评与建议

| 层 | 契约形式 | 运行时校验 | 现状评价 |
|---|---|---|---|
| L0 原始响应 | 无(消费侧 `as` 断言) | 无 | 上游漂移静默降级,靠 raw 落盘事后可查 |
| L1 缓存 | CacheEntry 两键 | 无(body unknown) | 回放信任原文,fetched_at 是唯一元数据 |
| L2 命令输出 | TS 推断;仅 user/doctor 有 zod | 2/23 | **最大空档**:输出面无守卫 |
| L3 归档 | AssetRow 等四 interface + DDL | 无 | DDL 即契约,raw_json 兜底无损 |
| L4 导出 | SQL 结果集 | 无(SQLite 自身类型) | month 注入是唯一改写 |

建议(按性价比排序;1-5 已落地,标记状态):

1. ~~**标识符品牌类型化**~~ **已落地**(src/types.ts):`DocId/TaskId/CacheKey/Month/DomainName/CveId/FaviconHash/IpCidr` 八品牌 + 伴生守卫;`AssetRow.doc_id`、`ScanTaskRecord.taskId`、`dataMonth` 全链 Brand;闭集 `Transport/RawMethod/CacheableMethod/FieldsDataset` 字面量联合。实测收益:scan-status 传非法 id 现在入口 USAGE 快速失败,不再落服务端;domain 语法注入(`evil.cn OR service:telnet`)入口即拦。
2. **给查询族补 zod output schema**:已落地 4/24(user/doctor/fts/domain);其余命令以 L0/L1 响应解析器(见 4)先行闭合运行时契约,命令级 output schema 后续按需补。
3. ~~**QuakeServiceDoc/QuakeHostDoc 集中 interface**~~ **已落地**(src/types.ts),hostname 双态类型显式。
4. ~~**CacheEntry.body 收紧 + 响应选择性 schema**~~ **已落地**(src/schemas.ts):`detectQuakeError`(信封探测 + message 归一化,字符串 '0' 判成功)/`parseListBody`(列表形:items/total/paginationId,硬形漂移显式空态)/`parseAggBody`(聚合形)。网络路径与命令消费共用同一组解析器,service/host/domain/vuln-scroll/agg 全部脱离 `as` 断言;信封错误处理收敛单点。TTL_HOURS 经 `satisfies Record<CacheableMethod, number>` 穷尽闭合,keyof 断言已拆。
5. **积分事故防线** **已落地**:validSize 完整数值域(整数 1-500)入口拦截;domain 上限 100。
6. ~~**ratelimit.json 逐字段校验**~~ **已落地**:readState 数值域 finite/非负整数逐项回落,updatedAt ISO 可解析校验,损坏文件不再进运算。
7. 低优先:raw 落盘加 schema_version 字段(Envelope 内已可从 body 形状探测,暂无实际翻车案例)。

## 7. 样本来源 [实测]

- 服务文档:`raw/search/2026-11-03/`(domain qq.com --noCdn 等查询,含 http/dns 两协议样本)
- 主机文档:`raw/host_search/2026-11-03/`(103.198.42.236,8 services)
- 漏洞文档:`raw/vuln_scroll/2026-11-03/`(total 4,574,235)
- cve/agg/icon:同日期目录最新一份
