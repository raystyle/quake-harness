# quake-h

360 Quake 网络空间测绘 API 的 CLI 与 MCP 双形态工具。基于 Bun + incur + zod,同一命令注册表三面同源(CLI 人读面、`--json` 机器面、`--mcp` 工具面)。

查询即归档:每次 API 调用自动落本地缓存(TTL 内零积分复跑)与 SQLite 资产库,支持流式 Parquet 导出离线分析。

## 快速开始

```sh
git clone https://github.com/raystyle/quake-harness && cd quake-harness
bun install
cp .env.example .env        # 填入你的 API Key(见下节)
bun src/cli.ts user         # 验证凭据与积分
```

或直接用编译好的单文件二进制(无需 Bun):从 Releases 下载,或自行构建:

```sh
bun build --compile --minify --sourcemap src/cli.ts --outfile dist/quake-h
```

## 环境变量与 .env 设置

### 获取 API Key

登录 Quake(默认对接企业版 `qiye.quake.360.net`,公共版用 `QUAKE_HOST` 覆盖),进入个人中心,在 API Key 页面复制 Key(UUID 形)。

### .env 方式(推荐,本地开发)

`.env` 放**你运行命令时所在的目录**(即当前工作目录 cwd)。最常见的两种位置:

| 使用方式 | .env 放哪 | 说明 |
|---|---|---|
| `bun src/cli.ts ...`(源码开发) | **项目根目录** `D:\quake-harness\.env` | 在项目根里跑命令时,Bun 自动加载 cwd 的 `.env` |
| 编译版 `quake-h.exe ...` | **你调用 exe 的 cwd**,或改用环境变量 | exe 不绑定项目目录;若 exe 拷到别处/加入 PATH,从任何目录跑都只读那个目录的 `.env` |

注意:Bun 的 `.env` 自动加载**跟 cwd 走,不跟脚本路径走**——在项目根外跑 `bun /path/to/src/cli.ts` 是读不到项目 `.env` 的(实测验证),此时回到项目根执行,或用下面的环境变量方式。

在目标目录建 `.env`(文件名就叫 `.env`,无扩展名;已被 .gitignore 排除,不会进仓):

```sh
# 必填:API Key
QuakeAPIKey=你的key

# 可选:覆盖 API 域名(默认企业版;公共版填 https://quake.360.net)
# QUAKE_HOST=https://quake.360.net

# 可选:迁移数据根目录(缓存/归档/限流状态,默认 ~/.quake-h)
# QUAKEH_HOME=D:/data/quake-h
```

`.env.example` 有完整模板:`cp .env.example .env` 后填 Key 即可。

### 环境变量方式(脚本/CI/编译版二进制/任意目录调用)

不依赖 cwd 的通用做法,直接导出标准变量:

```sh
export QUAKE_API_KEY=你的key          # 主变量名(Windows PowerShell:$env:QUAKE_API_KEY='...')
# 备用变量名:QUAKE_TOKEN(优先级低于 QUAKE_API_KEY)
```

MCP 场景同理:注册进 Claude Code 时,若启动命令不落在项目根,在 `.mcp.json` 的 `env` 字段里传 `QUAKE_API_KEY`。

### 优先级

Key 取用顺序:进程环境变量 `QUAKE_API_KEY` > `QUAKE_TOKEN` > cwd `.env` 的 `QuakeAPIKey`。域名与数据根同名环境变量覆盖(`QUAKE_HOST` / `QUAKEH_HOME`)。

### 验证

```sh
quake-h user    # 返回用户名/积分/角色即凭据有效;NOT_AUTHENTICATED 则检查上述设置
```

## 命令

