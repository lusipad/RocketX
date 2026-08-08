import { ExternalLink, Send, X } from 'lucide-react';
import { useState } from 'react';
import type { JsonValue } from '../agent/protocol/generated/serde_json/JsonValue';
import type { McpElicitationPrimitiveSchema } from '../agent/protocol/generated/v2/McpElicitationPrimitiveSchema';
import type { McpElicitationStringSchema } from '../agent/protocol/generated/v2/McpElicitationStringSchema';
import type { McpServerElicitationRequestParams } from '../agent/protocol/generated/v2/McpServerElicitationRequestParams';
import type { ToolRequestUserInputParams } from '../agent/protocol/generated/v2/ToolRequestUserInputParams';
import type { ButlerErrandInput } from '../lib/butlerErrands';
import {
  safeButlerExternalUrl,
  type ButlerErrandInputResponse,
} from '../lib/butlerHostInput';

const OTHER_VALUE = '__rocketx_other__';
const fieldClass = 'mt-1.5 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary';

function optionValues(schema: McpElicitationPrimitiveSchema): Array<{ value: string; label: string }> {
  if ('oneOf' in schema) return schema.oneOf.map((option) => ({ value: option.const, label: option.title }));
  if ('enum' in schema) {
    return schema.enum.map((value, index) => ({
      value,
      label: 'enumNames' in schema ? (schema.enumNames?.[index] ?? value) : value,
    }));
  }
  if (schema.type === 'array') {
    if ('anyOf' in schema.items) {
      return schema.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
    }
    return schema.items.enum.map((value) => ({ value, label: value }));
  }
  return [];
}

