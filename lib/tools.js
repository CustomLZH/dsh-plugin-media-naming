/**
 * 工具注册（全部只读）。
 *
 * 关键约定：**代码不认识任何具体的目录名**。要处理哪个库、哪个作品、哪套规则，
 * 全部由调用方在参数里给出：
 * - `path` / `target` / `paths`：要处理的目标（目录或作品，任意层级）；
 * - `pack` / `rulePackPath`：用哪套规则（内置包 id，或你自己的规则 JSON）。
 *
 * 解析与计划由插件内置的 JS 引擎完成，运行时不需要 Python、不读取外部脚本。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { plansDir, rememberPlan } from './config.js'
import { buildTarget } from './parse.js'
import { analyze, plan } from './plan.js'
import { buildReview, renderReview } from './review.js'
import { loadExamples, loadRegistry, tagSummary } from './rules.js'
import { LOOSE_OBJECT, jsonSafe, objectSchema, toText } from './schema.js'
import { resolveContext } from './settings.js'
import { scanTarget } from './storage.js'

const PLAN_PREVIEW_LIMIT = 15
const SCAN_TIMEOUT_MS = 240000
const KIND_ENUM = ['positive', 'boundary', 'failure']
const extOf = (name) => {
  const dot = String(name ?? '').lastIndexOf('.')
  return dot > 0 ? String(name).slice(dot) : ''
}
const asArray = (value) => (Array.isArray(value) ? value.filter((one) => typeof one === 'string' && one.trim()) : [])

/** 组装计划结构（plan 与 quick 共用，避免两处实现漂移）。 */
function buildPlanPayload({ result, pack, target, rootPath, source, seasonFolder, storage }) {
  return {
    planId: `plan-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`,
    generatedAt: new Date().toISOString(),
    scope: {
      pack: pack.id,
      target: target ?? '',
      rootPath: rootPath ?? '',
      source,
      // 记住用哪个后端：执行时据此决定走 Node 还是 115 脚本
      storage: storage ?? '',
      // 记住 Season 目录设置：执行后复验必须用同一口径，否则会把「已规范」判成「待改」
      seasonFolder: seasonFolder ?? pack.seasonFolder ?? true,
    },
    summary: result.summary,
    items: result.items,
    directories: result.directories ?? [],
  }
}

/**
 * 计划**总是**落盘：review / check / apply 都靠它，调用方不必再操心路径。
 * 同时记住「最近一次」，让后续工具可以省略 planPath。
 */
