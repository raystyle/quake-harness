# quake-harness

360 Quake 网络空间测绘 API 的 CLI 与 MCP 双形态工具(Bun + incur + zod),命令名 `quake-h`。查询即归档:自动落本地缓存与 SQLite 按月资产库,支持流式 Parquet 导出,自适应限流护航。

## 安装

二进制(无需 Bun):从 [Releases](https://github.com/raystyle/quake-harness/releases) 下载对应平台(linux-x64/arm64/musl、windows-x64/arm64、darwin-x64/arm64,附 sha256),按下面「加入 PATH」部署后即可全局使用 `quake-h`。

### 各系统加入 PATH

**Linux**:

```sh
curl -LO https://github.com/raystyle/quake-harness/releases/latest/download/quake-h-linux-x64
chmod +x quake-h-linux-x64
sudo mv quake-h-linux-x64 /usr/local/bin/quake-h
quake-h --version
```

**macOS**(Apple Silicon 为例,首次运行如遇 Gatekeeper 拦截见下方说明):

```sh
curl -LO https://github.com/raystyle/quake-harness/releases/latest/download/quake-h-darwin-arm64
chmod +x quake-h-darwin-arm64
sudo mkdir -p /usr/local/bin
sudo mv quake-h-darwin-arm64 /usr/local/bin/quake-h
quake-h --version
```

Gatekeeper 拦截(未签名二进制)时执行:`sudo xattr -d com.apple.quarantine /usr/local/bin/quake-h`

**Windows**(PowerShell):

```powershell
# 建独立目录并下载(示例 x64;ARM 机换 quake-h-windows-arm64.exe)
mkdir $env:LOCALAPPDATA\quake-h-bin -Force
Invoke-WebRequest https://github.com/raystyle/quake-harness/releases/latest/download/quake-h-windows-x64.exe -OutFile $env:LOCALAPPDATA\quake-h-bin\quake-h.exe

# 加入当前用户 PATH
[Environment]::SetEnvironmentVariable('Path', $env:Path + ';' + "$env:LOCALAPPDATA\quake-h-bin", 'User')

# 重开终端后生效
quake-h --version
```

**源码方式**(需 [Bun](https://bun.sh)):

```sh
git clone https://github.com/raystyle/quake-harness && cd quake-harness
bun install
bun src/cli.ts user        # 开发运行;alias quake-h='bun /path/to/quake-harness/src/cli.ts' 可全局
```

## 配置

1. 登录 Quake 个人中心,复制 API Key
2. `cp .env.example .env`,填入:

```sh
QuakeAPIKey=你的key
```

`.env` 放运行命令时的 cwd(源码开发即项目根)。二进制全局部署后,推荐放用户应用数据目录(Windows `%APPDATA%\quake-h\.env`,Linux `~/.config/quake-h/.env`,macOS `~/Library/Application Support/quake-h/.env`),任意目录都能读到。也可用环境变量 `QUAKE_API_KEY`(优先级更高,适合 CI)。

验证:

```sh
bun src/cli.ts user    # 或二进制 quake-h user
```

## 基础使用

```sh
quake-h service-search 'service: http AND country: "CN"' --size 5   # 服务查询(每条 1 积分,24h 缓存)
quake-h host-search 'ip:"1.2.3.4"'                          # 主机查询(带端口服务视图)
quake-h domain qq.com --size 10                             # 域名资产(官方 quake_rs 同款,剔 CDN/蜜罐)
quake-h service-agg 'app:"Nginx"' --by country              # 聚合切面(免费)
quake-h cve CVE-2021-44228                                  # CVE 详情(免费)
quake-h syntax cert                                         # 检索语法离线查(129 字段)
quake-h export --sql 'SELECT count(*) FROM assets'          # 归档离线分析
quake-h doctor                                              # 环境体检(离线;--net 免费探活)
```

数据自动落平台标准目录(gh 模型 XDG/AppData),详见 docs/advanced.md。

## Agent 接入

```sh
quake-h --llms          # 紧凑手册,agent 自省入口
quake-h --mcp           # MCP stdio server(全部命令直出为常规 MCP 工具)
quake-h mcp add         # 注册进 Claude Code / Cursor 等
```

## 更多

命令全量与参数:`quake-h --help` / `--llms`;高级用法(数据目录、缓存归档架构、Parquet 导出、限流、扫描任务簿、MCP 细节、权限矩阵)见 [docs/advanced.md](docs/advanced.md)。漏洞测绘狩猎经验(L0-L3 分层确证、语法坑、噪声剔除)见 [docs/vuln_hunting_playbook.md](docs/vuln_hunting_playbook.md)。

测试 `bun test`(离线 fixture 回归 + API 冒烟;命令数与测试数以 `--llms` 与 `bun test` 实跑为准,不在此手维护);CI 打 tag `v*` 触发三平台编译发布。
