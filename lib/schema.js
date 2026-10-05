/**
 * 工具 schema 的公共构件。
 *
 * 关键约定：本插件不依赖 `@deepseek-ai/dsh-tools`，因此 `parameters` 必须
 * 自己写成**标准 JSON Schema**（顶层 `type: 'object'`）。`defineTool()` 本来
 * 负责这一步编译；绕过它就必须自己给出标准形式，否则注册出去的工具 schema
 * 顶层 type 为空，整个模型请求会被拒绝（`got 'type: null'`）。
 */

/** 输出 schema 用：结构由 render 决定，这里只声明"是个对象"。 */
export const LOOSE_OBJECT = { type: 'object', additionalProperties: true, properties: {} }

/** 构造标准 JSON Schema 的对象根。 */
export function objectSchema(properties, required) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  }
}

/** 工具结果 → 文本内容块。 */
export const toText = (value) => [{ type: 'text', text: value }]

/**
 * 工具返回值必须是**无损 JSON**：DSH 会逐个字段校验。
 * 解析结果里「没有的值」用 `undefined` 表示，直接返回会被注册表拒绝
 * （`value is not lossless JSON`），这里统一净化掉。
 */
export function jsonSafe(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}
