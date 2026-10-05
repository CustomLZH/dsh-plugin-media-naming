/**
 * 面向使用者的审核视图。
 *
 * 计划本身是机器结构；这里把它翻译成「现在 → 改为」的对照表、
 * 风险提示与明确结论，让使用者只需要看一张表就能决定放不放行。
 */
import { dirOf, nameOf } from './plan.js'

const SEASON_SUFFIX_RE = /\/Season \d+$/
const PREVIEW_LIMIT = 60

/** 作品分组键：把 `…/某剧 (2020)/Season 01` 归并回 `…/某剧 (2020)`。 */
export function workKeyOf(proposedPath) {
  return dirOf(proposedPath).replace(SEASON_SUFFIX_RE, '')
}

const escapeCell = (text) => String(text ?? '').replace(/\|/g, '\\|')

/** 轻量推断「这条为什么改」，用于审核表的依据列。 */
export function reasonOf(item) {
  const reasons = []
  if (nameOf(item.currentPath) !== nameOf(item.proposedPath)) reasons.push('名称规范化')

  const currentHasSeason = /Season\s*\d+/i.test(item.currentPath)
  const proposedHasSeason = /Season\s*\d+/i.test(item.proposedPath)
  if (proposedHasSeason && !currentHasSeason) reasons.push('补季目录')
  else if (dirOf(item.currentPath) !== dirOf(item.proposedPath)) reasons.push('目录调整')

  if (item.part) reasons.push('分 Part')
  if (item.version) reasons.push(item.keepVersion ? '保留版本后缀' : '清除技术标签')
  return reasons.join(' / ') || '规范化'
}

/**
 * 由计划构造审核视图。
 * @param {object} plan media_naming_plan 产出的计划对象
 */
export function buildReview(plan) {
  const items = plan?.items ?? []
  const counts = plan?.summary ?? {}
  const actionable = items.filter((item) => item.status === 'CHANGED')
  const blocked = items.filter((item) => item.status === 'CONFLICT' || item.status === 'UNKNOWN')

  const groups = new Map()
  for (const item of actionable) {
    const key = workKeyOf(item.proposedPath) || '（未分组）'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  const directories = (plan?.directories ?? [])
    .filter((entry) => entry.status === 'CHANGED')
    .map((entry) => ({
      currentPath: entry.currentPath,
      proposedPath: entry.proposedPath,
      currentName: entry.currentName,
      proposedName: entry.proposedName,
      fileCount: entry.fileCount,
    }))

  const risks = []
  if ((counts.conflict ?? 0) > 0) {
    risks.push({ level: 'high', text: `${counts.conflict} 条目标名冲突——执行脚本会直接拒绝运行，需要你先决定怎么处理` })
  }
  if ((counts.unknown ?? 0) > 0) {
    risks.push({ level: 'high', text: `${counts.unknown} 条无法解析片名或年份，需要人工确认` })
  }
  if ((counts.outOfScope ?? 0) > 0) {
    risks.push({ level: 'info', text: `${counts.outOfScope} 条不在规则包范围内（或非视频），本次不会处理` })
  }
  if ((counts.skip ?? 0) > 0) {
    risks.push({ level: 'info', text: `${counts.skip} 条已符合规范，跳过` })
  }
  if (actionable.length > 0) {
    risks.push({ level: 'info', text: `共 ${actionable.length} 条会改名或移动；执行前脚本还会做一次 dry-run` })
  }
  if (directories.length > 0) {
    risks.push({ level: 'info', text: `另有 ${directories.length} 个作品目录名会被改，其下所有文件路径随之变化` })
  }

  const canProceed = blocked.length === 0 && actionable.length > 0
  const reason = blocked.length > 0
    ? '还有需要你决策的条目，先处理它们'
    : (actionable.length === 0 ? '没有需要变更的条目' : '计划干净，可以进入执行')

  return {
    scope: plan?.scope ?? {},
    counts,
    groups: [...groups.entries()].map(([work, list]) => ({ work, items: list })),
    directories,
    blocked: blocked.map((item) => ({
      path: item.currentPath,
      status: item.status,
      reason: item.reason,
    })),
    risks,
    verdict: { canProceed, reason },
  }
}

/** 把审核视图渲染成给使用者看的 markdown。 */
export function renderReview(review, limit = PREVIEW_LIMIT) {
  const counts = review.counts ?? {}
  const lines = [
    `## 审核清单${review.scope?.target ? `：${review.scope.target}` : ''}`,
    '',
    `文件：共 ${counts.total ?? 0} 条 ｜ 变更 **${counts.changed ?? 0}** ｜ 跳过 ${counts.skip ?? 0}`
      + ` ｜ 冲突 ${counts.conflict ?? 0} ｜ 未知 ${counts.unknown ?? 0} ｜ 超范围 ${counts.outOfScope ?? 0}`,
    `目录：${counts.directories ?? 0} 个（待改 ${counts.directoriesChanged ?? 0} 个）`,
    '',
  ]

  if ((review.directories ?? []).length > 0) {
    lines.push('### 目录名也要改')
    lines.push('')
    lines.push('| 现在 | 改为 | 影响文件 |')
    lines.push('| --- | --- | --- |')
    for (const entry of review.directories) {
      lines.push(`| ${escapeCell(entry.currentName)} | ${escapeCell(entry.proposedName)} | ${entry.fileCount} |`)
    }
    lines.push('')
    lines.push('> 目录改名会连带其下所有文件的路径；执行时先改文件、最后改目录。')
    lines.push('')
  }

  if (review.blocked.length > 0) {
    lines.push('### ⚠️ 需要你先决策')
    for (const item of review.blocked) {
      lines.push(`- \`${item.status}\` ${item.path}${item.reason ? `—— ${item.reason}` : ''}`)
    }
    lines.push('')
  }

  let shown = 0
  for (const group of review.groups) {
    if (shown >= limit) break
    lines.push(`### ${group.work}（${group.items.length} 条）`)
    lines.push('')
    lines.push('| # | 现在 | 改为 | 依据 |')
    lines.push('| --- | --- | --- | --- |')
    for (const item of group.items) {
      if (shown >= limit) break
      shown += 1
      lines.push(`| ${shown} | ${escapeCell(nameOf(item.currentPath))} | ${escapeCell(nameOf(item.proposedPath))} | ${reasonOf(item)} |`)
    }
    lines.push('')
  }
  const remaining = (counts.changed ?? 0) - shown
  if (remaining > 0) lines.push(`…另有 ${remaining} 条未在此列出（完整清单见计划 JSON）`)

  if (review.risks.length > 0) {
    lines.push('', '### 提示')
    for (const risk of review.risks) lines.push(`- ${risk.level === 'high' ? '⛔' : '·'} ${risk.text}`)
  }

  lines.push('', `### 结论：${review.verdict.canProceed ? '✅ 可以进入执行' : '⏸ 暂不可执行'}`)
  lines.push(review.verdict.reason)
  if (review.verdict.canProceed) {
    lines.push('', '审核通过后告诉我，我来执行（`media_naming_apply`，带确认闸门）。')
  } else if (review.blocked.length > 0) {
    lines.push('', '把需要调整的地方告诉我，我重新生成计划；或直接在计划里排除这些条目。')
  }
  return lines.join('\n')
}
