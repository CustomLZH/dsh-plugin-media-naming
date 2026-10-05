/**
 * 一次解析出「生效的设置」与「生效的规则包」。
 *
 * 设置优先级：调用参数 > 插件配置 > 配置文件（`$DSH_HOME/media-naming/config.json`）> 默认值；
 * 规则包优先级：调用参数 `pack` > 配置里的 `rulePack` > 注册表默认包。
 */
import { resolveSettings } from './config.js'
import { resolveRulePack } from './rules.js'

/**
 * @param {object} pluginConfig profile 里该插件行的 config
 * @param {object} args 本次工具调用的参数
 * @returns {{ settings: object, pack: object }}
 */
export function resolveContext(pluginConfig = {}, args = {}) {
  const settings = resolveSettings(pluginConfig, args)
  const pack = resolveRulePack({
    pack: settings.rulePack || undefined,
    rulePackPath: args?.rulePackPath,
  })
  return { settings, pack }
}
