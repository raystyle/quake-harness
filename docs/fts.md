# fts 归档全文检索

> 2026-11-04 · v0.2.0 引入;命令 `quake-h fts`,离线零积分零网络
> 定位:对「已经花积分查回来的资产」做本地全文检索,把一次性查询消费变成可复用的本地资产库

## 1. 为什么需要

service-search 每条扣 1 积分(长效积分池),查回来的资产进了 assets 月库,但 SQL 只能查结构列(ip/port/service_name/country)。页面正文里藏的高价值信号(title 里的壳名、body 里的 webshell 特征、server 头的产品指纹)在 raw_json 里,`export --sql` 要写 `json_extract` 才能碰。

fts 把这些文本列建成 SQLite FTS5 倒排索引,一条命令直接搜:

```sh
quake-h fts 'FilesMan'                       # 全列搜活壳特征
quake-h fts 'title:b374k'                    # title 列限定
quake-h fts 'server:"Apache" AND host:gov.cn'  # 布尔组合
quake-h fts 'body:phpinfo' --month 2026-11   # 定向单月库
```

## 2. 索引结构

- **虚表**:`assets_fts`(独立 FTS 表,非 external content),按 `assets.rowid` 关联主表
- **可检索列**:`title` / `body` / `server` / `host`,从 raw_json 的 `service.http.*` 提取
- **截断**(控库容的取舍,检索词落在截断尾部会漏检;全文在 raw_json 可 SQL 补查):

| 列 | 截断 | 依据 |
|---|---|---|
| title | 500 字符 | 页面标题极少超此长 |
| body | 8000 字符 | 覆盖首屏与关键标记;超长正文截断 |
| server | 200 字符 | Server 头 |
| host | 300 字符 | vhost 域名 |

- **同步**:upsertAssets 每行 UPSERT 后同步回填(同 rowid 先删后插,幂等);assets 删行经触发器联动;**注意坑**:ON CONFLICT DO UPDATE 的 `lastInsertRowid` 指向冲突探测行而非被更新行,FTS 定位必须按 doc_id 查 rowid(测试驱动发现,已修)
- **懒建**:月库首次被 getMonthDb 打开时建虚表;存量行需 `--backfill` 或 `backfillFts()` 回填(幂等,重跑跳过已填)

## 3. 检索语义

- **语法**:FTS5 MATCH 表达式全支持:裸词(全列 OR)、列限定(`title:b374k`)、短语(引号防分词,**值含点号必须引号**:`host:"qq.com"`,裸写 `host:qq.com` 报 fts5 syntax error)、布尔(AND/OR/NOT)、前缀(`web*`)
- **跨月**:按月库升序逐库 MATCH,凑满 `--size`(默认 20)即止;**应用层循环聚合,非 SQL UNION**。
  取舍:无全局 bm25 排序(结果按月库序 + 库内序,不是相关性全局排),换来「新数据优先场景只碰最近一两个库」的短路;对比 export --sql 走 ATTACH + UNION ALL 子查询(单连接 SQL 联合,ORDER BY 全局有效)
- **返回**:命中行带 `month`(来源月库)/ doc_id / ip / port / title / snippet(命中列高亮,`[词]` 标记)
- **过滤**:空文本占位行(FTS 四列全空的资产,如非 http 服务)不返回

## 4. 典型工作流

```
1. 花积分圈资产      service-search 'app:"PHP" AND app_version:"8.4.13"' --size 100
                     (命中自动归档 + FTS 同步)
2. 离线挖特征        fts 'title:b374k' / fts 'body:FilesMan' / fts 'server:"Apache"' 
3. 深挖单条          export --sql "SELECT ... FROM assets WHERE ip = '...'"
                     (raw_json 全文在此,FTS 截断的尾部也能查)
4. 回到引擎扩簇      service-search / icon(免费聚合验证量级)
```

与狩猎 playbook 的衔接:先免费聚合定桶,付费抽样即归档,归档即可 fts;后续同特征检索不再花积分。

## 5. 边界与已知限制

- 只索引**已归档**资产:没查过的资产搜不到(它不是引擎代理,是本地索引)
- 截断列的尾部漏检(见上表);要全文用 export --sql + json_extract
- 中文分词:FTS5 默认 unicode61 分词器,中文按字切分,短语检索用引号包整句
- 月库是只增的快照流:资产的 data_time 决定落在哪个月库,同 doc_id 重查只更新不重复
- `--backfill` 只补「FTS 行缺失」的行;历史坏行(错位写入期间的产物)需删虚表全量重建
