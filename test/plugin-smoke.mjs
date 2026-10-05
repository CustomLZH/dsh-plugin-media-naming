/**
 * 插件冒烟测试：不安装到 profile，用 mock 上下文直接加载 index.js，
 * 验证 11 个工具注册成功、schema 合法、execute 能离线跑通。
 *
 * 覆盖五类能力：配置（L1）、规则/样例（知识）、解析/计划（计算）、
 * 流程/逐步校验（作业规范）、审核视图与方法（交给使用者）。
 *
 * 运行：node test/plugin-smoke.mjs
 * 退出码：全部通过为 0，否则为 1。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const OUT_DIR = path.join(PLUGIN_DIR, 'out', 'smoke')
const PREFIX = '影视资源'

// 用隔离的 DSH_HOME：测试既不依赖真实凭据，也绝不会真的去写网盘
const SANDBOX_HOME = mkdtempSync(path.join(os.tmpdir(), 'media-naming-smoke-'))
process.env.DSH_HOME = SANDBOX_HOME

const registered = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  get: () => undefined,
  logger: { info: () => {}, warn: () => {} },
}

const checks = []
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })

const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href)
check('导出 name / inject / apply', plugin.name === 'media-naming'
  && Array.isArray(plugin.inject) && plugin.inject.includes('tools')
  && typeof plugin.apply === 'function')

plugin.apply(ctx, {})

const EXPECTED = [
  'media_naming_config',
  'media_naming_flow',
  'media_naming_check',
  'media_naming_apply',
  'media_naming_review',
  'media_naming_rules',
  'media_naming_examples',
  'media_naming_parse',
  'media_naming_plan',
  'media_naming_verify',
  'media_naming_scan',
]
check('注册 11 个工具', EXPECTED.every((tool) => registered.has(tool)),
  `实际：${[...registered.keys()].join(', ')}`)

for (const tool of EXPECTED) {
  const definition = registered.get(tool)
  check(`${tool} 定义完整`, Boolean(definition)
    && typeof definition.description === 'string' && definition.description.length > 20
    && definition.parameters?.type === 'object'
    && typeof definition.output?.render === 'function'
    && typeof definition.execute === 'function')
}

/**
 * 模拟 DSH 注册表的「无损 JSON」校验：返回 true，或第一处问题的描述。
 * 解析结果里的 `undefined` 字段必须被净化，否则真实调用会报
 * `value is not lossless JSON`（直接调 execute 是发现不了的）。
 */
function losslessProblem(value, at = '') {
  if (value === undefined) return `${at || 'value'} 是 undefined`
  const type = typeof value
  if (type === 'function' || type === 'symbol' || type === 'bigint') return `${at || 'value'} 是 ${type}`
  if (value === null || type !== 'object') return true
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const problem = losslessProblem(value[index], `${at}[${index}]`)
      if (problem !== true) return problem
    }
    return true
  }
  for (const [key, item] of Object.entries(value)) {
    const problem = losslessProblem(item, at ? `${at}.${key}` : key)
    if (problem !== true) return problem
  }
  return true
}

const call = async (tool, args) => {
  const value = await registered.get(tool).execute(args, { signal: undefined })
  const problem = losslessProblem(value)
  check(`${tool} 返回值是无损 JSON`, problem === true, String(problem))
  return value
}
const render = (tool, value) => registered.get(tool).output.render({}, value)[0].text

// ── 配置（L1） ──
const configInfo = await call('media_naming_config', {})
check('config 报告位置、取值来源与缺失项',
  typeof configInfo.configPath === 'string' && configInfo.configPath.includes('media-naming')
  && Object.keys(configInfo.sources).length === 5
  && Array.isArray(configInfo.missing) && Array.isArray(configInfo.howTo),
  JSON.stringify({ path: configInfo.configPath, missing: configInfo.missing }))

const rules = await call('media_naming_rules', {})
check('rules 返回规则包与标签表', Array.isArray(rules.libraries) && rules.libraries.length === 5
  && rules.tagCounts.chinese > 10 && Array.isArray(rules.availablePacks),
  JSON.stringify({ tags: rules.tagCounts, packs: rules.availablePacks }))

const examples = await call('media_naming_examples', {})
check('examples 返回样例集', examples.total >= 9, `total=${examples.total}`)

// ── 流程与逐步校验 ──
const flow = await call('media_naming_flow', {})
const steps = flow.flow?.steps ?? []
check('flow 返回 7 个步骤且每步都有通过条件', steps.length === 7
  && steps.every((step) => Array.isArray(step.pass) && step.pass.length > 0),
  `steps=${steps.map((step) => step.id).join(',')}`)
const writeStep = steps.find((step) => step.writes === true)
check('唯一的写操作步骤要求用户确认后由 Agent 执行',
  steps.filter((step) => step.writes === true).length === 1
  && writeStep?.owner === 'agent'
  && writeStep?.requires?.some((item) => item.includes('同意')),
  JSON.stringify({ owner: writeStep?.owner, requires: writeStep?.requires }))

const prepare = await call('media_naming_check', { step: 'prepare' })
check('check prepare 缺凭据时判定不通过并指向本步',
  prepare.passed === false && prepare.nextStep === 'prepare'
  && prepare.checks.some((item) => item.id === 'cookies.provided' && !item.pass),
  JSON.stringify(prepare.checks.map((item) => item.id)))

