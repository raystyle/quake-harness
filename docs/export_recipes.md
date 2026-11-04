# export 食谱:SQL 到 Parquet 的常见任务

> `quake-h export`:对本地归档库(跨月 UNION ALL)跑只读 SQL,输出 json/csv/parquet。
> 前提:资产经 service-search/domain 查询自动归档;空库先查一圈。

## 0. 速查

```sh
quake-h export                                    # 库概览(行数/月表)
quake-h export --sql 'SELECT ...'                 # json 到 stdout
quake-h export --sql '...' --as csv --out x.csv
quake-h export --as parquet --out all.parquet     # 全表(结构列,不含 raw_json)
```

## 1. 资产统计:端点去重(勿按 doc_id 数)

doc_id 是文档键,同端点多 vhost 会多行;数资产按端点三件套:

```sql
-- 端点数(TCP/UDP 分计)
SELECT count(*) AS endpoints FROM (SELECT DISTINCT ip, port, transport FROM assets)

-- 只 DISTINCT ip+port 会误并 TCP/UDP;错误示范勿抄
```

## 2. 按月溯源

跨月查询自动带 `month` 列(来源月库):

```sql
SELECT month, count(*) AS docs FROM assets GROUP BY month ORDER BY month
```

## 3. 挖 raw_json 全文(FTS 截断之外的深查)

```sql
-- title 含关键词(FTS body 截断 8000 之外的正文在此可查)
SELECT ip, port, json_extract(raw_json, '$.service.http.title') AS title
FROM assets
WHERE json_extract(raw_json, '$.service.http.body') LIKE '%FilesMan%'

-- server 头分布
SELECT json_extract(raw_json, '$.service.http.server') AS server, count(*) AS n
FROM assets GROUP BY server ORDER BY n DESC LIMIT 20
```

## 4. 三时间轴分析

```sql
-- 降级数据占比(文档缺/非法 time 回落观测时刻的行)
SELECT month, sum(data_time_is_observed) AS fallback, count(*) AS total
FROM assets GROUP BY month

-- 采集时间分布(Quake 侧新鲜度)
SELECT substr(data_time, 1, 7) AS m, count(*) FROM assets
WHERE data_time_is_observed = 0 GROUP BY m ORDER BY m
```

## 5. 导出全量交付

```sh
# Parquet(分析端友好;行组 1 万,流式写)
quake-h export --as parquet --out assets.parquet

# 筛选子集
quake-h export --sql "SELECT ip, port, service_name, country FROM assets WHERE country = '中国'" --as parquet --out cn.parquet

# CSV 给表格工具
quake-h export --sql 'SELECT DISTINCT ip, port FROM assets' --as csv --out endpoints.csv
```

## 6. 边界

- 只读:仅接受 SELECT 前缀(前缀检查非沙箱,勿当安全边界)
- parquet 默认投影是结构列;要 raw_json 走 json 抽取 SQL 后再 --as parquet
- 空结果:json 返回 `rows: []`;parquet 拒绝生成文件(NOT_FOUND)
- 跨库层每行附 `month`;全局 ORDER BY 有效(区别于 fts 的月库序)
