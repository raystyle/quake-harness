# Quake 企业版 API 实测记录

更新:2026-11
域名:`https://qiye.quake.360.net`(企业版)
凭据:`.env` 的 QuakeAPIKey(见 [README 配置节](../README.md#配置))

## 常量表对应接口实测总表

| 常量 | 接口 | 方法 | 状态 | 说明 |
|---|---|---|---|---|
| QuakeSearchURL | `/api/v3/search/quake_service` | POST | 可用 | 实测 3 条扣 3 积分,doc id 形如 `ip_port_transport` |
| QuakeSearchScrollURL | `/api/v3/scroll/quake_service` | POST | 可用 | 同 search 参数,`pagination_id` 翻页(5 分钟有效),翻页时其余参数不可变 |
| QuakeVulnerabilityURL | `/api/v3/scroll/quake_vulnerability` | POST | 可用 | **仅裸文本/引号短语查询**,字段语法(app:、vul_cve_id:)报 u3017;游标翻页同 scroll |
| QuakeVulnerabilityInfoURL | `/api/v3/vulnerability/db/cve/detail/{cve}` | GET | 可用 | 免费,不扣积分;查不到返回 code 0 + 空 data |
| QuakeAggregationURL | `/api/v3/aggregation/quake_service` | POST | 可用 | `aggregation_list` 最多 2 个字段 |
| QuakeSubmitActiveScanURL | `/api/v3/fast_scan` | POST | 可用 | 提交形三选一:query(检索语法)/ ip_list(数组)/ domain_list(数组);port_list 必填(缺报 u3009);建议 ip 与域名分开下两次(用户实践);响应 task_id 在 message |
| QuakeGetActiveScanInfoURL | `/api/v3/fast_scan/{task_id}` | GET | 可用 | 详情:id/runtime_id/progress/total/send/success/failed/status_records 时间线/end_time;状态机 Calculating -> Running -> Sent -> Finished(2026-11-04 九任务实测);顶层 status 翻牌滞后,完成判定看 Finished;API 不回显提交参数(target 仅存本地簿) |
| QuakeGetActiveScanResultURL | `/api/v3/fast_scan/result/{runtime_id}` | GET | 可用 | 路径参数是 **runtime_id**(详情端点 data.runtime_id,与 task_id 相邻减一);返回**扫描器风险项**,常规目标(含已收录资产、有洞资产)实测恒空;`?start=&size=` 分页。资产采集结果不走此端点 |
| CustomScanSubmitURL | `/api/v3/custom_scan` | POST | 需 `front.api.custom_scan` 权限(2026-11-04 实测特权账户也被 q3012 挡) | 自定义扫描:ip_list/domain_list/port/scanner_dict/worker_group 必填,priority 1-3 选填;响应同 fast_scan(task_id 在 message) |
| CustomScanInfoURL | `/api/v3/custom_scan/{task_id}` | GET | 同上权限(q3012) | 响应形同 fast_scan 详情(status=Finished 表示已完成) |

**扫描产出模型**(2026-11-04 九任务实验钉死):资产采集文档不即时入服务索引,
经 `task.runtime_id` 检索获取且**延迟较高**(用户确认的业务口径);扫描结果可能
归名到目标 IP 的既有活跃采集批次(复刻实验:我们扫的 IP 新文档挂原任务主 runtime)。
result 端点仅为风险项面,常规目标恒空(1.1.1.1/有洞资产/DVR 弱口令设备全测 0)。

**任务列表端点:不存在**(2026-11-04 探测)。fast_scan 与 custom_scan 均只有「新建 + 按 id 查详情/结果」;实测探测过的列表形(fast_scan/list、task_list、history、user/scan_tasks 等)全部 404 或参数错误。「查所有任务」只能靠本地任务簿(scan_tasks 表,scan-ls 命令)。
| QuakeCompareDocURL | `/api/v3/search/compare/docs` | POST | 可用 | `doc_ids` 至少 3 个;返回多文档字段对比(control.scanner_hostname/service.name/task.* 等) |

## 权限说明(统一口径)

| 接口族 | 权限 | 未开通表现 |
|---|---|---|
| compare(docs) | `front.api.doc.compare` | q3012 |
| fast_scan 族 | `front.api.fast_scan` | q3012 |
| custom_scan 族 | `front.api.custom_scan` | q3012(**特权账户亦无**,2026-11-04 实测) |
| 漏洞索引(vuln-scroll) | 漏洞数据角色 | q2001 |

当前账户(360_APT_Research 特权)状态:compare 与 fast_scan 可用;custom_scan 被 q3012 挡。


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
