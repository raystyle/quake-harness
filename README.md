# quake-h

360 Quake 网络空间测绘 API 的 CLI 与 MCP 双形态工具(Bun + incur + zod)。查询即归档:自动落本地缓存与 SQLite 按月资产库,支持流式 Parquet 导出,自适应限流护航。

## 安装

二进制(无需 Bun):从 [Releases](https://github.com/raystyle/quake-harness/releases) 下载对应平台(linux-x64/arm64/musl、windows-x64/arm64、darwin-x64/arm64,附 sha256)。

源码:

```sh
git clone https://github.com/raystyle/quake-harness && cd quake-harness
bun install
```

## 配置

1. 登录 Quake 个人中心,复制 API Key
2. `cp .env.example .env`,填入:

```sh
QuakeAPIKey=你的key
```

`.env` 放运行命令时的 cwd(源码开发即项目根)。也可用环境变量 `QUAKE_API_KEY`(优先级更高,适合 CI/二进制任意目录调用)。

验证:

```sh
bun src/cli.ts user    # 或二进制 quake-h user
```

## 基础使用

```sh
quake-h search 'service: http AND country: "CN"' --size 5   # 服务查询(每条 1 积分,24h 缓存)
quake-h host-search 'ip:"1.2.3.4"'                          # 主机查询(带端口服务视图)
quake-h cve CVE-2021-44228                                  # CVE 详情(免费)
quake-h syntax cert                                         # 检索语法离线查(129 字段)
quake-h export --sql 'SELECT count(*) FROM assets'          # 归档离线分析
```

数据自动落平台标准目录(gh 模型 XDG/AppData),详见 docs/advanced.md。

## Agent 接入

```sh
quake-h --llms          # 紧凑手册,agent 自省入口
quake-h --mcp           # MCP stdio server
quake-h mcp add         # 注册进 Claude Code / Cursor 等
```

## 更多

命令全量与参数:`quake-h --help` / `--llms`;高级用法(数据目录、缓存归档架构、Parquet 导出、限流、扫描任务簿、MCP 细节、权限矩阵)见 [docs/advanced.md](docs/advanced.md)。

测试 `bun test`(43 项);CI 打 tag `v*` 触发三平台编译发布。
