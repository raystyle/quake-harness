# 缓存与归档设计

状态:已实现(两层缓存归档 + 按月分库 + 跨月联邦查询)

## 业界先例摘要

| 项目 | 做法 |
|---|---|
| Shodan CLI 官方 | download 落 json.gz,parse 离线抽字段;同查询落盘后不再耗积分 |
| Shodan InternetDB | 单文件 SQLite 离线查 IP 端口/漏洞 |
| Shodan2DB | JSON 导入 SQLite;漏洞去重键 ip+cve |
| Search-Tools | 结果留 5 天省积分 |
| GoFOFA / superfofa | dump 到 json/csv;SQLite 存查询历史;断点续传 |

共性:原始响应原样落盘为第一层(省额度可重放),结构化库(SQLite/Parquet)为第二层(离线分析);资产去重键 = ip:port 类身份,查询缓存键 = engine+query+params;增量靠游标续拉或同键 UPSERT。

## 两层设计(定稿)

### A 层:查询缓存(省额度)

- cache_key = sha256(method + normalized_query + sort + include + 分页游标语义)
- 值:原始响应 body + quota meta + fetched_at
- 落盘:raw/quake/{method}/{yyyy-mm-dd}/{cache_key}.json
- TTL:search 短(参考 5 天),agg/cve 长;命中且未过期跳过网络

### B 层:资产归档(离线分析,SQLite)

- tables: query_runs, assets, asset_cves, aggs
- assets 主键 ip+port+transport(可加 hostname/service_name),UPSERT;保留 raw_json 列防字段演进丢数据
- cve 主键 cve_id;资产漏洞关联 ip+cve
- agg 不拆资产行,按 query_key+facet+bucket 存快照
- 增量:scroll 用 pagination_id 续拉,断点写 query_runs.cursor;定期重跑同查询做 diff(新增/消失资产)

## 参考实现要点(业界同类工具)

- parquet 库:hyparquet ^1.31 + hyparquet-writer ^0.16,纯 JS,Bun 可用;列全 STRING 写,全量读进内存,所以每次 ingest 一个小 parquet 而非单库滚动
- raw 层:每次 ingest 新文件 {ISO8601 去:}-{3 字节 hex}.json,不删 raw,靠 pack 备份;rotate 只管日志
- locator 去重:sha256(source + url 或 post_id)[:32],同 locator 先删后写
- 归档多版本并存:按 url 取 ingested_at 最新行回读

## 命令面规划(未实现)

```
quake-h cache ls|get          # 按 cache_key/query 读原始
quake-h archive upsert        # 规范化进 SQLite
quake-h export --format csv|parquet   # 离线导出
```

## 边界

Quake 结果是结构化资产,主存走 SQLite/Parquet,不进 skh 的向量层;若要在 skh 侧搜到资产,做细薄投影(source=quake, url=quake://ip:port)即可。

## 来源

业界:Shodan CLI/InternetDB 文档、Shodan2DB、Search-Tools、GoFOFA、superfofa、uncover
要点:locator 去重(源+内容哈希)、raw 层一次一文件不删、parquet 小文件碎片化策略
