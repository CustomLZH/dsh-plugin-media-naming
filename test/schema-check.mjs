/**
 * 工具 schema 校验：用 DSH 自己的 schema 断言检查 5 个工具的定义。
 *
 * 为什么需要这一步：本插件不依赖 `@deepseek-ai/dsh-tools`，所以 `parameters`
 * 必须自己写成标准 JSON Schema。漏掉顶层 `type: 'object'` 会让**整个模型请求**
 * 失败（`Invalid schema for function ... got 'type: null'`），而且失败发生在
 * 请求组装阶段，插件侧看不到任何报错——所以必须在安装前离线校验。
 *
 * 运行：node test/schema-check.mjs
 * 退出码：全部通过为 0，否则为 1。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const HOME = process.env.USERPROFILE || process.env.HOME || ''

const DSH_TOOLS_PATH = path.join(
  HOME,
  '.dsh/profiles/node_modules/dsh-plugin-desktop/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
)

if (!existsSync(DSH_TOOLS_PATH)) {
  console.error(`找不到 DSH 的 dsh-tools 实现，无法校验：${DSH_TOOLS_PATH}`)
  process.exit(1)
}
const { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } =
  await import(pathToFileURL(DSH_TOOLS_PATH).href)

const SAMPLE_ARGS = {
  media_naming_rules: {},
  media_naming_examples: { kind: 'positive' },
  media_naming_flow: {},
  media_naming_check: { step: 'prepare' },
  media_naming_apply: { planPath: 'C:/plan.json', confirm: true },
  media_naming_config: {},
  media_naming_review: { planPath: 'C:/plan.json' },
  media_naming_parse: { path: '影视资源/电影/示例电影 (2024)/示例电影.2160p.mkv' },
  media_naming_scan: { cookiesPath: 'C:/path/cookies.txt', path: '电视剧' },
  media_naming_plan: { paths: ['影视资源/电影/示例电影 (2024)/示例电影.2160p.mkv'] },
  media_naming_verify: { candidatePath: '影视资源/电影/示例电影 (2024)/示例电影 (2024).mkv' },
  media_naming_quick: { target: '电影/示例电影 (2024)' },
}

const registered = new Map()
const ctx = {
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  get: () => undefined,
  logger: { info: () => {}, warn: () => {} },
}

const plugin = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href)
plugin.apply(ctx, { planOutputDir: path.join(PLUGIN_DIR, 'out', 'schema-check') })

const checks = []
const check = (name, fn) => {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, detail: error?.message || String(error) })
  }
}

for (const [toolName, definition] of registered) {
  check(`${toolName}: parameters 是 object 根 schema`, () => assertObjectJsonSchema(definition.parameters))
  check(`${toolName}: output.schema 属于受支持子集`, () => assertSupportedJsonSchema(definition.output.schema))
  check(`${toolName}: 顶层 type 显式为 object`, () => {
    if (definition.parameters.type !== 'object') {
      throw new Error(`type=${JSON.stringify(definition.parameters.type)}`)
    }
  })
  check(`${toolName}: 示例参数通过校验`, () => {
    const violations = validateJsonSchemaValue(definition.parameters, SAMPLE_ARGS[toolName] ?? {}, '')
    if (violations.length > 0) throw new Error(violations.join('; '))
  })
}

// 负例：确认这套断言真的能抓出当初的错误写法（缺少顶层 type）。
check('负例：缺顶层 type 的方言写法必须被拒绝', () => {
  let threw = false
  try {
    assertObjectJsonSchema({ path: { type: 'string', required: true } })
  } catch {
    threw = true
  }
  if (!threw) throw new Error('断言没有拒绝缺 type 的 schema，说明校验无效')
})

check('负例：多余关键字必须被拒绝', () => {
  let threw = false
  try {
    assertSupportedJsonSchema({ type: 'object', properties: { a: { type: 'string', required: true } } })
  } catch {
    threw = true
  }
  if (!threw) throw new Error('断言没有拒绝 required: true，说明校验无效')
})

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`[${item.ok ? 'OK' : 'FAIL'}] ${item.name}${item.ok || !item.detail ? '' : ` -> ${item.detail}`}`)
}
console.log('='.repeat(60))
console.log(`tools=${registered.size} checks=${checks.length} passed=${checks.length - failed} failed=${failed}`)
process.exit(failed === 0 ? 0 : 1)