function numberLimit(value: bigint | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

function initialMcpValues(params: McpServerElicitationRequestParams): Record<string, JsonValue> {
  if (params.mode !== 'form') return {};
  const required = new Set(params.requestedSchema.required ?? []);
  return Object.fromEntries(
    Object.entries(params.requestedSchema.properties).flatMap(([name, schema]) => {
      if (!schema) return [];
      if ('default' in schema && schema.default !== undefined) return [[name, schema.default as JsonValue]];
      if (!required.has(name)) return [];
      if (schema.type === 'boolean') return [[name, false]];
      if (schema.type === 'array') return [[name, []]];
      return [];
    }),
  );
}

function FieldLabel({ name, schema, required }: {
  name: string;
  schema: McpElicitationPrimitiveSchema;
  required: boolean;
}) {
  return (
    <div>
      <span className="font-medium text-ink">{'title' in schema && schema.title ? schema.title : name}</span>
      {required ? <span className="ml-1 text-danger" aria-label="必填">*</span> : null}
      {'description' in schema && schema.description ? (
        <div className="mt-0.5 text-[11px] leading-4 text-ink-3">{schema.description}</div>
      ) : null}
    </div>
  );
}

export default function ButlerErrandInputCard({
  input,
  onResolve,
}: {
  input: ButlerErrandInput;
  onResolve: (response: ButlerErrandInputResponse) => void | Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const mcpParams = input.method === 'mcpServer/elicitation/request'
    ? input.params as McpServerElicitationRequestParams
    : undefined;
  const [formValues, setFormValues] = useState<Record<string, JsonValue>>(
    () => mcpParams ? initialMcpValues(mcpParams) : {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (response: ButlerErrandInputResponse): Promise<void> => {
    setSubmitting(true);
    setError('');
    try {
      await onResolve(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  if (input.method === 'item/tool/requestUserInput') {
    const params = input.params as ToolRequestUserInputParams;
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const complete = questions.length > 0 && questions.every((question) => {
      const selected = answers[question.id]?.trim();
      return selected === OTHER_VALUE ? Boolean(otherAnswers[question.id]?.trim()) : Boolean(selected);
    });
    const response = (): ButlerErrandInputResponse => ({
      answers: Object.fromEntries(questions.map((question) => {
        const selected = answers[question.id];
        const value = selected === OTHER_VALUE ? otherAnswers[question.id] : selected;
        return [question.id, { answers: [value.trim()] }];
      })),
    });

    return (
      <div className="rounded-lg border border-primary/35 bg-primary-light/30 p-3" data-testid="butler-request-user-input">
        <div className="space-y-4">
          {questions.map((question) => (
            <fieldset key={question.id} className="min-w-0">
              <legend className="text-xs font-medium text-ink">
                {question.header ? <span className="mr-2 text-ink-3">{question.header}</span> : null}
                {question.question}
              </legend>
              {question.options?.length ? (
                <div className="mt-2 space-y-1.5">
                  {question.options.map((option) => (
                    <label key={option.label} className="flex cursor-pointer items-start gap-2 rounded-md border border-line/80 px-2.5 py-2 hover:bg-fill-hover">
                      <input
                        type="radio"
                        name={`${input.id}-${question.id}`}
                        value={option.label}
                        checked={answers[question.id] === option.label}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                        className="mt-0.5 accent-primary"
                      />
                      <span className="min-w-0">
                        <span className="block text-xs text-ink">{option.label}</span>
                        {option.description ? <span className="block text-[11px] leading-4 text-ink-3">{option.description}</span> : null}
                      </span>
                    </label>
                  ))}
                  {question.isOther ? (
                    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line/80 px-2.5 py-2 hover:bg-fill-hover">
                      <input
                        type="radio"
                        name={`${input.id}-${question.id}`}
                        value={OTHER_VALUE}
                        checked={answers[question.id] === OTHER_VALUE}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                        className="accent-primary"
                      />
                      <span className="text-xs text-ink">其他</span>
                    </label>
                  ) : null}
                  {answers[question.id] === OTHER_VALUE ? (
                    <input
                      type={question.isSecret ? 'password' : 'text'}
                      aria-label={`${question.header || question.question}的其他回答`}
                      autoComplete="off"
                      value={otherAnswers[question.id] ?? ''}
                      onChange={(event) => setOtherAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      className={fieldClass}
                    />
                  ) : null}
                </div>
              ) : (
                <input
                  type={question.isSecret ? 'password' : 'text'}
                  aria-label={question.header || question.question}
                  autoComplete="off"
                  value={answers[question.id] ?? ''}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                  className={fieldClass}
                />
              )}
            </fieldset>
          ))}
        </div>
        {error ? <div className="mt-2 text-xs text-danger" role="alert">{error}</div> : null}
        <button
          type="button"
          disabled={!complete || submitting}
          onClick={() => void submit(response())}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Send size={12} aria-hidden="true" />
          回答并继续
        </button>
      </div>
    );
  }

  if (!mcpParams) return null;
  if (mcpParams.mode === 'url') {
    const url = safeButlerExternalUrl(mcpParams.url);
    return (
      <div className="rounded-lg border border-primary/35 bg-primary-light/30 p-3" data-testid="butler-mcp-url-input">
        <p className="text-xs leading-5 text-ink">{mcpParams.message}</p>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
            在浏览器中完成 <ExternalLink size={11} aria-hidden="true" />
          </a>
        ) : <div className="mt-2 text-xs text-danger">服务返回的地址不安全，不能打开。</div>}
        {error ? <div className="mt-2 text-xs text-danger" role="alert">{error}</div> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={!url || submitting} onClick={() => void submit({ action: 'accept', content: null, _meta: null })} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-45">我已完成</button>
          <button type="button" disabled={submitting} onClick={() => void submit({ action: 'cancel', content: null, _meta: null })} className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-45"><X size={12} />取消</button>
        </div>
      </div>
    );
  }

  if (mcpParams.mode === 'openai/form') {
    return (
      <div className="rounded-lg border border-primary/35 bg-primary-light/30 p-3" data-testid="butler-mcp-unsupported-input">
        <p className="text-xs leading-5 text-ink">{mcpParams.message}</p>
        <p className="mt-1 text-[11px] leading-4 text-ink-3">这个表单不是标准 MCP 字段，RocketX 不会猜测或代填。</p>
        {error ? <div className="mt-2 text-xs text-danger" role="alert">{error}</div> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={submitting} onClick={() => void submit({ action: 'decline', content: null, _meta: null })} className="inline-flex h-8 items-center rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-45">不提供</button>
          <button type="button" disabled={submitting} onClick={() => void submit({ action: 'cancel', content: null, _meta: null })} className="inline-flex h-8 items-center rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-45">取消请求</button>
        </div>
      </div>
    );
  }

  const schema = mcpParams.requestedSchema;
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).filter((entry): entry is [string, McpElicitationPrimitiveSchema] => Boolean(entry[1]));
  const complete = fields.every(([name, field]) => {
    if (!required.has(name)) return true;
    const value = formValues[name];
    if (field.type === 'boolean') return typeof value === 'boolean';
    if (field.type === 'array') return Array.isArray(value) && value.length > 0;
    return value !== undefined && value !== '';
  });
  const setValue = (name: string, value: JsonValue | undefined): void => {
    setFormValues((current) => {
      if (value !== undefined) return { ...current, [name]: value };
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-primary/35 bg-primary-light/30 p-3" data-testid="butler-mcp-form-input">
      <p className="text-xs leading-5 text-ink">{mcpParams.message}</p>
      <div className="mt-3 space-y-4">
        {fields.map(([name, field]) => {
          const options = optionValues(field);
          const textField = field as McpElicitationStringSchema;
          return (
            <label key={name} className="block text-xs text-ink-2">
              <FieldLabel name={name} schema={field} required={required.has(name)} />
              {field.type === 'boolean' ? (
                <span className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={formValues[name] === true} onChange={(event) => setValue(name, event.target.checked)} className="accent-primary" />
                  <span>是</span>
                </span>
              ) : field.type === 'array' ? (
                <span className="mt-2 block space-y-1.5">
                  {options.map((option) => {
                    const selected = Array.isArray(formValues[name]) ? formValues[name] as JsonValue[] : [];
                    return (
                      <span key={option.value} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected.includes(option.value)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...selected, option.value]
                              : selected.filter((value) => value !== option.value);
                            setValue(name, next);
                          }}
                          className="accent-primary"
                        />
                        <span>{option.label}</span>
                      </span>
                    );
                  })}
                </span>
              ) : options.length > 0 ? (
                <select value={typeof formValues[name] === 'string' ? formValues[name] : ''} onChange={(event) => setValue(name, event.target.value || undefined)} className={fieldClass}>
                  <option value="">请选择</option>
                  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.type === 'number' || field.type === 'integer' ? (
                <input
                  type="number"
                  step={field.type === 'integer' ? 1 : 'any'}
                  min={field.minimum}
                  max={field.maximum}
                  value={typeof formValues[name] === 'number' ? formValues[name] : ''}
                  onChange={(event) => setValue(name, event.target.value ? Number(event.target.value) : undefined)}
                  className={fieldClass}
                />
              ) : (
                <input
                  type={textField.format === 'email' ? 'email' : textField.format === 'date' ? 'date' : textField.format === 'date-time' ? 'datetime-local' : textField.format === 'uri' ? 'url' : 'text'}
                  minLength={textField.minLength}
                  maxLength={textField.maxLength}
                  value={typeof formValues[name] === 'string' ? formValues[name] : ''}
                  onChange={(event) => setValue(name, event.target.value || undefined)}
                  className={fieldClass}
                />
              )}
              {field.type === 'array' && (field.minItems !== undefined || field.maxItems !== undefined) ? (
                <span className="mt-1 block text-[11px] text-ink-3">
                  选择 {numberLimit(field.minItems) ?? 0}–{numberLimit(field.maxItems) ?? '不限'} 项
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {error ? <div className="mt-2 text-xs text-danger" role="alert">{error}</div> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!complete || submitting} onClick={() => void submit({ action: 'accept', content: formValues, _meta: null })} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"><Send size={12} />提交并继续</button>
        <button type="button" disabled={submitting} onClick={() => void submit({ action: 'decline', content: null, _meta: null })} className="inline-flex h-8 items-center rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-45">不提供</button>
      </div>
    </div>
  );
}
