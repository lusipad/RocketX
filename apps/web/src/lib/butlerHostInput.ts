import type { JsonValue } from '../agent/protocol/generated/serde_json/JsonValue';
import type { McpServerElicitationRequestResponse } from '../agent/protocol/generated/v2/McpServerElicitationRequestResponse';
import type { ToolRequestUserInputResponse } from '../agent/protocol/generated/v2/ToolRequestUserInputResponse';

export type ButlerErrandInputResponse =
  | ToolRequestUserInputResponse
  | McpServerElicitationRequestResponse;

export function isButlerErrandInputMethod(
  method: string,
): method is 'item/tool/requestUserInput' | 'mcpServer/elicitation/request' {
  return method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必须是数字`);
  return value;
}

function validateRequestUserInput(params: unknown, response: unknown): ToolRequestUserInputResponse {
  const questions = record(params).questions;
  if (!Array.isArray(questions) || questions.length === 0) throw new Error('回答请求没有可识别的问题');
  const rawAnswers = record(record(response).answers);
  const questionIds = new Set(
    questions.map((question) => record(question).id).filter((id): id is string => typeof id === 'string'),
  );
  if (Object.keys(rawAnswers).some((id) => !questionIds.has(id))) throw new Error('回答包含未知问题');

  const answers: ToolRequestUserInputResponse['answers'] = {};
  for (const rawQuestion of questions) {
    const question = record(rawQuestion);
    const questionId = typeof question.id === 'string' ? question.id : '';
    if (!questionId) throw new Error('回答请求缺少问题编号');
    const values = record(rawAnswers[questionId]).answers;
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('请回答所有问题');
    }
    const options = Array.isArray(question.options)
      ? question.options.map((option) => record(option).label).filter((label): label is string => typeof label === 'string')
      : [];
    if (options.length > 0 && question.isOther !== true && values.some((value) => !options.includes(value))) {
      throw new Error('回答不在可选范围内');
    }
    answers[questionId] = { answers: values.map((value) => value.trim()) };
  }
  return { answers };
}

function enumValues(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.enum)) return schema.enum.filter((value): value is string => typeof value === 'string');
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((option) => record(option).const)
      .filter((value): value is string => typeof value === 'string');
  }
  const items = record(schema.items);
  if (Array.isArray(items.enum)) return items.enum.filter((value): value is string => typeof value === 'string');
  if (Array.isArray(items.anyOf)) {
    return items.anyOf
      .map((option) => record(option).const)
      .filter((value): value is string => typeof value === 'string');
  }
  return [];
}

function validateMcpValue(name: string, schema: Record<string, unknown>, value: unknown): JsonValue {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${name} 必须是文本`);
    const minLength = typeof schema.minLength === 'number' ? schema.minLength : undefined;
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
    if (minLength !== undefined && value.length < minLength) throw new Error(`${name} 内容太短`);
    if (maxLength !== undefined && value.length > maxLength) throw new Error(`${name} 内容太长`);
    const allowed = enumValues(schema);
    if (allowed.length > 0 && !allowed.includes(value)) throw new Error(`${name} 不在可选范围内`);
    return value;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const number = finiteNumber(value, name);
    if (schema.type === 'integer' && !Number.isInteger(number)) throw new Error(`${name} 必须是整数`);
    if (typeof schema.minimum === 'number' && number < schema.minimum) throw new Error(`${name} 小于最小值`);
    if (typeof schema.maximum === 'number' && number > schema.maximum) throw new Error(`${name} 大于最大值`);
    return number;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${name} 必须是是或否`);
    return value;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} 必须是选项列表`);
    const allowed = enumValues(schema);
    if (value.some((item) => !allowed.includes(item))) throw new Error(`${name} 包含未知选项`);
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : undefined;
    const maxItems = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (minItems !== undefined && value.length < minItems) throw new Error(`${name} 选择太少`);
    if (maxItems !== undefined && value.length > maxItems) throw new Error(`${name} 选择太多`);
    return value;
  }
  throw new Error(`${name} 使用了不支持的字段类型`);
}

function validateMcpElicitation(params: unknown, response: unknown): McpServerElicitationRequestResponse {
  const request = record(params);
  const candidate = record(response);
  const action = candidate.action;
  if (action !== 'accept' && action !== 'decline' && action !== 'cancel') throw new Error('表单操作无效');
  if (action !== 'accept') return { action, content: null, _meta: null };
  if (request.mode === 'url') return { action, content: null, _meta: null };
  if (request.mode !== 'form') throw new Error('当前客户端不能提交这种表单');

  const schema = record(request.requestedSchema);
  const properties = record(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const rawContent = record(candidate.content);
  if (Object.keys(rawContent).some((name) => !Object.prototype.hasOwnProperty.call(properties, name))) {
    throw new Error('表单包含未知字段');
  }
  const content: { [key: string]: JsonValue } = {};
  for (const [name, rawSchema] of Object.entries(properties)) {
    const hasValue = Object.prototype.hasOwnProperty.call(rawContent, name);
    if (!hasValue) {
      if (required.has(name)) throw new Error(`请填写 ${name}`);
      continue;
    }
    content[name] = validateMcpValue(name, record(rawSchema), rawContent[name]);
  }
  return { action, content, _meta: null };
}

export function validateButlerErrandInputResponse(
  method: string,
  params: unknown,
  response: ButlerErrandInputResponse,
): ButlerErrandInputResponse {
  if (method === 'item/tool/requestUserInput') return validateRequestUserInput(params, response);
  if (method === 'mcpServer/elicitation/request') return validateMcpElicitation(params, response);
  throw new Error('该请求类型没有可用的回答表单');
}

export function safeButlerExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
