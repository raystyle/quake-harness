# Quake API compare/docs 接口实测记录

日期:2026-11-03
域名:`https://qiye.quake.360.net`(企业版)
Key:`QuakeAPIKey`(.env)

## 接口:POST /api/v3/search/compare/docs

- Header:`X-QuakeToken: <key>` + `Content-Type: application/json`
- 参数:`doc_ids`,类型 `List[str]`,必需,长度必须大于 2(即至少 3 个)
- doc id 格式:`ip_port_transport`(如 `8.149.67.89_2121_tcp`),来自 `quake_service` 搜索结果每条记录的 `id` 字段
- 权限:需要 `front.api.doc.compare` 权限,缺权限报 `q3012 Missing permission [['front.api.doc.compare']]`
- 权限申请:联系 quake@360.cn

### 实测错误码轨迹

| 请求 | 返回 |
|---|---|
| GET 无参数 | `q5000 内部服务器发生错误` |
| POST `{}` | `u3009 Missing parameter 'doc_ids'` |
| POST `{"doc_ids":["<1个>"]}` | `q2001 参数 doc_ids 数组长度必须大于2` |
| POST `{"doc_ids":"<字符串>"}` | `q2001 存在无效的 doc id` |
| POST 2 或 3 个伪造 id | `q2001 存在无效的 doc id`(长度校验通过) |
| POST 3 个真实 id | `q3012 Missing permission front.api.doc.compare`(当前账户无权限) |

### 调用示例

```bash
# 1. 搜索拿 doc id(每条扣积分)
curl -s -X POST "https://qiye.quake.360.net/api/v3/search/quake_service" \
  -H "X-QuakeToken: $QuakeAPIKey" -H "Content-Type: application/json" \
  -d '{"query":"service: http","start":0,"size":3,"include":["ip","port"]}' \
  | python -c "import json,sys; [print(x['id']) for x in json.load(sys.stdin)['data']]"

# 2. 传入至少 3 个 doc id 做对比(需 front.api.doc.compare 权限)
curl -X POST "https://qiye.quake.360.net/api/v3/search/compare/docs" \
  -H "X-QuakeToken: $QuakeAPIKey" -H "Content-Type: application/json" \
  -d '{"doc_ids": ["8.149.67.89_2121_tcp", "47.99.142.226_2121_tcp", "147.224.236.5_2121_tcp"]}'
```

## 账户状态(user/info 实测,新 key)

- `credit: 50000`,`month_remaining_credit: 50000`,`free_query_api_count: 20`
- - 搜索接口正常(3 条扣 3 积分,doc id 形如 `ip_port_transport`)
- compare 接口被权限挡住(q3012),该接口的权限校验先于积分扣费,探测参数不耗积分

## 结论

compare/docs 是 Quake 服务数据的多文档对比接口:POST,JSON body 传 `doc_ids`(至少 3 个,值为 `quake_service` 返回的 `id` 字段)。当前账户需要开通 `front.api.doc.compare` 权限(联系 quake@360.cn)才能拿到返回 data。
