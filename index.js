/**
 * 个人网盘影视库统一命名（插件 ID：media-naming / 包名 dsh-plugin-media-naming）。
 *
 * 定位：插件提供「可替换的规则包 + 一组只读工具」，具体判断与执行交给 Agent。
 * - 代码不认识任何具体目录：要处理哪个库、哪个作品，由调用方在参数里给出；
 * - 规则不是代码常量：目标目录映射、清洗标签、模板都在规则包里，可替换可扩展；
 * - 规则、样例与解析引擎全部内置在包内，运行时不读取外部脚本、不使用本机绝对路径。
 */
import { registerConfigTools } from './lib/config-tools.js'
import { registerFlowTools } from './lib/flow-tools.js'
import { RULES_SECTION_NAME, RULES_SECTION_ORDER, buildRulesSection, resolveRulePack } from './lib/rules.js'
import { registerTools } from './lib/tools.js'

const name = 'media-naming'
const inject = ['tools']

/** 默认配置保持最小：没有本机路径，也没有写死的库名。 */
const DEFAULT_CONFIG = {
  rulePack: '',
  pythonPath: 'python',
  cookiesPath: '',
}

/**
 * @param {object} ctx Cordis 插件上下文
 * @param {object} [config] profile 中该行的 config
 */
function apply(ctx, config) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) }
  registerTools(ctx, merged)
  registerFlowTools(ctx, merged)
  registerConfigTools(ctx, merged)

  // 命名规则注入：内容由规则包派生，换包即换文案。
  const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (prompt) {
    let text = ''
    try {
      text = buildRulesSection(resolveRulePack({ pack: merged.rulePack || undefined }))
    } catch (error) {
      // 规则包读取失败不应让整个插件挂掉：工具会各自报出具体原因。
      ctx.logger?.warn?.(`media-naming 规则包加载失败：${error?.message ?? error}`)
      text = ''
    }
    if (text) {
      prompt.section({ name: RULES_SECTION_NAME, order: RULES_SECTION_ORDER, text })
    }
  }
}

export { apply, inject, name }