function savePlan(payload, outputPath) {
  const planPath = outputPath || path.join(plansDir(), `${payload.planId}.json`)
  mkdirSync(path.dirname(planPath), { recursive: true })
  writeFileSync(planPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  rememberPlan(planPath, { planId: payload.planId, target: payload.scope?.target ?? '' })
  return planPath
}

function summarizePlan(plan, planPath) {
  const s = plan.summary
  const scope = plan.scope.target || plan.scope.source
  const lines = [
    `计划 ${plan.planId}（${scope}）：文件 ${s.total} 条 — `
      + `变更 ${s.changed}、跳过 ${s.skip}、冲突 ${s.conflict}、未知 ${s.unknown}、超范围 ${s.outOfScope}`
      + `${s.directories ? `；目录 ${s.directories} 个（待改 ${s.directoriesChanged} 个）` : ''}`,
  ]
  if (planPath) lines.push(`已落盘：${planPath}`)

  const directoryChanges = (plan.directories ?? []).filter((entry) => entry.status !== 'SKIP')
  if (directoryChanges.length > 0) {
    lines.push('', '目录名：')
    for (const entry of directoryChanges) {
      lines.push(`  ${entry.status}  ${entry.currentPath}\n           → ${entry.proposedPath}`)
    }
  } else if ((plan.directories ?? []).length > 0) {
    lines.push('', '目录名：已符合规范')
  }
  const visible = plan.items.filter((item) => item.status !== 'SKIP')
  for (const item of visible.slice(0, PLAN_PREVIEW_LIMIT)) {
    lines.push(item.status === 'CHANGED'
      ? `${item.status}  ${item.currentPath}\n         → ${item.proposedPath}`
      : `${item.status}  ${item.currentPath}${item.reason ? `（${item.reason}）` : ''}`)
  }
  if (visible.length > PLAN_PREVIEW_LIMIT) lines.push(`…其余 ${visible.length - PLAN_PREVIEW_LIMIT} 条见完整计划`)
  return lines.join('\n')
}

/**
 * 注册全部命名工具。
 * @param {object} ctx 插件上下文
 * @param {object} config 已合并默认值的插件配置
 */
export function registerTools(ctx, config) {
  ctx.tools.register({
    name: 'media_naming_rules',
    description:
      '返回当前生效的命名**规则包**：目标目录映射、模板、口径、状态机与需清理的标签表。'
      + '可以传 `pack` 切换内置规则包，或传 `rulePackPath` 使用你自己的规则 JSON。本工具只读。',
    parameters: objectSchema({
      pack: { type: 'string', description: '内置规则包 id；不传则用注册表里的默认包。' },
      rulePackPath: { type: 'string', description: '可选：你自己的规则包 JSON 文件路径，会覆盖内置包的同名字段。' },
    }),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText([
        `规则包 ${value.id}：${value.title} v${value.version}`,
        `根目录前缀：${value.rootPrefix}（可在调用时覆盖）`,
        `目录映射：${value.libraries.map((one) => `${one.match}→${one.mediaType}`).join('、')}`,
        `排除目录：${value.excluded.join('、') || '（无）'}`,
        `标签表：来源编码 ${value.tagCounts.sourceCodec}、版本 ${value.tagCounts.version}、中文噪音 ${value.tagCounts.chinese}`,
        `可用内置包：${value.availablePacks.join('、')}`,
      ].join('\n')),
    },
    execute: (args) => {
      const { pack } = resolveContext(config, args)
      return { ...pack, tagCounts: tagSummary(pack), availablePacks: loadRegistry().packs ?? [] }
    },
    presentCall: () => ({ card: 'generic', title: '读取命名规则', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'media_naming_examples',
    description:
      '返回规则包配套的规范样例集（输入 → 期望结果 + 理由），覆盖正例、边界例与失败例。'
      + '处理目标前先看样例，可以照同样口径判断，也可以用它自检。本工具只读。',
    parameters: objectSchema({
      id: { type: 'string', description: '只看某一条样例，如 P3 / E1 / F2 / MV。' },
      kind: { type: 'string', enum: KIND_ENUM, description: '按类别筛选：positive / boundary / failure。' },
      pack: { type: 'string', description: '可选：指定内置规则包 id。' },
    }),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText(value.examples
        .map((one) => `${one.id}（${one.kind}）${one.title}\n  ${one.inputs[0]}\n  → ${one.expects[0].status} ${one.expects[0].path || '（不处理）'}`)
        .join('\n')),
    },
    execute: (args) => {
      const { settings } = resolveContext(config, args)
      const all = loadExamples(settings.rulePack || undefined)
      const wantedId = args?.id ? String(args.id).toLowerCase() : ''
      const examples = all.examples.filter((one) =>
        (!wantedId || one.id.toLowerCase() === wantedId) && (!args?.kind || one.kind === args.kind))
      return { version: all.version, note: all.note, total: examples.length, examples }
    },
    presentCall: (args) => ({ card: 'generic', title: `读取规范样例${args?.id ? ` ${args.id}` : ''}`, kind: 'read' }),
  })

  ctx.tools.register({
    name: 'media_naming_parse',
    description:
      '把一条路径解析成「片名 / 年份 / 季 / 集 / 版本 / 分P」并给出符合规范的提议路径与状态。'
      + '用于试解析单条文件，不访问网盘；不限定目录结构，任意层级路径都可以。',
    parameters: objectSchema(
      {
        path: { type: 'string', description: '路径或文件名，如 `影视资源/电视剧/示例剧集 (2021)/示例剧集.第05集.mp4`。' },
        mediaType: { type: 'string', enum: ['auto', 'movie', 'tv'], description: '内容类型；默认按规则包的目录映射或文件名判断。' },
        pack: { type: 'string', description: '可选：指定内置规则包 id。' },
        rulePackPath: { type: 'string', description: '可选：你自己的规则包 JSON 文件路径。' },
      },
      ['path'],
    ),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, item) => toText([
        `状态：${item.status}${item.reason ? `（${item.reason}）` : ''}`,
        `解析：片名=${item.title || '—'} 年份=${item.year ?? '—'} 季=${item.season ?? '—'} 集=${item.episode ?? '—'}`
          + `${item.part ? ` Part=${item.part}` : ''}${item.version ? ` 版本=${item.version}` : ''}`,
        item.proposedPath ? `提议：${item.proposedPath}` : '',
      ].filter(Boolean).join('\n')),
    },
    execute: (args) => {
      const { pack } = resolveContext(config, args)
      return jsonSafe(analyze(args?.path ?? '', {
        pack,
        mediaType: args?.mediaType === 'auto' ? undefined : args?.mediaType,
      }))
    },
    presentCall: (args) => ({ card: 'generic', title: '解析文件名', kind: 'read', rawInput: args }),
  })

  ctx.tools.register({
    name: 'media_naming_plan',
    description:
      '生成批量命名的 dry-run 计划：给出每条文件的「当前路径 → 提议路径」与状态，以及变更/跳过/冲突/未知/超范围的计数。'
      + '两种用法：传 `paths` 做离线试算；或传 `target`（使用者指定的那一个节目目录）先只读扫描再算。'
      + '**前置条件已内化**：凭据、Python 解释器、根目录、规则包都自动取配置与规则包，调用方只需给 `target`。'
      + '计划总是落盘并记住「最近一次」，后续 review / check / apply 可以省略路径。本工具只读。',
    parameters: objectSchema({
      paths: { type: 'array', items: { type: 'string' }, description: '离线试算用的路径列表；传入后不访问网盘。' },
      target: { type: 'string', description: '使用者指定的路径（任意层级，可带根名也可不带），如 `影视资源/电视剧/某剧 (2026)`。' },
      seasonFolder: { type: 'boolean', description: '可选：是否建 Season 子目录；不传则按规则包设置。' },
      mediaType: { type: 'string', enum: ['auto', 'movie', 'tv'], description: '可选：强制内容类型。' },
      limit: { type: 'integer', description: '可选：扫描模式下的最大条目数，默认 500。' },
      root: { type: 'string', description: '可选：根目录名，默认取配置或规则包的 rootPrefix。' },
      cookiesPath: { type: 'string', description: '可选：凭据文件路径，默认取配置。' },
      pythonPath: { type: 'string', description: '可选：Python 解释器，默认取配置。' },
      outputPath: { type: 'string', description: '可选：计划落盘路径，默认写到配置目录的 plans/ 下。' },
      pack: { type: 'string', description: '可选：指定内置规则包 id。' },
      rulePackPath: { type: 'string', description: '可选：你自己的规则包 JSON 文件路径。' },
    }),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText(summarizePlan(value.plan, value.planPath)),
    },
    execute: async (args, exec) => {
      const { settings, pack } = resolveContext(config, args)
      let paths = asArray(args?.paths)
      let existingByDir = {}
      let source = 'paths'
      let rootPath = ''
      let scannedStorage = ''
      if (paths.length === 0) {
        if (!args?.target) {
          throw new Error('缺少输入：请传 `paths`（离线试算）或 `target`（要处理的路径）。')
        }
        // 后端选择与凭据校验都由 storage 层负责
        const scanned = await scanTarget(ctx, config, settings, {
          target: args.target,
          limit: args.limit,
          signal: exec?.signal,
        })
        paths = asArray(scanned.files)
        existingByDir = scanned.existingByDir ?? {}
        rootPath = scanned.rootPath ?? ''
        scannedStorage = scanned.storage ?? ''
        source = 'scan'
      }

      const result = plan(paths, {
        pack,
        mediaType: args?.mediaType === 'auto' ? undefined : args?.mediaType,
        existingByDir,
        seasonFolder: args?.seasonFolder,
      })
      const payload = buildPlanPayload({
        result, pack, target: args?.target, rootPath, source, seasonFolder: args?.seasonFolder,
        storage: scannedStorage,
      })
      return jsonSafe({ plan: payload, planPath: savePlan(payload, args?.outputPath) })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.target ? `生成命名计划：${args.target}` : '生成命名计划（离线试算）',
      kind: 'other',
      rawInput: { target: args?.target, pathCount: args?.paths?.length ?? 0 },
    }),
  })

  ctx.tools.register({
    name: 'media_naming_quick',
    description:
      '**首选入口**：给一个路径，一次完成「只读扫描 → 解析 → 计划 → 审核清单」并自动落盘。'
      + '路径可以是**整库、一个节目目录、甚至只有一个视频的目录**——目录名与层级由使用者决定，插件不预设也不限制。'
      + '调用方只需给 `target`：凭据、Python 解释器、根目录、规则包全部自动取自配置与规则包。'
      + '返回给使用者看的对照表与放行结论；使用者点头后，用 media_naming_apply 执行。只读。',
    parameters: objectSchema(
      {
        target: { type: 'string', description: '使用者指定的路径，可带根名也可不带，如 `影视资源/电视剧/某剧 (2026)` 或 `电视剧/某剧 (2026)`。必填。' },
        seasonFolder: { type: 'boolean', description: '可选：是否建 Season 子目录；不传则按规则包设置。' },
        mediaType: { type: 'string', enum: ['auto', 'movie', 'tv'], description: '可选：强制内容类型。' },
        limit: { type: 'integer', description: '可选：最多扫描的条目数，默认 500。' },
        pack: { type: 'string', description: '可选：指定内置规则包 id。' },
      },
      ['target'],
    ),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText(value.markdown),
    },
    execute: async (args, exec) => {
      const { settings, pack } = resolveContext(config, args)
      const target = String(args?.target ?? '').trim()
      if (!target) throw new Error('缺少 target：请给出要整理的那个路径（不要扫整库）。')
      // 后端选择与凭据校验都由 storage 层负责：本地 / NAS 路径不需要 115 凭据

      const scanned = await scanTarget(ctx, config, settings, {
        target,
        limit: args.limit,
        signal: exec?.signal,
      })
      const result = plan(asArray(scanned.files), {
        pack,
        mediaType: args?.mediaType === 'auto' ? undefined : args?.mediaType,
        existingByDir: scanned.existingByDir ?? {},
        seasonFolder: args?.seasonFolder,
      })
      const payload = buildPlanPayload({
        result, pack, target, rootPath: scanned.rootPath ?? '', source: 'scan',
        seasonFolder: args?.seasonFolder,
        storage: scanned.storage ?? '',
      })
      const planPath = savePlan(payload, '')
      const review = buildReview(payload)

      return jsonSafe({
        planPath,
        planId: payload.planId,
        target,
        rootPath: payload.scope.rootPath,
        summary: payload.summary,
        verdict: review.verdict,
        markdown: renderReview(review, 60),
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `快速命名：${args?.target ?? ''}`,
      kind: 'read',
      rawInput: { target: args?.target },
    }),
  })

  ctx.tools.register({
    name: 'media_naming_verify',
    description: '校验一条路径是否符合当前规则包，返回是否合规、违规原因与规范化的建议路径。不访问网盘。',
    parameters: objectSchema(
      {
        candidatePath: { type: 'string', description: '待校验的路径。' },
        keepVersion: { type: 'boolean', description: '是否按「保留版本后缀」校验，默认否。' },
        pack: { type: 'string', description: '可选：指定内置规则包 id。' },
        rulePackPath: { type: 'string', description: '可选：你自己的规则包 JSON 文件路径。' },
      },
      ['candidatePath'],
    ),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText(value.conforms
        ? `✅ 符合规范：${value.item.currentPath}`
        : `❌ 不符合规范：${value.item.currentPath}\n${value.violations.map((one) => `· ${one}`).join('\n')}`),
    },
    execute: (args) => {
      const candidate = args?.candidatePath ?? ''
      const { pack } = resolveContext(config, args)
      const item = analyze(candidate, { pack })
      const blocked = item.status === 'UNKNOWN' || item.status === 'OUT_OF_SCOPE'
      const proposed = blocked ? '' : buildTarget({
        library: item.library,
        prefix: item.prefix,
        mediaType: item.mediaType || 'movie',
        title: item.title,
        year: item.year,
        season: item.season,
        episode: item.episode,
        part: item.part,
        version: args?.keepVersion ? item.version : '',
        ext: extOf(item.filename),
      })
      const violations = []
      if (blocked) violations.push(item.reason)
      else if (proposed !== candidate) violations.push(`提议路径应为：${proposed}`)
      return jsonSafe({ conforms: violations.length === 0, violations, proposedPath: proposed, item })
    },
    presentCall: (args) => ({ card: 'generic', title: '校验命名', kind: 'read', rawInput: args }),
  })

  ctx.tools.register({
    name: 'media_naming_scan',
    description:
      '只读扫描**使用者指定的那个路径**，返回其下的视频文件清单与已有文件名。'
      + '路径可以是整库、一个节目目录、甚至只有一个视频的目录——目录名与层级不预设；可带根名也可不带。'
      + '凭据与 Python 解释器默认取配置，调用方只需给 `path`。本工具只读。',
    parameters: objectSchema(
      {
        path: { type: 'string', description: '使用者指定的路径（任意层级），如 `影视资源/电视剧/某剧 (2026)` 或 `电视剧/某剧 (2026)`。必填。' },
        cookiesPath: { type: 'string', description: '可选：凭据文件路径，默认取配置。' },
        root: { type: 'string', description: '可选：根目录名，默认取配置或规则包的 rootPrefix。' },
        pythonPath: { type: 'string', description: '可选：Python 解释器，默认取配置。' },
        limit: { type: 'integer', description: '最多扫描的文件条目数，默认 500。' },
        pack: { type: 'string', description: '可选：指定内置规则包 id（用于取默认根目录名）。' },
      },
      ['path'],
    ),
    output: {
      schema: LOOSE_OBJECT,
      render: (_args, value) => toText(
        `扫描 ${value.rootPath}：视频 ${value.files.length} 个、条目 ${value.scanned} 个`
        + `${value.truncated ? '（已截断，请提高 limit 或缩小 path）' : ''}`,
      ),
    },
    execute: (args, exec) => {
      const { settings } = resolveContext(config, args)
      return scanTarget(ctx, config, settings, {
        target: args?.path ?? '',
        limit: args?.limit,
        signal: exec?.signal,
      })
    },
    presentCall: (args) => ({ card: 'generic', title: `扫描 ${args?.path || '根目录'}`, kind: 'read', rawInput: args }),
  })

  ctx.logger?.info?.('media-naming 已注册 6 个只读工具（目标目录与规则包均由调用方指定）。')
}
