#!/usr/bin/env bun
/**
 * quake-h 薄入口:命令注册顺序 = 此文件调用顺序 = help/llms 面顺序。
 * 基础设施(cli 工厂/请求层/缓存包装)在 src/quake.ts,命令按族在 src/commands/。
 */
import { cli } from './quake'
import { registerAccountCommands } from './commands/account'
import { registerServiceCommands } from './commands/service'
import { registerCveCommands } from './commands/cve'
import { registerCompareCommands } from './commands/compare'
import { registerScanCommands } from './commands/scan'
import { registerVulnScrollCommands } from './commands/vuln-scroll'
import { registerHostCommands } from './commands/host'
import { registerReferenceCommands } from './commands/reference'
import { registerLocalCommands } from './commands/local'
import { registerDoctorCommands } from './commands/doctor'

registerAccountCommands(cli)       // user
registerServiceCommands(cli)       // service-search, service-scroll, service-agg
registerCveCommands(cli)           // cve
registerCompareCommands(cli)       // compare
registerScanCommands(cli)          // scan, scan-status, scan-result, scan-ls
registerVulnScrollCommands(cli)    // vuln-scroll
registerHostCommands(cli)          // host-search, host-scroll, host-agg, host-honeypot
registerReferenceCommands(cli)     // fields, icon
registerLocalCommands(cli)         // syntax, rate, cache, export
registerDoctorCommands(cli)       // doctor

// SIGINT/SIGTERM:清理后非零退出(Windows 下 SIGTERM 由 Bun 模拟)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// 仅作为入口执行时解析 argv;被测试导入时(bun test)跳过
if (import.meta.main) cli.serve()

// 注意:不要 `export default cli`——cli 带 .fetch 方法,Bun 会把它当
// Workers 应用自动起 dev server(端口 3000);CLI 场景不需要。
// `incur gen` 类型生成如需导入,改用具名导出。
export { cli }