| 命令 | 说明 | 积分 |
|---|---|---|
| `quake-h user` | 账户信息与剩余积分 | 免费 |
| `quake-h search <query>` | 服务数据实时查询(`--size` `--include` `--exclude` `--start/--end-time` `--shortcuts`) | 每条 1,24h 缓存 |
| `quake-h scroll <query>` | 深度游标翻页(`--pagination-id`),结果自动归档 | 每条 1 |
| `quake-h agg <query>` | 聚合统计(`--by service,country`,最多 2 字段) | 免费,7d 缓存 |
| `quake-h cve <CVE-ID>` | 漏洞库详情(`--fields` 过滤输出) | 免费,30d 缓存 |
| `quake-h host-search <query>` | 主机数据查询(每 IP 带 services 视图) | 每条 1,24h 缓存 |
| `quake-h host-scroll <query>` | 主机深度游标翻页 | 每条 1 |
| `quake-h host-agg <query>` | 主机聚合统计 | 免费,7d 缓存 |
| `quake-h host-honeypot <ip>` | 主机蜜罐启发式判断(本地) | 复用 host 缓存 |
| `quake-h fields <dataset>` | 服务端可筛选/聚合字段清单(service/host/service-agg/host-agg) | 免费,7d 缓存 |
| `quake-h icon <md5>` | favicon 相似度查询 | 免费 |
| `quake-h compare <id...>` | 多文档对比,至少 3 个 doc id | 需权限 |
| `quake-h scan <target>` | 主动扫描 | 需权限 |
| `quake-h scan-status <id>` / `quake-h scan-result <id>` | 扫描任务状态与结果 | 需权限 |
| `quake-h syntax [keyword]` | 检索语法字段参考(离线,129 字段 22 分组,`--list` 列分组) | 本地 |
| `quake-h rate` | 自适应限流节奏观测(`--reset` 复位) | 本地 |
| `quake-h cache` | 查询缓存历史(`--method` 过滤) | 本地 |
| `quake-h export` | 归档导出与离线分析(`--sql` 只读查询;`--as parquet --out file` 流式导出,内存受 `--row-group-size` 约束) | 本地 |

查询语法为 Quake 检索语法,如 `service: http AND country: "CN"`;字段面用 `quake-h syntax` 离线查。

## 缓存、归档与限流

每次查询自动走两层(设计详见 docs/cache_archive_design.md):

- A 层缓存:响应原样落 `~/.quake-h/raw/{method}/{yyyy-mm-dd}/{cache_key}.json`,TTL 内同参数直接回放,不扣积分;空结果不缓存
- B 层归档:`~/.quake-h/archive.sqlite`(bun:sqlite,WAL),assets 主键 doc_id UPSERT 更新 last_seen,raw_json 保留整行;query_runs 记每次调用与 scroll 断点
- `QUAKEH_HOME` 环境变量可迁移数据根;SQLite 主存(高频 UPSERT),`export --as parquet` 走 hyparquet 流式导出(SQLite 游标逐行喂入,峰值内存与总行数无关)
- 自适应限流:`~/.quake-h/ratelimit.json` 持久化 AIMD 节奏(成功线性加速到 800ms,q3005 指数退避到 5min 上限 + 30s 静默),跨进程共享,调用方无感;`quake-h rate` 观测与复位

## 输出协议

- 缺省 TOON(token 友好),`--json` 机器形,`--format yaml|md`,大结果配 `--filter-output` `--token-limit`
- 错误信封带 Quake 原生错误码(`q2001` 参数/积分、`q3012` 权限、`u3009` 缺参),失败 exit 1
- CTA 以『下一步:』提示后续动作

## Agent 接入

```sh
quake-h --llms          # 紧凑手册(命令树 + 参数 schema)
quake-h --mcp           # MCP stdio server(渐进披露)
quake-h mcp add         # 注册进 Claude Code / Cursor 等
quake-h skills add      # 生成并安装 skill 文件
```

MCP 面工具:`search_tools`(按能力找工具)→ `get_tool_details`(看 schema)→ `call_read_tool` / `call_write_tool`(执行)。

典型 agent 工作流:`syntax cert` 查字段 → `search 'cert:"xxx.cn"'`(缓存保护)→ `export --sql` 离线分析,全程一个工具。

## 测试

```sh
bun test                      # 全套 39 项:单元(缓存/归档/语法/限流)+ 离线集成 + API 冒烟 + Parquet 读回 + MCP stdio
```

API 冒烟需 `.env` 有效 Key;节流由自适应限流控制器负责(检验生产机制),受控 QUAKEH_HOME 隔离,不污染真实数据根;付费命令总成本约 10 积分。

## 构建

```sh
bun build --compile --minify --sourcemap src/cli.ts --outfile dist/quake-h
# 跨平台目标:--target=bun-linux-x64 / bun-windows-x64 / bun-darwin-arm64 等
```

## 权限说明

`compare` 与 `scan` 族接口需账户具备 `front.api.doc.compare` / `front.api.fast_scan` 权限,漏洞数据索引需漏洞数据角色;未开通时报 q3012/q2001。接口实测细节见 `docs/quake_api_notes.md` 与 `docs/compare_docs_api_notes.md`。
