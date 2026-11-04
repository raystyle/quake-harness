import { z } from 'incur'
import { cachedQuake, pickToken, stringList, toAssetRow, type QuakeCli } from '../quake'
import { getDb, upsertAssets } from '../archive'
import { isDomainName, type DomainName } from '../types'

/**
 * 域名族:domain(对齐官方 Rust CLI quake_rs 的 domain 子命令语义)
 *
 * 实现:domain:*.<域名> 语法查服务数据(无独立端点),默认展示
 * host/ip/port/title;官方过滤旗标映射为服务端 Web 过滤器 shortcuts id
 * (与 quake_rs 源码同值,值来源于 Quake web 端)。
 */

/** 官方 quake_rs 同款 Web 过滤器 id(cdn/蜜罐/无效请求;与 quake_rs 源码同值)
 *  注:quake_rs 还有第四个去重 id 610ce2fb…,实测该 shortcut 单独即令 total=0
 *  (服务端过滤器异常,非本地问题),故不接入;去重需求走 --include 手选字段 */
const SHORTCUTS = {
  cdn: '612f5a5ad6b3bdb87961727f',
  honeypot: '610ce2adb1a2e3e1632e67b1',
  filterRequest: '62bc12b70537d96695680ce5',
} as const

export function registerDomainCommands(cli: QuakeCli): void {
  cli.command('domain', {
    description: '查一个域名的全部资产(语法 domain:*.<域名>,对齐官方 quake_rs domain 子命令)',
    hint: '官方 Rust CLI 同名命令的便捷封装:本质是服务数据查询,每条结果扣 1 积分(24h 缓存)。',
    args: z.object({
      domainName: z.string().describe('要查询的域名,如 360.cn(自动组 domain:*.360.cn)'),
    }),
    options: z.object({
      start: z.coerce.number().default(0).describe('结果下标偏移'),
      size: z.coerce.number().default(10).describe('返回条数,官方上限 100'),
      fields: stringList('展示字段,逗号分隔:host,ip,port,title(官方 --type 同款)').optional(),
      noCdn: z.boolean().default(false).describe('剔除 CDN 数据'),
      noHoneypot: z.boolean().default(false).describe('剔除蜜罐数据'),
      filterRequest: z.boolean().default(false).describe('剔除无效请求(400/401/403 等)'),
      ignoreCache: z.boolean().default(false).describe('忽略缓存取最新(官方 latest_data 同款)'),
    }),
    alias: { size: 'n', fields: 't' },
    examples: [
      { args: { domainName: '360.cn' }, description: '查 360.cn 全部子域资产' },
      { args: { domainName: '360.cn' }, options: { size: 50, noCdn: true, noHoneypot: true }, description: '剔 CDN/蜜罐,取 50 条' },
    ],
    async run(c) {
      const token = pickToken(c)
      const o = c.options
      if (o.size > 100) {
        return c.error({
          code: 'USAGE',
          message: 'size 上限 100(官方同款;更多走 service-scroll 深度翻页)',
          retryable: false,
        })
      }
      // 域名守卫:纯域名形校验,同时拦截查询语法注入(OR/冒号等会改变查询语义)
      if (!isDomainName(c.args.domainName)) {
        return c.error({
          code: 'USAGE',
          message: 'domainName 须为纯域名(如 qq.com),不支持查询语法拼接',
          retryable: false,
        })
      }
      const domain = c.args.domainName as DomainName
      const query = `domain:*.${domain}`
      const shortcuts: string[] = []
      if (o.noCdn) shortcuts.push(SHORTCUTS.cdn)
      if (o.noHoneypot) shortcuts.push(SHORTCUTS.honeypot)
      if (o.filterRequest) shortcuts.push(SHORTCUTS.filterRequest)

      const body: Record<string, unknown> = {
        query,
        start: o.start,
        size: o.size,
        ignore_cache: o.ignoreCache,
        latest: o.ignoreCache,
        // 官方默认只看近一年数据(时间格式对齐 getdate:"%Y-%m-%d %H:%M:%S")
        start_time: new Date(Date.now() - 365 * 864e5).toISOString().replace('T', ' ').slice(0, 19),
        end_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
      }
      if (shortcuts.length) body.shortcuts = shortcuts

      const { json, cacheHit, rawPath, cacheKeyStr } = await cachedQuake(
        'search',
        query,
        body,
        token,
        { method: 'POST', path: '/api/v3/search/quake_service', body },
        { noCache: o.ignoreCache },
      )
      const typed = json as { data?: unknown[]; meta?: { pagination?: { total?: number } } }
      const items = typed.data ?? []
      // 与 service-search 同契约:命中即归档(缓存命中不重复扣行)
      const rows = items.map(toAssetRow).filter((r): r is import('../archive').AssetRow => r !== null)
      const archived = cacheHit ? 0 : upsertAssets(getDb(), rows)
      return {
        total: typed.meta?.pagination?.total ?? null,
        count: items.length,
        cache_hit: cacheHit,
        archived,
        cache_key: cacheKeyStr,
        raw_path: rawPath ?? null,
        docs: items.map((it) => {
          const d = it as {
            ip?: string; port?: number; time?: string
            service?: { http?: { host?: string; title?: string } }
          }
          return {
            domain: d.service?.http?.host ?? '',
            title: d.service?.http?.title ?? '',
            ip: d.ip ?? '',
            port: d.port ?? null,
            time: d.time ?? '',
          }
        }),
        cta: {
          description: '下一步:',
          commands: [
            { command: 'service-scroll', args: { query }, description: '深度翻页拉取更多' },
            { command: 'service-agg', args: { query }, description: '聚合统计分布(免费)' },
            { command: 'fts', args: { match: `host:"${domain}"` }, description: '归档全文检索该域名' },
          ],
        },
      }
    },
  })
}
