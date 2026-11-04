# 排障手册(症状 -> 原因 -> 下一步)

> 按「你看到的」索引;命令级权威报错信息以 `--json` 输出的 code/message 为准(错误走 stderr,stdout 恒纯数据)。

## 认证与网络

| 症状 | code | 原因 | 下一步 |
|---|---|---|---|
| `未设置 QUAKE_API_KEY 环境变量` | NOT_AUTHENTICATED | token 三级回落全空 | `.env` 写 `QuakeAPIKey=<key>`(cwd 或用户配置目录)或导出环境变量;`quake-h doctor` 验证 |
| `HTTP 401/5xx` | HTTP_xxx | 服务端拒绝(token 无效或服务异常) | `quake-h user` 验 token;key 复制时带空格/引号是常见原因 |
| `网络错误: ...` | NETWORK_ERROR | 本地出网失败(代理/DNS/断网) | `quake-h doctor --net` 看探活;检查代理环境变量 |

## 限流与积分

| 症状 | code | 原因 | 下一步 |
|---|---|---|---|
| `调用API过于频繁` | q3005 | 撞服务端节流 | 稍等即可:自适应限流会自动退避(q3005 后间隔翻倍 + 静默期);`quake-h rate` 看当前节奏 |
| `自适应限流等待超限` | RATE_LIMITED | 静默期太长,等待超过一轮 | 稍后再试;急用可 `quake-h rate --reset` 复位(代价是失去学习到的节奏) |
| `积分不足` 类 message | 积分类错误 | 长效积分池耗尽 | `quake-h user` 看 persistent_credit;减少批量拉取,小 size 聚合代替(已实测免费:cve/icon/fields/syntax) |

## 权限(u/q 前缀服务端码)

| 症状 | code | 原因 | 下一步 |
|---|---|---|---|
| `Missing permission ...` | q3012 | 接口权限未开通 | compare 需 `front.api.doc.compare`,fast_scan 需 `front.api.fast_scan`,custom_scan 需 `front.api.custom_scan`(特权账户亦无);向 quake@360.cn 申请 |
| `没有查询指定索引数据的权限` | q2001 | 漏洞数据角色未开 | vuln-scroll 需漏洞数据角色 |
| `暂不支持该字段查询` | u3017 | 该字段不可检索 | `quake-h syntax <关键词>` 查可用字段;已知例:x_powered_by、runtime_id(裸名) |

## 参数与本地守卫(usage,退出码 1)

| 症状 | 原因 | 下一步 |
|---|---|---|
| `taskId 须为 24 位 hex` | 输入非任务 id 形 | 从 `scan` 返回或 `scan-ls` 取 task_id |
| `doc id 须为 ... 三形` | compare 输入非法 doc id | 从 service-search 结果 docs[].id 取 |
| `cveId 须为 CVE-YYYY-NNNN` | CVE 编号形错 | 核对编号格式 |
| `query 引号/括号未闭合` | 语法形校验拦截 | 检查引号配对;引号内括号不计数,含括号短语用双引号包裹 |
| `size 须为 1 到 500 的整数` | 积分护栏 | 批量改走 service-scroll 游标翻页 |
| `domainName 须为纯域名` | 检索语法注入防线 | domain 命令只收域名;复杂语法走 service-search |

## 结果为空/不符合预期

| 症状 | 原因 | 下一步 |
|---|---|---|
| 查询 total=0 但资产应存在 | 敏感词屏蔽(如 360 自有域名)或语法分词 | 换等价语法验证(`domain:*.gov.cn` 对照);裸词加引号防分词 |
| scan-result 恒空 | 常规目标无「风险项」,该端点非资产面 | 资产产出走 `service-search 'task.runtime_id:"<rid>"'`(延迟较高);见 advanced.md 扫描簿 |
| fts 搜不到刚查的 | 只索引已归档资产;或列截断 | 确认查询走了 service-search/domain(会归档);全文深挖用 export --sql + json_extract;旧库跑 `fts --backfill` |
| total 比预期大数倍 | `--no-latest` 查了全部历史观测(同资产多行) | 默认最新观测;要历史用 `--no-latest`(注意 `--latest false` 写法不生效) |
| 二跑 cache_hit: false | 参数变了(cache_key 含全部请求参) | 对比两跑的 cache_key;时间窗类参数是否取整(domain 已取整到天) |

## 环境与数据

| 症状 | 原因 | 下一步 |
|---|---|---|
| doctor 报目录不可写 | 权限/盘满 | 看 checks[].detail 路径;QUAKEH_HOME 指到可写位置 |
| doctor 报旧目录残留 | `~/.quake-h` 未清 | 内容已自动迁移,确认后手动删 |
| Windows 终端中文乱码 | 代码页非 UTF-8 | `chcp 65001` 或换 Windows Terminal |
