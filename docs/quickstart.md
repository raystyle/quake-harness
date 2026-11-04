# 快速上手(agent / 新用户五分钟)

> 目标:从零到第一条查询与离线分析,不踩积分坑。命令均以 `quake-h`(或源码 `bun src/cli.ts`)调用。

## 1. 体检:环境就绪了吗

```sh
quake-h doctor          # token 链/目录/归档库/限流 七项离线检查
quake-h doctor --net    # 加免费探活:延迟 + 长效积分余量
```

`status: fail` 看 `checks[]` 里哪项红了;token 缺失按 detail 提示配 `.env`。

## 2. 认识命令面(免积分)

```sh
quake-h --llms          # 一屏命令手册,agent 自省入口
quake-h syntax cert     # 离线查检索语法字段(129 字段,不耗积分)
quake-h user            # 账户与积分(免费)
```

## 3. 第一条查询:低成本摸底,再小步付费

**先低成本摸底**(聚合会扣长效积分,与 size 正相关;size 3 起步验桶,别一上来付费拉文档):

```sh
quake-h service-agg 'app:"Nginx" AND country_cn:"中国"' --by service --size 3
```

**付费首查,最小步**(service-search 每条扣 1 长效积分,`--size 1` 起步):

```sh
quake-h service-search 'app:"Nginx" AND country_cn:"中国"' --size 1
```

护栏:`--size` 上限 500 且必须正整数(入口拦截);查询语法未闭合引号/括号本地 USAGE 拦截。域名任务用 `quake-h domain qq.com --size 5`(自动归档)。
默认 latest=true(每资产只取最新一次观测,量小省钱);要看资产历史观测用 `--no-latest`(注意:`--latest false` 字符串写法不生效,实测仍是 true;同资产多行,host 族会重复计费)。结果排序两种情况都是最新采集优先。

## 4. 已查即资产:离线复用

```sh
quake-h fts 'title:后台'            # 归档全文检索(零积分,详见 docs/fts.md)
quake-h export --sql 'SELECT count(*) FROM assets'
```

二跑同参数查询 `cache_hit: true` 是正常的(24h 缓存回放,不再扣积分)。

## 5. 下一步

- 狩猎方法论:[vuln_hunting_playbook.md](vuln_hunting_playbook.md)(L0-L3 分层确证,低成本定形付费抽样)
- 数据契约与目录:[advanced.md](advanced.md) / [data_contract_review.md](data_contract_review.md)
- 报错排障:[troubleshooting.md](troubleshooting.md)
