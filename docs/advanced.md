# 高级使用

面向深度用法与实现细节;安装配置见 README,命令全量自省用 `quake-h --llms` 与 `quake-h --help`。

## 环境变量全表

| 变量 | 作用 | 默认 |
|---|---|---|
| `QUAKE_API_KEY` | API Key(最高优先级) | 无 |
| `QUAKE_TOKEN` | API Key 备用名 | 无 |
| `QuakeAPIKey` | .env 里的键名(bun 自动加载 cwd) | 无 |
| `QUAKE_HOST` | API 域名 | https://qiye.quake.360.net |
| `QUAKEH_HOME` | 数据根总开关(便携/CI) | 平台标准目录(见下) |

Key 加载链:进程环境变量 > cwd `.env` > 用户配置目录 `.env`(回落层)。

## 数据目录

| 层 | Windows | Linux | macOS |
|---|---|---|---|
| config(.env 回落) | `%APPDATA%\quake-h` | `~/.config/quake-h` | `~/.config/quake-h` |
| data(月库/runs/限流) | `%LOCALAPPDATA%\quake-h` | `~/.local/share/quake-h` | 同左 |
| cache(raw TTL 缓存) | `%LOCALAPPDATA%\quake-h` | `~/.cache/quake-h` | 同左 |

`QUAKEH_HOME` 设置后三层落其下子目录;旧 `~/.quake-h` 首次启动自动迁移(便携模式跳过)。

Bun 的 `.env` 加载跟 cwd 不跟脚本路径:项目根外跑 `bun /path/src/cli.ts` 读不到项目 `.env`,回项目根或用环境变量。

## 缓存与归档架构

- A 层缓存:响应原样落 `{cache}/raw/{method}/{yyyy-mm-dd}/{cache_key}.json`;cache_key = sha256(method+query+参数稳定序列化),同参 32 位;TTL(search 24h/agg 7d/cve 30d/icon 7d)内回放零积分;空结果不落盘
- B 层归档:按数据时间分月库 `{data}/2026-11.sqlite`;`data_time` 为 Quake 采集时间(缺失回落观测时刻并打 `data_time_is_observed=1` 标),`first_seen`/`last_seen` 为本地观测;assets 主键 doc_id UPSERT,raw_json 整行保留
- `runs.sqlite`:query_runs(调用记录与 scroll 断点)、aggs(聚合快照)、scan_tasks(扫描任务簿)
- 跨月联邦:`export --sql` 的 `FROM assets` 自动改写为全部月库 UNION ALL 子查询

## 流式 Parquet 导出

```sh
quake-h export --as parquet --out assets.parquet                       # 全量
quake-h export --sql 'SELECT ip,port FROM assets WHERE country="中国"' --as parquet --out cn.parquet
```

SQLite 游标逐行喂 hyparquet-writer(fileWriter 1MB 块刷盘),峰值内存只受 `--row-group-size`(默认 10000)约束;类型推断 INT32/DOUBLE/BOOLEAN/字符串列。

## 自适应限流

`{data}/ratelimit.json` 持久化 AIMD 节奏,跨进程原子共享:

- 成功:间隔线性收紧(3s 起步,每次 -200ms,下限 800ms)
- q3005:间隔按连续次数指数翻倍(上限 5min)+ 30s 静默期
- 调用前未到点自动等待(超 2s 出 stderr 提示),调用方无感
- `quake-h rate` 观测,`--reset` 复位

## 长时扫描任务簿

```sh
quake-h scan example.com --port-list 80,443   # 提交并登记
quake-h scan-status <task_id>                 # 查状态,自动刷新任务簿
quake-h scan-result <task_id>                 # 取结果,回写计数
quake-h scan-ls [--status Running]            # 本地任务列表
```

实测:fast_scan 的 query 与 port_list 必填,任务 id 在响应 message 字段(24 位 hex)。

## MCP 接入细节

```json
{
  "mcpServers": {
    "quake-h": {
      "command": "/path/to/quake-h",
      "args": ["--mcp"],
      "env": { "QUAKE_API_KEY": "你的key" }
    }
  }
}
```

渐进披露三段式:`search_tools`(按能力找)→ `get_tool_details`(看 schema)→ `call_read_tool`/`call_write_tool`(执行)。部分命令归 write 类,别只试 read。

## 权限矩阵

| 接口 | 所需权限 | 未开通报错 |
|---|---|---|
| compare | front.api.doc.compare | q3012 |
| scan 族 | front.api.fast_scan | q3012 |
| vuln-scroll | 漏洞数据角色 | q2001 |

漏洞数据索引仅支持裸文本/引号短语查询,字段语法报 u3017。

## 测试与 CI

```sh
bun test        # 43 项;无 Key 时 API 冒烟自动 skip
```

CI 见 .github/workflows/release.yml:tag `v*` 触发,三平台测试矩阵 + 7 目标编译 + sha256 边车发布 Release。