const parsed = await call('media_naming_parse', { path: `${PREFIX}/电视剧/示例剧集 (2021)/示例剧集.第05集.mp4` })
check('parse 命中规范名', parsed.status === 'CHANGED'
  && parsed.title === '示例剧集' && parsed.episode === 5
  && parsed.proposedPath === `${PREFIX}/电视剧/示例剧集 (2021)/Season 01/示例剧集 S01E05.mp4`,
  JSON.stringify(parsed.proposedPath))

const verified = await call('media_naming_verify', { candidatePath: `${PREFIX}/电影/示例电影 (2024)/示例电影 (2024).mkv` })
check('verify 判定合规', verified.conforms === true, JSON.stringify(verified.violations))

const planned = await call('media_naming_plan', {
  paths: [`${PREFIX}/动漫/示例动漫 (2018)/[Group][示例动漫][001][1080P].mp4`],
  outputPath: path.join(OUT_DIR, 'plan.json'),
})
check('plan 离线产出并落盘', planned.plan?.summary?.changed === 1 && Boolean(planned.planPath),
  `${planned.planPath} | ${JSON.stringify(planned.plan?.summary)}`)

const planCheck = await call('media_naming_check', { step: 'plan', planPath: planned.planPath })
check('check plan 对干净计划判定通过并指向 review',
  planCheck.passed === true && planCheck.nextStep === 'review',
  JSON.stringify(planCheck.checks))

// ── 审核视图（面向使用者） ──
const reviewed = await call('media_naming_review', {
  planPath: planned.planPath,
})
check('review 从计划生成对照表与放行结论',
  typeof reviewed.markdown === 'string'
  && reviewed.markdown.includes('| 现在 | 改为 |')
  && reviewed.markdown.includes('审核清单')
  && reviewed.review.verdict.canProceed === true
  && reviewed.review.groups.length === 1,
  JSON.stringify({ groups: reviewed.review.groups.length, verdict: reviewed.review.verdict }))

const reviewedBoth = await call('media_naming_review', {
  paths: [
    `${PREFIX}/电视剧/示例剧集 (2021)/示例剧集.第05集.mp4`,
    `${PREFIX}/电影/示例动画（2001）/示例动画（2001）.mkv`,
  ],
})
check('review 按作品分组', reviewedBoth.review.groups.length === 2
  && reviewedBoth.review.groups.every((group) => group.items.length > 0),
  JSON.stringify(reviewedBoth.review.groups.map((group) => group.work)))

const blockedReview = await call('media_naming_review', {
  paths: [`${PREFIX}/电影/示例影片 (2018)/示例影片.2018.1080p.mkv`],
})
check('review 无冲突时给出可执行结论', blockedReview.review.verdict.canProceed === true,
  JSON.stringify(blockedReview.review.verdict))

// ── 执行闸门：缺确认或计划不干净都必须拒绝（绝不能误写） ──
const expectThrow = async (tool, args) => {
  try {
    await call(tool, args)
    return ''
  } catch (error) {
    return String(error?.message ?? error)
  }
}

const noConfirm = await expectThrow('media_naming_apply', { planPath: planned.planPath })
check('apply 缺少用户确认时被拒绝', noConfirm.includes('用户确认'), noConfirm)

const dirtyPlanPath = path.join(OUT_DIR, 'plan-dirty.json')
writeFileSync(dirtyPlanPath, `${JSON.stringify({
  planId: 'dirty',
  scope: {},
  summary: { total: 1, changed: 0, conflict: 1, unknown: 0 },
  items: [{ status: 'CONFLICT', currentPath: 'a.mkv', proposedPath: 'b.mkv' }],
}, null, 2)}\n`, 'utf8')
const dirtyBlocked = await expectThrow('media_naming_apply', { planPath: dirtyPlanPath, confirm: true })
check('apply 对含冲突的计划拒绝执行', dirtyBlocked.includes('计划未通过校验'), dirtyBlocked)

const noCookies = await expectThrow('media_naming_apply', { planPath: planned.planPath, confirm: true })
check('apply 在缺少凭据时不执行（不会误写）',
  noCookies.includes('凭据') && noCookies.includes('登录'), noCookies)

const renders = [
  render('media_naming_config', configInfo),
  render('media_naming_rules', rules),
  render('media_naming_examples', examples),
  render('media_naming_flow', flow),
  render('media_naming_check', prepare),
  render('media_naming_review', reviewed),
  render('media_naming_parse', parsed),
  render('media_naming_verify', verified),
  render('media_naming_plan', planned),
]
check('render 均返回文本', renders.every((text) => typeof text === 'string' && text.length > 0),
  renders.map((text) => text.slice(0, 16)).join(' | '))

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`[${item.ok ? 'OK' : 'FAIL'}] ${item.name}${item.ok || !item.detail ? '' : ` -> ${item.detail}`}`)
}
console.log('='.repeat(60))
console.log(`tools=${registered.size} checks=${checks.length} passed=${checks.length - failed} failed=${failed}`)
rmSync(SANDBOX_HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
