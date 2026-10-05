/**
 * 插件配置：读 `$DSH_HOME/media-naming/config.json`。
 *
 * 使用者填一次（cookies 路径等），之后所有工具自动取用；
 * 调用参数仍然可以临时覆盖。**没有任何本机路径写死在代码里**：
 * `DSH_HOME` 是 DSH 自己的目录，缺失时回退到 `~/.dsh`。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_DIR_NAME = 'media-naming'
const CONFIG_FILE_NAME = 'config.json'

/** DSH 的配置根目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 本插件的配置目录。 */
export function configDir() {
  return path.join(dshHome(), CONFIG_DIR_NAME)
}

/** 配置文件路径。 */
export function configPath() {
  return path.join(configDir(), CONFIG_FILE_NAME)
}

/** 扫码登录默认写入的 cookie 文件路径。 */
export function defaultCookiesPath() {
  return path.join(configDir(), 'cookies.txt')
}

/** 计划落盘目录：`$DSH_HOME/media-naming/plans`。 */
export function plansDir() {
  return path.join(configDir(), 'plans')
}

/** 「最近一次计划」指针文件。 */
function latestPlanFile() {
  return path.join(plansDir(), 'latest.json')
}

/**
 * 记住最近一次落盘的计划，让 review / check / apply 可以省略 planPath。
 * 指针只是便利设施，写不进去也不影响计划本身，因此失败时静默。
 */
export function rememberPlan(planPath, meta = {}) {
  try {
    mkdirSync(plansDir(), { recursive: true })
    writeFileSync(
      latestPlanFile(),
      `${JSON.stringify({ planPath, at: new Date().toISOString(), ...meta }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    /* 忽略：不影响计划本身 */
  }
}

/** 读取「最近一次计划」的路径；没有记录或文件已删则返回空串。 */
export function latestPlanPath() {
  try {
    const record = JSON.parse(readFileSync(latestPlanFile(), 'utf8'))
    const planPath = record?.planPath
    return typeof planPath === 'string' && existsSync(planPath) ? planPath : ''
  } catch {
    return ''
  }
}

/** 读取配置文件；解析失败时给出可读原因，而不是抛出去。 */
export function loadConfigFile() {
  const file = configPath()
  if (!existsSync(file)) return { data: {}, exists: false, error: '' }
  try {
    return { data: JSON.parse(readFileSync(file, 'utf8')), exists: true, error: '' }
  } catch (error) {
    return { data: {}, exists: true, error: `配置解析失败（请检查 JSON 格式）：${error?.message ?? error}` }
  }
}

/**
 * 合并设置。优先级：调用参数 > profile 里的插件 config > 配置文件 > 默认值。
 * 同时记录每个值来自哪里，便于 `media_naming_config` 告诉使用者出处。
 */
export function resolveSettings(pluginConfig = {}, args = {}) {
  const file = loadConfigFile()
  const pick = (name, fallback) => {
    const fromArgs = args?.[name]
    if (fromArgs !== undefined && fromArgs !== null && fromArgs !== '') {
      return { value: fromArgs, source: '调用参数' }
    }
    const fromPlugin = pluginConfig?.[name]
    if (fromPlugin !== undefined && fromPlugin !== null && fromPlugin !== '') {
      return { value: fromPlugin, source: '插件配置' }
    }
    const fromFile = file.data?.[name]
    if (fromFile !== undefined && fromFile !== null && fromFile !== '') {
      return { value: fromFile, source: '配置文件' }
    }
    return { value: fallback, source: '默认值' }
  }

  const cookies = pick('cookiesPath', '')
  const python = pick('pythonPath', 'python')
  const root = pick('root', '')
  const storage = pick('storage', '')
  // 规则包：`pack` 参数优先，其次配置里的 rulePack
  const pack = args?.pack ? { value: args.pack, source: '调用参数' } : pick('rulePack', '')

  return {
    cookiesPath: cookies.value,
    pythonPath: python.value,
    root: root.value,
    storage: storage.value,
    rulePack: pack.value,
    sources: {
      cookiesPath: cookies.source,
      pythonPath: python.source,
      root: root.source,
      storage: storage.source,
      rulePack: pack.source,
    },
    config: { path: configPath(), dir: configDir(), exists: file.exists, error: file.error },
  }
}

/** cookie 文件的轻量状态：只看存在与大小，绝不读取或返回内容。 */
export function cookiesFileStatus(cookiesPath) {
  if (!cookiesPath) return { path: '', exists: false, size: 0 }
  if (!existsSync(cookiesPath)) return { path: cookiesPath, exists: false, size: 0 }
  try {
    return { path: cookiesPath, exists: true, size: statSync(cookiesPath).size }
  } catch {
    return { path: cookiesPath, exists: false, size: 0 }
  }
}

/** 配置项说明，供配置工具展示"每个字段是干什么的"。 */
export const FIELD_HELP = {
  storage: '存储后端：留空或 `auto` 按路径自动判断（默认）；`local` 本机盘 / UNC(NAS) / Linux 挂载点；`115` 115 网盘',
  cookiesPath: '115 登录凭据文件路径（纯文本 Cookie 字符串）；扫码登录脚本会自动写入这里',
  pythonPath: 'Python 解释器，默认交给 PATH 解析；只在 115 的扫描 / 扫码 / 执行时需要',
  root: '115 网盘里的根目录名，如 `影视资源`；留空则按规则包默认，路径带不带根名都能识别',
  rulePack: '默认使用的内置规则包 id；留空则用注册表里的默认包',
}
