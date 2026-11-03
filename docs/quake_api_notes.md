# Quake 企业版 API 实测记录

更新:2026-11
域名:`https://qiye.quake.360.net`(企业版)
凭据:`.env` 的 QuakeAPIKey(见 README 环境变量章节)

## 常量表对应接口实测总表

| 常量 | 接口 | 方法 | 状态 | 说明 |
|---|---|---|---|---|
| QuakeSearchURL | `/api/v3/search/quake_service` | POST | 可用 | 实测 3 条扣 3 积分,doc id 形如 `ip_port_transport` |
| QuakeSearchScrollURL | `/api/v3/scroll/quake_service` | POST | 可用 | 同 search 参数,`pagination_id` 翻页(5 分钟有效),翻页时其余参数不可变 |
| QuakeVulnerabilityURL | `/api/v3/scroll/quake_vulnerability` | POST | 可用 | **仅裸文本/引号短语查询**,字段语法(app:、vul_cve_id:)报 u3017;游标翻页同 scroll |
| QuakeVulnerabilityInfoURL | `/api/v3/vulnerability/db/cve/detail/{cve}` | GET | 可用 | 免费,不扣积分;查不到返回 code 0 + 空 data |
| QuakeAggregationURL | `/api/v3/aggregation/quake_service` | POST | 可用 | `aggregation_list` 最多 2 个字段 |
| QuakeSubmitActiveScanURL | `/api/v3/fast_scan` | POST | 可用 | **query + port_list 必填**(缺 port_list 报 u3009);data 直接返回任务 id 字符串 |
| QuakeGetActiveScanInfoURL | `/api/v3/fast_scan/{id}` | GET | 可用 | 返回 status/progress/total/send/success/failed/status_records 时间线 |
| QuakeGetActiveScanResultURL | `/api/v3/fast_scan/result/{id}` | GET | 可用 | `?start=&size=` 分页,meta.pagination.total;任务 Running 中结果为空 |
| QuakeCompareDocURL | `/api/v3/search/compare/docs` | POST | 可用 | `doc_ids` 至少 3 个;返回多文档字段对比(control.scanner_hostname/service.name/task.* 等) |

## 权限说明

compare/scan 族需 `front.api.doc.compare` / `front.api.fast_scan` 权限,vulnerability 索引需漏洞数据角色,未开通时分别报 q3012/q2001。


## CVE 详情接口返回结构(实测 CVE-2021-44228)

```
GET /api/v3/vulnerability/db/cve/detail/CVE-2021-44228
Header: X-QuakeToken
```

返回 `data` 字段:

| 字段 | 实测值示例 |
|---|---|
| vul_qhv_id | QH-202112-811(Quake 漏洞库主键) |
| vul_cve_id | CVE-2021-44228 |
| vul_other_id | 其他库编号数组(CNVD/CNNVD/ExploitDB/CXSECURITY/PacketStorm) |
| vul_name | VMware vCenter Log4Shell 远程代码执行漏洞 |
| vul_hazard_rating | 高危 |
| vul_type | 代码注入 |
| vul_sample | 样本数组(本例为空) |
| vul_influence | 受影响厂商/产品/版本数组(product_catalog, product_level 等) |
| vul_solution_temp | 临时解决方案(补丁链接) |
| vul_solution_official | 官方解决方案 |
| vul_references | 参考链接数组 |
| vul_cpe | CPE 数组 |
| vul_description | {"en": ...}(英文描述) |
| vul_detail | 详细描述(本例空) |
| vul_creator | {"vul_author_id", "vul_author_name"} |
| vul_dork | Quake 检索语法 `app:"Apache"` |
| vul_public_date / vul_last_modified_date | 2021-12-10 10:15:09 / 2026-11-03 07:02:30 |
| vul_tags | 标签数组 |
| vul_plug / vul_poc / vul_plug_pocsuite | 企业用户专属,提示联系 quake@360.cn |

行为要点:

- 不存在的 CVE(如 CVE-0000-0000)返回 `code 0` + 空 `data {}`,不报错
- 该接口免费,实测未扣积分

## 权限说明

当前测试账户已开通全部接口权限(compare/scan 族/vulnerability 索引)。
未开通的账户调用会收到 q3012(权限码缺失)或 q2001(索引权限),需联系 Quake 管理员。

## 关联

- compare/docs 参数细节与错误码轨迹见 compare_docs_api_notes.md
- 通用请求格式(Header、错误码表、积分规则)以官方文档为准
