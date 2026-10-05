/**
 * 「配置查看」与「审核视图」两个工具（都只读）。
 *
 * - `media_naming_config`：告诉你配置在哪、当前值来自哪里、还缺什么；
 * - `media_naming_review`：把计划变成给使用者看的对照表与放行结论。
 */
import { readFileSync } from 'node:fs'

import { FIELD_HELP, cookiesFileStatus, latestPlanPath, resolveSettings } from './config.js'
import { plan as buildPlan } from './plan.js'
import { buildReview, renderReview } from './review.js'
import { resolveRulePack } from './rules.js'
import { LOOSE_OBJECT, jsonSafe, objectSchema, toText } from './schema.js'

const REVIEW_LIMIT = 60

function renderConfig(value) {
  const lines = [
    `配置文件：${value.configPath}${value.configExists ? '' : '（尚未创建）'}`,
  ]
  if (value.configError) lines.push(`⛔ ${value.configError}`)
  lines.push('')
  for (const [key, val] of Object.entries(value.values)) {
    lines.push(`${key} = ${val || '（空）'}    ← ${value.sources[key]}`)
  }
  lines.push('')
  lines.push(value.cookiesFile.path
    ? `cookie 文件：${value.cookiesFile.exists ? `存在（${value.cookiesFile.size} 字节）` : `不存在：${value.cookiesFile.path}`}`
    : 'cookie 文件：未设置')
  lines.push(...(value.missing.length > 0
    ? value.missing.map((item) => `⛔ ${item}`)
    : ['✅ 配置齐备']))
  lines.push('', '怎么填：')
  lines.push(...value.howTo.map((item) => `- ${item}`))
  return toText(lines.join('\n'))
}

/**
 * 注册配置与审核工具。
 * @param {object} ctx 插件上下文
 * @param {object} config 插件配置（profile 里的那一行）
 */
export function registerConfigTools(ctx, config) {
  ctx.tools.register({
    name: 'media_naming_config',
    description:
      '查看插件配置：配置文件的位置、各字段当前取值与来源（调用参数 / 插件配置 / 配置文件 / 默认值）、'
      + 'cookie 文件是否就绪、还缺什么、以及怎么补。只读——插件不会替你写这个文件。',
    parameters: objectSchema({}),
    output: { schema: LOOSE_OBJECT, render: (_args, value) => renderConfig(value) },
    execute: () => {
      const settings = resolveSettings(config, {})
      const status = cookiesFileStatus(settings.cookiesPath)
      const missing = []
      if (!settings.cookiesPath) {
        missing.push('cookiesPath 未设置：扫描与执行前需要它（可用扫码登录脚本自动写入）')
      } else if (!status.exists) {
        missing.push(`cookiesPath 指向的文件不存在：${settings.cookiesPath}`)
      }
      return {
        configPath: settings.config.path,
        configDir: settings.config.dir,
        configExists: settings.config.exists,
        configError: settings.config.error,
        values: {
          cookiesPath: settings.cookiesPath,
          pythonPath: settings.pythonPath,
          root: settings.root,
          rulePack: settings.rulePack,
        },
        sources: settings.sources,
        cookiesFile: status,
        missing,
        fieldHelp: FIELD_HELP,
        howTo: [
          `在 ${settings.config.path} 写一个 JSON，例如 {"cookiesPath": "…/cookies.txt", "pythonPath": "python"}`,
          '或者运行扫码登录脚本，由脚本自动写入 cookie 文件与这个配置：python/login_115.py',
          '字段含义见 fieldHelp；调用工具时传参数仍然可以临时覆盖配置',
        ],
      }
    },
    presentCall: () => ({ card: 'generic', title: '查看插件配置', kind: 'read' }),
  })

  ctx.tools.register({
    name: 'media_naming_review',
    description:
      '把命名计划变成**给使用者看**的审核清单：按作品分组的前后对照表、风险提示，以及「能不能进入执行」的结论。'
      + '`planPath` 可省略（默认用「最近一次计划」）；也可以直接传 `paths` 试算。只读，不执行任何写操作。',
    parameters: objectSchema({
      planPath: { type: 'string', description: '可选：计划 JSON 路径；不传则用「最近一次计划」。' },
      paths: { type: 'array', items: { type: 'string' }, description: '直接试算的路径列表；不传 planPath 时使用。' },
      mediaType: { type: 'string', enum: ['auto', 'movie', 'tv'], description: '可选：强制内容类型。' },
      limit: { type: 'integer', description: '对照表最多列出多少条，默认 60。' },
      pack: { type: 'string', description: '可选：指定内置规则包 id。' },
      rulePackPath: { type: 'string', description: '可选：你自己的规则包 JSON 文件路径。' },
    }),
    output: { schema: LOOSE_OBJECT, render: (_args, value) => toText(value.markdown) },
    execute: (args) => {
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : REVIEW_LIMIT
      // 优先级：显式 planPath > 显式 paths > 「最近一次计划」
      const hasPaths = Array.isArray(args?.paths) && args.paths.length > 0
      const resolvedPlanPath = args?.planPath || (hasPaths ? '' : latestPlanPath())
      let plan
      if (resolvedPlanPath) {
        plan = JSON.parse(readFileSync(resolvedPlanPath, 'utf8'))
      } else if (hasPaths) {
        const pack = resolveRulePack(args)
        const result = buildPlan(args.paths, {
          pack,
          mediaType: args?.mediaType === 'auto' ? undefined : args?.mediaType,
        })
        plan = {
          planId: 'plan-review',
          scope: { pack: pack.id, target: '', source: 'paths' },
          summary: result.summary,
          items: result.items,
        }
      } else {
        throw new Error('没有可审核的计划：请先用 media_naming_quick 生成，或传 `paths` 直接试算。')
      }
      const review = buildReview(plan)
      return jsonSafe({ review, markdown: renderReview(review, limit) })
    },
    presentCall: (args) => ({ card: 'generic', title: '审核命名计划', kind: 'read', rawInput: { planPath: args?.planPath } }),
  })

  ctx.logger?.info?.('media-naming 已注册配置查看与审核视图工具。')
}
