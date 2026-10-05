/**
 * 「快速命名」主路径的离线回归测试。
 *
 * 覆盖这次改造的四件事：
 * 1. 计划**总是**落盘（不再需要调用方传 outputPath）；
 * 2. 落盘同时记住「最近一次计划」，review / check / apply 可以省略路径；
 * 3. 显式 `paths` 仍然优先于「最近一次计划」；
 * 4. 计划里记住 seasonFolder，供执行后复验用同一口径。
 *
 * 全部离线（用 paths 试算，不联网），并使用隔离的 DSH_HOME。
 * 运行：node test/quick-flow-test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')

const SANDBOX_HOME = mkdtempSync(path.join(os.tmpdir(), 'media-naming-quick-'))
process.env.DSH_HOME = SANDBOX_HOME

const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: () => undefined,
  logger: { info: () => {}, warn: () => {} },
}

const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href)
plugin.apply(ctx, {})

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
const call = (tool, args = {}) => registered.get(tool).execute(args, { signal: undefined })

const PREFIX = '影视资源'
const SAMPLE = `${PREFIX}/动漫/示例动漫 (2018)/[Group][示例动漫][001][1080P].mp4`

// 1) 计划总是落盘，并落在配置目录的 plans/ 下
const planned = await call('media_naming_plan', { paths: [SAMPLE] })
check('plan 返回落盘路径', typeof planned.planPath === 'string' && planned.planPath.length > 0, planned.planPath)
check('plan 落盘文件确实存在', Boolean(planned.planPath) && existsSync(planned.planPath))
check('计划落在配置目录的 plans/ 下',
  String(planned.planPath).includes(`${path.sep}plans${path.sep}`), planned.planPath)

const planJson = planned.planPath ? JSON.parse(readFileSync(planned.planPath, 'utf8')) : {}
check('计划里记住了 seasonFolder（复验要同一口径）',
  typeof planJson?.scope?.seasonFolder === 'boolean', JSON.stringify(planJson?.scope))

// 2) review / check 可以省略路径
const reviewed = await call('media_naming_review')
check('review 可省略 planPath（自动用最近计划）',
  reviewed?.review?.counts?.total === 1, JSON.stringify(reviewed?.review?.counts))

const checked = await call('media_naming_check', { step: 'plan' })
check('check step=plan 可省略 planPath', checked?.passed === true, JSON.stringify(checked?.checks))

// 3) apply 省略路径时，卡在「确认」而不是「找不到计划」
let applyMessage = ''
try {
  await call('media_naming_apply')
} catch (error) {
  applyMessage = String(error?.message ?? error)
}
check('apply 省略路径时提示的是「确认」而非「找不到计划」',
  applyMessage.includes('确认'), applyMessage)

// 4) 显式 paths 优先于「最近一次计划」
const both = await call('media_naming_review', {
  paths: [`${PREFIX}/电影/示例动画（2001）/示例动画（2001）.mkv`],
})
const bothWorks = (both?.review?.groups ?? []).map((group) => group.work).join(',')
check('显式 paths 优先于最近计划',
  both?.review?.counts?.total === 1 && bothWorks.includes('示例动画'), bothWorks)

// 5) 指针文件存在，供后续工具读取
check('plans 目录里有 latest.json 指针',
  Boolean(planned.planPath) && readdirSync(path.dirname(planned.planPath)).includes('latest.json'))

const failed = checks.filter((one) => !one.ok)
for (const one of checks) {
  console.log(`[${one.ok ? 'OK' : 'FAIL'}] ${one.name}${one.ok ? '' : `（${one.detail}）`}`)
}
console.log('='.repeat(64))
console.log(`checks passed=${checks.length - failed.length} failed=${failed.length}`)
rmSync(SANDBOX_HOME, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
