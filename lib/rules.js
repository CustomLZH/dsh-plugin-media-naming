/**
 * 规则包与样例的加载入口。
 *
 * 规则**不是代码常量**：目标目录映射、清洗标签、模板与口径都在
 * `rules/<pack>/rules.json`，可由使用者替换或在调用时覆盖。
 * 解析引擎只认规则包，不认识任何具体的目录名。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RULES_DIR = path.join(PLUGIN_DIR, 'rules')

const readJson = (relative) => JSON.parse(readFileSync(path.join(RULES_DIR, relative), 'utf8'))

/** 规则包注册表：有哪些包、默认用哪个。 */
export function loadRegistry() {
  return readJson('registry.json')
}

/** 读取一个内置规则包（不传则用注册表里的默认包）。 */
export function loadRulePack(id) {
  const registry = loadRegistry()
  const packId = id || registry.default
  const packs = registry.packs ?? []
  if (!packId || !packs.includes(packId)) {
    throw new Error(`未知规则包 ${packId ?? '(空)'}；可用：${packs.join('、') || '（无）'}`)
  }
  return readJson(path.join(packId, 'rules.json'))
}

/** 读取某个规则包配套的样例集。 */
export function loadExamples(id) {
  const registry = loadRegistry()
  const packId = id || registry.default
  return readJson(path.join(packId, 'examples.json'))
}

/** 顶层字段浅合并，三个嵌套表单独合并，避免覆盖时丢掉其余条目。 */
function mergePack(base, override) {
  const merged = { ...base, ...override }
  for (const key of ['cleanup', 'policies', 'templates', 'statuses']) {
    if (base[key] || override[key]) merged[key] = { ...base[key], ...override[key] }
  }
  return merged
}

/**
 * 解析本次要使用的规则包。
 * 优先级：内置包打底 → `rulePack`（对象）或 `rulePackPath`（JSON 文件）覆盖。
 */
export function resolveRulePack(options = {}) {
  const base = loadRulePack(options.pack)
  let override = options.rulePack
  if (!override && options.rulePackPath) {
    override = JSON.parse(readFileSync(options.rulePackPath, 'utf8'))
  }
  if (!override || typeof override !== 'object') return base
  return mergePack(base, override)
}

/** 标签表数量摘要，供规则工具展示。 */
export function tagSummary(pack) {
  const cleanup = pack?.cleanup ?? {}
  return {
    sourceCodec: (cleanup.sourceCodec ?? []).length,
    version: (cleanup.version ?? []).length,
    chinese: (cleanup.chinese ?? []).length,
    bracketNoise: (cleanup.bracketNoise ?? []).length,
  }
}

export const RULES_SECTION_NAME = 'media-naming-rules'
export const RULES_SECTION_ORDER = 60

/**
 * 生成注入系统提示的规则摘要（保持精简：细读走 skill / 工具）。
 * 内容由规则包派生，换包即换文案。
 */
export function buildRulesSection(pack) {
  const rule = pack ?? loadRulePack()
  const policies = rule.policies ?? {}
  const statuses = rule.statuses ?? {}
  const lines = [
    `## ${rule.title ?? '媒体库命名规则'}（插件 media-naming）`,
    '',
    '使用者让你整理某个影视路径时套用本规则；细则用 `media_naming_rules` 取，样例用 `media_naming_examples` 取（可照着模仿）。',
    `- 目录名与层级**由使用者决定，插件不预设也不限制**：整库、一个节目目录、甚至只有一个视频的目录都行${rule.rootPrefix ? `；规则包里的 \`${rule.rootPrefix}\` 只是**可改的默认根名**，不是必须的前缀` : ''}。`,
    '',
    '**处理范围（最重要）**',
    policies.scope ? `- ${policies.scope}` : '',
    '- 使用者没说清楚目录时先问，不要自己挑一个目录开始扫。',
    '',
    '**怎么动手（首选路径）**',
    '- 只要两句话：先 `media_naming_quick`（**只需给 target**）拿到审核清单 → 原样展示给使用者 → 得到明确同意后 `media_naming_apply`（confirm=true）。',
    `- \`target\` 是**相对根**的路径：使用者说 \`${rule.rootPrefix ?? ''}/电视剧/某剧 (2026)\` 时，target 传 \`电视剧/某剧 (2026)\`（去掉最前面的根目录名）。`,
    '- 这两个工具**不需要**传凭据、Python 解释器、根目录、规则包：它们自动取自配置与规则包，且**跨会话共用**。',
    '- 若工具报「还没有登录凭据」，让使用者在插件目录运行 `python/login_115.py` 扫码登录一次即可。',
    '- 执行完成后 `media_naming_apply` 会自动复验，请把复验结论一并回报给使用者。',
    '- 需要离线试算或精细控制时，再用 plan / review / check / verify / rules / examples。',
    '',
    policies.core ? `- ${policies.core}` : '',
    policies.chineseTitle ? `- ${policies.chineseTitle}` : '',
    policies.versionSuffix ? `- ${policies.versionSuffix}` : '',
    statuses.CONFLICT ? `- ${statuses.CONFLICT}` : '',
    statuses.UNKNOWN ? `- ${statuses.UNKNOWN}` : '',
    policies.readonly ? `- ${policies.readonly}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}
