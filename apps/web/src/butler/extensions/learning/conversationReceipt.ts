import type { ButlerTaskState } from '../../../lib/butlerTaskContext';
import type { ButlerOperationInput } from './operationJournalExtension';

const CURRENT_METHOD_PATTERN = /(?:这套|这个|刚才|上述|做法|方法|流程|方式|步骤|工作流)/u;
const NEGATED_REQUEST_PATTERN = /(?:不要|别|无需|不必|不想|不需要|不用|禁止|拒绝|避免)/u;
const SKILL_TARGET_PATTERN = /(?:保存为|保存成|存成|做成|变成|沉淀成|提取成|生成)\s*(?:(?:一个|一项|新的?|可复用的|自己的?|私人|自定义)\s*)*[「“"']?(?:(?:skill)(?![.\w-])|技能(?![.\w-]|中心|文档|文件|说明|列表|配置))[」”"']?/iu;
const CLAUSE_SEPARATOR_PATTERN = /(?:[，,。!！？?；;\n]+|\.(?=\s|$)|但是|不过|然而|而是|但|却)/u;
const CANCEL_REQUEST_PATTERN = /^(?:(?:还是|那就|先)\s*)?(?:算|取消(?:这个|该)?(?:操作|请求)?|(?:先)?(?:不要|别|不用|不必|不需要)|(?:先)?不(?:保存|做|生成))(?:了|吧)?$/u;

export function isButlerSkillDraftRequest(value: string): boolean {
  const text = value.trim();
  if (!CURRENT_METHOD_PATTERN.test(text)) return false;
  let requested: boolean | undefined;
  for (const part of text.split(CLAUSE_SEPARATOR_PATTERN)) {
    const clause = part.replace(/(?:别|不要)忘(?:了|记)?/gu, '');
    if (SKILL_TARGET_PATTERN.test(clause)) {
      requested = !NEGATED_REQUEST_PATTERN.test(clause);
    } else if (requested !== undefined && CANCEL_REQUEST_PATTERN.test(clause.trim())) {
      requested = false;
    }
  }
  return requested ?? false;
}

function operationOutcome(
  status: ButlerTaskState['status'] | undefined,
): NonNullable<ButlerOperationInput['outcome']> {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'cancelled';
}

function taskIntentKey(task: ButlerTaskState | null | undefined): string {
  const scenario = task?.manifest.scenario;

  switch (scenario) {
    case 'compare-pull-requests':
      return 'workflow:pr-comparison';
    case 'extract-commitments':
      return 'workflow:commitment-extraction';
    case 'create-weekly-routine':
      return 'workflow:weekly-report';
    case 'resume-task':
      return 'ask:resume-task';
    case 'workflow':
      return 'ask:workflow';
    case 'general':
    case undefined:
      return 'ask:ad-hoc';
    default:
      return `workflow:${scenario}`;
  }
}

export function buildButlerTaskOperation(
  task: ButlerTaskState | null | undefined,
  surface: string,
  at?: number,
): ButlerOperationInput {
  return {
    action: 'ask-butler',
    intentKey: taskIntentKey(task),
    surface,
    outcome: operationOutcome(task?.status),
    ...(at === undefined ? {} : { at }),
  };
}
