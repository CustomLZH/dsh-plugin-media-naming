/**
 * 「作业流程」「逐步校验」「执行」三个工具。
 *
 * 边界：插件本身不主动改数据，但**在用户确认后由 Agent 调用执行工具**完成写操作；
 * 审计与责任都落在「用户看过审核清单并同意」这一步（`confirm: true` 是它的凭据）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { latestPlanPath } from './config.js'
import {
  checkCredentials,
  checkPlan,
  findStep,
  loadFlow,
  renderFlow,
  renderStep,
  summarize,
} from './flow.js'
import { plan as buildPlan } from './plan.js'
import { LOOSE_OBJECT, objectSchema, toText } from './schema.js'
import { resolveContext } from './settings.js'
import { applyPlan, resolveStorage, scanTarget, STORAGE_LOCAL } from './storage.js'

const SCAN_TIMEOUT_MS = 240000
const asArray = (value) => (Array.isArray(value) ? value.filter((one) => typeof one === 'string' && one.trim()) : [])

/**
 * 执行后自动复验：重扫同一目标，用**同一口径**（含计划里记住的 seasonFolder）再算一次，
 * 确认没有残留的 CHANGED / CONFLICT / UNKNOWN。复验失败不影响已完成的执行结果。
 */
async function recheckAfterApply(ctx, config, settings, pack, plan, args, exec) {
  const rootPrefix = pack.rootPrefix || ''
  const stripRoot = (value) => {
    const text = String(value ?? '')
    if (!rootPrefix) return text
    return text.startsWith(`${rootPrefix}/`) ? text.slice(rootPrefix.length + 1) : text
  }
  // 目录可能已被改名：优先复验**执行后**的位置，否则退回原 target
  const proposedDir = plan?.directories?.[0]?.proposedPath
  const target = proposedDir ? stripRoot(proposedDir) : plan?.scope?.target
  if (!target) return { ok: null, reason: '计划里没有 target，跳过复验' }
  try {
    const scanned = await scanTarget(ctx, config, settings, {
      target,
      limit: args?.limit ?? 500,
      signal: exec?.signal,
    })

    const result = buildPlan(asArray(scanned.files), {
      pack,
      existingByDir: scanned.existingByDir ?? {},
      seasonFolder: plan?.scope?.seasonFolder,
    })
    const summary = result.summary
    const remaining = (summary.changed ?? 0) + (summary.conflict ?? 0) + (summary.unknown ?? 0)
    return {
      ok: remaining === 0,
      remaining,
      rootPath: scanned.rootPath,
      fileCount: asArray(scanned.files).length,
      summary,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

function renderChecks(value) {
  return toText([
    `${value.step}：${value.passed ? '✅ 通过' : '❌ 未通过'}`,
    ...value.checks.map((check) =>
      `${check.pass ? '✓' : check.skipped ? '－' : '✗'} ${check.id}${check.detail ? `：${check.detail}` : ''}`),
    `下一步：${value.nextStep}`,
  ].join('\n'))
}

function renderApply(value) {
  if (value.explain) return toText(`演练：${value.operations} 条操作（未写入任何内容）`)
  if (value.restored !== undefined) {
    return toText(`回滚：恢复 ${value.restored} 条`
      + `${value.failed?.length ? `，失败 ${value.failed.length} 条` : ''}`
      + `\n回滚清单：${value.rollbackPath}`)
  }

  const lines = [
    `${value.dryRun ? '演练' : '执行'}完成：执行 ${value.executed ?? 0} 条`
      + `${value.directoriesExecuted ? `、目录 ${value.directoriesExecuted} 个` : ''}`
      + `、跳过 ${value.skipped ?? 0} 条`
      + `${value.failed?.length ? `、失败 ${value.failed.length} 条` : ''}`,
    `累计完成 ${value.total ?? 0} 条`,
  ]
  const recheck = value.recheck
  if (recheck) {
    if (recheck.ok === true) {
      lines.push(`自动复验：✅ 已全部符合规范（${recheck.fileCount ?? 0} 个文件）`)
    } else if (recheck.ok === null) {
      lines.push(`自动复验：跳过（${recheck.reason}）`)
    } else {
      lines.push(`自动复验：⚠️ 仍有 ${recheck.remaining ?? '?'} 条待处理`
        + `${recheck.error ? `（${recheck.error}）` : ''}`)
    }
  }
  lines.push(
    `断点文件：${value.statePath}`,
    `回滚清单：${value.rollbackPath}（需要改回时用同一工具传 rollback=true）`,
  )
  return toText(lines.join('\n'))
}

/**
 * 注册流程、校验与执行工具。
 * @param {object} ctx 插件上下文
 * @param {object} config 插件配置（profile 里的那一行）
 */
export function registerFlowTools(ctx, config) {
  ctx.tools.register({
    name: 'media_naming_flow',
    description:
      '返回媒体库命名的作业流程与每一步的通过条件（校验规则）。开始处理前先取一次，'
      + '之后逐步执行并逐条自检：prepare → scan → plan → review → apply → recheck。本工具只读。',
    parameters: objectSchema({
      step: { type: 'string', description: '只看某一步：prepare / scan / plan / review / apply / recheck。' },
    }),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText(value.step ? renderStep(value.step) : renderFlow(value.flow)),
    },
    execute: (args) => {
      const flow = loadFlow()
      if (!args?.step) return { flow }
      const step = findStep(args.step)
      if (!step) {
        throw new Error(`未知步骤 ${args.step}；可用：${flow.steps.map((item) => item.id).join(' / ')}`)
      }
      return { flow, step }
    },
    presentCall: (args) => ({ card: 'generic', title: `命名流程${args?.step ? `：${args.step}` : ''}`, kind: 'read' }),
  })

  ctx.tools.register({
    name: 'media_naming_check',
    description:
      '按流程判定某一步是否通过，把「算不算做完了」变成逐条布尔结果：'
      + '`step=prepare` 检查凭据文件与目标目录可达性；`step=plan` 检查计划是否满足「冲突/未知/重复目标为零」。'
      + '返回逐条检查结果与建议的下一步。本工具只读（prepare 会只读探测目标目录）。',
    parameters: objectSchema({
      step: { type: 'string', enum: ['prepare', 'plan'], description: '要校验的步骤，默认 prepare。' },
      cookiesPath: { type: 'string', description: '凭据文件路径（prepare 用；默认取配置）。' },
      target: { type: 'string', description: '要处理的目录或作品（prepare 用；不传则跳过可达性探测）。' },
      root: { type: 'string', description: '可选：根目录名，默认取规则包的 rootPrefix。' },
      planPath: { type: 'string', description: '可选：计划 JSON 路径（plan 用）；不传则用「最近一次计划」。' },
      pack: { type: 'string', description: '可选：规则包 id。' },
    }),
    output: { schema: LOOSE_OBJECT, render: (_args, value) => renderChecks(value) },
    execute: async (args, exec) => {
      const step = args?.step === 'plan' ? 'plan' : 'prepare'

      if (step === 'plan') {
        const planPath = args?.planPath || latestPlanPath()
        if (!planPath) {
          throw new Error('没有可校验的计划：请先用 media_naming_quick 生成计划。')
        }
        const plan = JSON.parse(readFileSync(planPath, 'utf8'))
        const result = summarize(checkPlan(plan))
        return { step, ...result, scope: plan.scope ?? {}, nextStep: result.passed ? 'review' : 'plan' }
      }

      const { settings, pack } = resolveContext(config, args)
      const storage = resolveStorage(settings, args?.target ?? '')
      const cookiesPath = settings.cookiesPath
      const checks = storage === STORAGE_LOCAL
        ? [{ id: 'storage.local', pass: true, detail: '本地文件系统路径（本机 / NAS 挂载 / Linux），无需 115 凭据' }]
        : checkCredentials(cookiesPath)
      if (!args?.target) {
        checks.push({ id: 'target.reachable', pass: false, skipped: true, detail: '未提供 target，跳过可达性探测' })
      } else if (!checks.every((check) => check.pass)) {
        checks.push({ id: 'target.reachable', pass: false, detail: '凭据未通过检查，未做可达性探测' })
      } else {
        try {
          const scanned = await runScan(ctx, config, {
            cookiesPath,
            path: args.target,
            root: settings.root || pack.rootPrefix,
            limit: 1,
          }, { signal: exec?.signal, timeoutMs: SCAN_TIMEOUT_MS })
          checks.push({
            id: 'target.reachable',
            pass: true,
            detail: `${scanned.rootPath}（探测到 ${scanned.scanned} 个条目）`,
          })
        } catch (error) {
          checks.push({ id: 'target.reachable', pass: false, detail: error?.message ?? String(error) })
        }
      }

      const result = summarize(checks)
      return { step, ...result, nextStep: result.passed ? 'scan' : 'prepare' }
    },
    presentCall: (args) => ({ card: 'generic', title: `校验流程步骤：${args?.step ?? 'prepare'}`, kind: 'read' }),
  })

  ctx.tools.register({
    name: 'media_naming_apply',
    description:
      '执行命名计划（写操作，由 Agent 在用户确认后调用）。两道闸门：'
      + '① 必须先把审核清单给用户看过并得到明确同意，调用时带 `confirm=true`；'
      + '② 计划里不能有 conflict / unknown，否则直接拒绝。'
      + '执行中每条写 state（可断点续跑）并生成回滚清单；目标名被占用绝不覆盖。'
      + '传 `dryRun=true` 只演练；传 `rollback=true` 按回滚清单改回。',
    parameters: objectSchema(
      {
        planPath: { type: 'string', description: '可选：计划 JSON 路径；不传则用「最近一次计划」。' },
        confirm: { type: 'boolean', description: '必须为 true，表示用户已看过审核清单并同意执行。' },
        dryRun: { type: 'boolean', description: '可选：true 时只演练不写入，默认 false。' },
        rollback: { type: 'boolean', description: '可选：true 时按回滚清单把改动改回去。' },
        workDir: { type: 'string', description: '可选：state 与回滚清单的目录，默认与计划同目录。' },
        cookiesPath: { type: 'string', description: '可选：凭据文件路径，默认取配置。' },
      },
      [],
    ),
    output: { schema: LOOSE_OBJECT, render: (_args, value) => renderApply(value) },
    execute: async (args, exec) => {
      const planPath = args?.planPath || latestPlanPath()
      if (!planPath) {
        throw new Error('找不到计划：请先用 media_naming_quick（推荐）或 media_naming_plan 生成计划。')
      }

      const isRollback = args?.rollback === true
      if (args?.confirm !== true) {
        throw new Error(isRollback
          ? '回滚同样是写操作：请先向用户说明将要改回哪些文件，得到明确同意后再带 confirm=true 调用。'
          : '需要用户确认：先用 media_naming_quick 或 review 把审核清单给用户看过，得到明确同意后再带 confirm=true 调用。')
      }

      let plan = null
      if (!isRollback) {
        plan = JSON.parse(readFileSync(planPath, 'utf8'))
        const result = summarize(checkPlan(plan))
        if (!result.passed) {
          const failed = result.checks.filter((check) => !check.pass)
            .map((check) => `${check.id}（${check.detail}）`)
          throw new Error(`计划未通过校验，拒绝执行：${failed.join('；')}`)
        }
      }

      const { settings, pack } = resolveContext(config, args)
      // 后端（本地 / 115）与凭据校验都由 storage 层负责

      const outcome = await applyPlan(ctx, config, settings, {
        planPath,
        plan,
        apply: args?.dryRun !== true,
        rollback: isRollback,
        workDir: args?.workDir,
        signal: exec?.signal,
      })

      // 只有真正写入过才复验（演练与回滚不需要）
      if (isRollback || args?.dryRun === true) return outcome
      return { ...outcome, recheck: await recheckAfterApply(ctx, config, settings, pack, plan, args, exec) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.rollback ? '回滚命名改动' : (args?.dryRun ? '演练命名计划' : '执行命名计划'),
      kind: args?.rollback || args?.dryRun !== true ? 'execute' : 'other',
      rawInput: { planPath: args?.planPath },
    }),
  })

  ctx.logger?.info?.('media-naming 已注册流程、逐步校验与执行工具（执行须用户确认）。')
}
