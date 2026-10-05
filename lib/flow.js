/**
 * 作业流程与每步校验规则。
 *
 * 流程定义在包内 `flow.json`：每一步的 `pass` 都是可判定的布尔条件。
 * 这里提供「加载流程」与「把某一步的通过条件算成结果」的纯逻辑，
 * 让 Agent 不必凭感觉判断"这一步算不算做完了"。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const FLOW_PATH = path.join(PLUGIN_DIR, 'flow.json')

/** 读取完整流程定义。 */
export function loadFlow() {
  return JSON.parse(readFileSync(FLOW_PATH, 'utf8'))
}

/** 取单个步骤；未知 id 返回 undefined。 */
export function findStep(id) {
  return loadFlow().steps.find((step) => step.id === id)
}

/** 汇总检查结果：skipped 的项不算失败。 */
export function summarize(checks) {
  return {
    passed: checks.every((check) => check.pass || check.skipped),
    checks,
  }
}

/**
 * 检查凭据文件：只判「存在 / 非空 / 含关键字段名」。
 * 绝不返回文件内容，也不把凭据写入任何产物。
 */
export function checkCredentials(cookiesPath) {
  const checks = []
  if (!cookiesPath) {
    return [{ id: 'cookies.provided', pass: false, detail: '未提供 cookiesPath' }]
  }
  checks.push({ id: 'cookies.provided', pass: true, detail: '' })
  if (!existsSync(cookiesPath)) {
    checks.push({ id: 'cookies.exists', pass: false, detail: `文件不存在：${cookiesPath}` })
    return checks
  }
  checks.push({ id: 'cookies.exists', pass: true, detail: '' })

  let raw = ''
  try {
    raw = readFileSync(cookiesPath, 'utf8').trim()
  } catch (error) {
    checks.push({ id: 'cookies.nonEmpty', pass: false, detail: `读取失败：${error?.message ?? error}` })
    return checks
  }
  if (!raw) {
    checks.push({ id: 'cookies.nonEmpty', pass: false, detail: '文件为空' })
    return checks
  }
  checks.push({ id: 'cookies.nonEmpty', pass: true, detail: `${raw.length} 字节` })

  const found = ['UID', 'CID', 'SEID', 'KID'].filter((key) => raw.includes(`${key}=`))
  checks.push({
    id: 'cookies.fields',
    pass: found.length > 0,
    detail: found.length > 0 ? `命中 ${found.join(' / ')}` : '未发现 UID/CID/SEID/KID，可能不是 Cookie 字符串',
  })
  return checks
}

/** 计划校验：把 plan 步骤的通过条件变成逐条判定。 */
export function checkPlan(plan) {
  const summary = plan?.summary ?? {}
  const items = plan?.items ?? []
  const seen = new Set()
  const duplicates = []
  for (const item of items) {
    if (item.status !== 'CHANGED' || !item.proposedPath) continue
    if (seen.has(item.proposedPath)) duplicates.push(item.proposedPath)
    seen.add(item.proposedPath)
  }
  const blocked = items.filter((item) => item.status === 'CONFLICT' || item.status === 'UNKNOWN')
  return [
    { id: 'plan.total', pass: (summary.total ?? 0) > 0, detail: `total=${summary.total ?? 0}` },
    { id: 'plan.conflict', pass: (summary.conflict ?? 0) === 0, detail: `conflict=${summary.conflict ?? 0}` },
    { id: 'plan.unknown', pass: (summary.unknown ?? 0) === 0, detail: `unknown=${summary.unknown ?? 0}` },
    {
      id: 'plan.uniqueTargets',
      pass: duplicates.length === 0,
      detail: duplicates.length > 0 ? `重复目标：${duplicates.slice(0, 3).join('、')}` : '无重复目标',
    },
    {
      id: 'plan.needsDecision',
      pass: blocked.length === 0,
      detail: blocked.length > 0
        ? `${blocked.length} 条需用户决策：${blocked.slice(0, 3).map((item) => item.currentPath).join('、')}`
        : '无待决策条目',
    },
  ]
}

/** 把一步渲染成可读文本（给 Agent 看的检查清单）。 */
export function renderStep(step) {
  const lines = [`### ${step.id}｜${step.title}`]
  if (step.tool) lines.push(`工具：\`${step.tool}\``)
  if (step.method) lines.push(`方法：\`${step.method}\``)
  lines.push(step.writes
    ? (step.owner === 'agent' ? '⚠️ 会写入网盘——须在你确认后由 Agent 执行' : '⚠️ 会写入网盘')
    : '只读')
  lines.push('通过条件：')
  for (const check of step.pass ?? []) lines.push(`  - [ ] ${check.id}：${check.desc}`)
  if (step.requires?.length) {
    lines.push('前提：')
    for (const item of step.requires) lines.push(`  - ${item}`)
  }
  if (step.fail) lines.push(`不通过：${step.fail}`)
  return lines.join('\n')
}

/** 把整条流程渲染成可读文本。 */
export function renderFlow(flow) {
  const lines = [
    `# ${flow.title} v${flow.version}`,
    flow.goal,
    flow.principle ? `原则：${flow.principle}` : '',
    '',
    '需要用户提供：',
    ...flow.inputs.map((input) => `  - \`${input.name}\`${input.required ? '（必需）' : '（可选）'}：${input.desc}`),
    '',
    ...flow.steps.flatMap((step) => [renderStep(step), '']),
  ]
  return lines.filter((line) => line !== undefined).join('\n').trim()
}
