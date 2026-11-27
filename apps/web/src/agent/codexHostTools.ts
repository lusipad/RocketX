import { tsMs } from '@rcx/rc-client';
import { t } from '../i18n';
import { collectMentionInbox } from '../lib/mentionInbox';
import { rest } from '../lib/client';
import { useAcpAgents } from '../stores/acpAgents';
import { useAuth } from '../stores/auth';
import { useButlerCognition } from '../stores/butlerCognition';
import { useButlerMemory } from '../stores/butlerMemory';
import { useButlerSkills } from '../stores/butlerSkills';
import { eventsForDate, isEventDone, useCalendar } from '../stores/calendar';
import { permalinkOf, useChat } from '../stores/chat';
import { useTodos } from '../stores/todos';
import { captureWorkLedgerAccount, useWorkLedger } from '../stores/workLedger';
import { observeWorkArtifacts } from './workArtifacts';
import type {
  ButlerMemoryCategory,
  WorkCardStage,
  WorkCardWaitState,
} from '../platform/desktopCommands';
import { stripAgentSessionMarker } from './card';
import {
  generatePersonalAssistantBrief,
  saveAssistantSnapshotDigest,
  type PersonalAssistantBriefKind,
} from './personalAssistant';
import type { DynamicToolCallResponse } from './protocol/generated/v2/DynamicToolCallResponse';
import type { DynamicToolSpec } from './protocol/generated/v2/DynamicToolSpec';
import {
  requireScheduledTaskAdapter,
  type ScheduledTaskInput,
  type ScheduledTaskPatch,
} from './scheduledTaskBridge';
import { evaluateCardCompletionGate } from './workCoordinator';
import { renderDispatchSpec } from './dispatchSpec';
import { buildSpecialistPlan, synthesizeDelegationSummary } from './chiefOfStaff';
import {
  butlerBrowserInspect,
  butlerGithubCreateComment,
  butlerGithubGetIssueDetail,
  butlerGithubGetPrDiff,
  butlerGithubListIssues,
  butlerGithubListPrs,
  butlerPolicyEvaluate,
} from '../platform/desktopCommands';
import { isTauriRuntime } from '../lib/client';
import { verifyWorkCiEvidence } from './workCiEvidence';
import { executePreparedExternalAction, publishWorkReport, syncWorkAdoState } from './externalWorkActions';
import {
  buildWorkflowExecutionReport,
  distillReportToMemory,
  recordReportAsWorkEvidence,
} from './workflowReport';

const LIMIT = 20;
const MAX_CALENDAR_DAYS = 31;

export const ROCKETX_DYNAMIC_TOOLS: DynamicToolSpec[] = [
  {
    type: 'function',
    name: 'list_mentions',
    get description() { return t('agent.hostTools.tool.list_mentions'); },
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', get description() { return t('agent.hostTools.tool.list_mentions.since'); } },
        unprocessedOnly: { type: 'boolean', get description() { return t('agent.hostTools.tool.list_mentions.unprocessedOnly'); } },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_todos',
    get description() { return t('agent.hostTools.tool.list_todos'); },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', get description() { return t('agent.hostTools.tool.list_todos.query'); } },
        includeDone: { type: 'boolean', get description() { return t('agent.hostTools.tool.list_todos.includeDone'); } },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_calendar',
    get description() { return t('agent.hostTools.tool.list_calendar'); },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', get description() { return t('agent.hostTools.tool.list_calendar.query'); } },
        from: { type: 'string', get description() { return t('agent.hostTools.tool.list_calendar.from'); } },
        to: { type: 'string', get description() { return t('agent.hostTools.tool.list_calendar.to'); } },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_scheduled_tasks',
    get description() { return t('agent.hostTools.tool.list_scheduled_tasks'); },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_scheduled_task',
    get description() { return t('agent.hostTools.tool.create_scheduled_task'); },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['cron', 'heartbeat'], get description() { return t('agent.hostTools.tool.create_scheduled_task.kind'); } },
        name: { type: 'string' },
        prompt: { type: 'string' },
        rrule: { type: 'string', get description() { return t('agent.hostTools.tool.create_scheduled_task.rrule'); } },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        workspaceRoot: { type: 'string', get description() { return t('agent.hostTools.tool.create_scheduled_task.workspaceRoot'); } },
        targetThreadId: { type: 'string', get description() { return t('agent.hostTools.tool.create_scheduled_task.targetThreadId'); } },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        notificationPolicy: { type: 'string', enum: ['all_runs', 'important_updates', 'failed_runs_only', 'silent', 'digest_only'] },
        skillName: { type: 'string', get description() { return t('agent.hostTools.tool.create_scheduled_task.skillName'); } },
        pluginTemplateId: { type: 'string' },
      },
      required: ['name', 'prompt', 'rrule'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_scheduled_task',
    get description() { return t('agent.hostTools.tool.update_scheduled_task'); },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['cron', 'heartbeat'] },
        name: { type: 'string' },
        prompt: { type: 'string' },
        rrule: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
        workspaceRoot: { type: 'string' },
        targetThreadId: { type: 'string' },
        model: { type: 'string' },
        reasoningEffort: { type: 'string' },
        notificationPolicy: { type: 'string', enum: ['all_runs', 'important_updates', 'failed_runs_only', 'silent', 'digest_only'] },
        skillName: { type: 'string' },
        pluginTemplateId: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_scheduled_task',
    get description() { return t('agent.hostTools.tool.delete_scheduled_task'); },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_scheduled_task',
    get description() { return t('agent.hostTools.tool.run_scheduled_task'); },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_work_card',
    get description() { return t('agent.hostTools.tool.create_work_card'); },
    inputSchema: {
      type: 'object', properties: {
        requestId: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
        boundaries: { type: 'array', items: { type: 'string' } },
        projectKey: { type: 'string' }, workspaceRoot: { type: 'string' },
        rid: { type: 'string' }, mid: { type: 'string' }, adoWorkItemId: { type: 'integer', minimum: 1 }, adoProject: { type: 'string' },
      }, required: ['requestId', 'title', 'goal', 'acceptance'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_work_cards',
    get description() { return t('agent.hostTools.tool.list_work_cards'); },
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: ['triage', 'ready', 'in_progress', 'verifying', 'done'] },
        includeDone: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_work_card',
    get description() { return t('agent.hostTools.tool.update_work_card'); },
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        stage: { type: 'string', enum: ['triage', 'ready', 'in_progress', 'verifying', 'done'] },
        waitState: { type: 'string', enum: ['none', 'waiting_input', 'waiting_approval', 'waiting_external', 'blocked', 'paused', 'canceled'] },
        waitReason: { type: 'string' },
        nextStep: { type: 'string' },
        goal: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' } },
        boundaries: { type: 'array', items: { type: 'string' } },
        rework: { type: 'boolean', get description() { return t('agent.hostTools.tool.update_work_card.rework'); } },
        expectedRequirementsVersion: { type: 'integer', minimum: 0, get description() { return t('agent.hostTools.tool.update_work_card.expectedRequirementsVersion'); } },
        expectedContentVersion: { type: 'integer', minimum: 0, get description() { return t('agent.hostTools.tool.update_work_card.expectedContentVersion'); } },
      },
      required: ['todoId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'record_work_evidence',
    get description() { return t('agent.hostTools.tool.record_work_evidence'); },
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        kind: { type: 'string', enum: ['test_run', 'ci_build', 'pr_status', 'diff_check', 'agent_report'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        headSha: { type: 'string' },
        passed: { type: 'boolean' },
        criterionIds: { type: 'array', items: { type: 'string' }, get description() { return t('agent.hostTools.tool.record_work_evidence.criterionIds'); } },
        requirementsVersion: { type: 'integer', minimum: 0, get description() { return t('agent.hostTools.tool.record_work_evidence.requirementsVersion'); } },
        contentVersion: { type: 'integer', minimum: 0, get description() { return t('agent.hostTools.tool.record_work_evidence.contentVersion'); } },
      },
      required: ['todoId', 'kind', 'title', 'passed'],
      additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'verify_work_ci_evidence',
    get description() { return t('agent.hostTools.tool.verify_work_ci_evidence'); },
    inputSchema: { type: 'object', properties: {
      todoId: { type: 'string' }, project: { type: 'string' }, buildId: { type: 'integer', minimum: 1 },
      requirementsVersion: { type: 'integer', minimum: 0 }, contentVersion: { type: 'integer', minimum: 0 },
      criterionIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    }, required: ['todoId', 'project', 'buildId', 'requirementsVersion', 'contentVersion', 'criterionIds'], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'memory_search',
    get description() { return t('agent.hostTools.tool.memory_search'); },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', get description() { return t('agent.hostTools.tool.memory_search.query'); } },
        category: {
          type: 'string',
          enum: ['preference', 'project_fact', 'workflow_habit', 'person_context', 'episodic_summary'],
        },
        workspaceRoot: { type: 'string', get description() { return t('agent.hostTools.tool.memory_search.workspaceRoot'); } },
        limit: { type: 'number', get description() { return t('agent.hostTools.tool.memory_search.limit'); } },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'memory_save',
    get description() { return t('agent.hostTools.tool.memory_save'); },
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['preference', 'project_fact', 'workflow_habit', 'person_context', 'episodic_summary'],
        },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        workspaceRoot: { type: 'string' },
        pinned: { type: 'boolean' },
      },
      required: ['category', 'title', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'memory_delete',
    get description() { return t('agent.hostTools.tool.memory_delete'); },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'assistant_daily_brief',
    get description() { return t('agent.hostTools.tool.assistant_daily_brief'); },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['morning_brief', 'evening_review', 'focus_digest'] },
        saveDigest: { type: 'boolean', get description() { return t('agent.hostTools.tool.assistant_daily_brief.saveDigest'); } },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_report_generate',
    get description() { return t('agent.hostTools.tool.workflow_report_generate'); },
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        sessionKey: { type: 'string' },
        recordEvidence: { type: 'boolean', get description() { return t('agent.hostTools.tool.workflow_report_generate.recordEvidence'); } },
        distillMemory: { type: 'boolean', get description() { return t('agent.hostTools.tool.workflow_report_generate.distillMemory'); } },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'workflow_report_publish',
    get description() { return t('agent.hostTools.tool.workflow_report_publish'); },
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' }, rid: { type: 'string' },
        operationId: { type: 'string', get description() { return t('agent.hostTools.tool.workflow_report_publish.operationId'); } },
      },
      required: ['todoId', 'rid', 'operationId'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'work_ado_state_sync',
    get description() { return t('agent.hostTools.tool.work_ado_state_sync'); },
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' }, operationId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 }, expectedState: { type: 'string' }, targetState: { type: 'string' },
      },
      required: ['todoId', 'operationId', 'expectedRevision', 'expectedState', 'targetState'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'work_external_action_continue',
    get description() { return t('agent.hostTools.tool.work_external_action_continue'); },
    inputSchema: {
      type: 'object', properties: { actionId: { type: 'string' }, retryReport: { type: 'boolean' } },
      required: ['actionId'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_list_agents',
    get description() { return t('agent.hostTools.tool.acp_list_agents'); },
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_dispatch_task',
    get description() { return t('agent.hostTools.tool.acp_dispatch_task'); },
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        workspaceRoot: { type: 'string' },
        prompt: { type: 'string' },
        todoId: { type: 'string' },
        requestId: { type: 'string', get description() { return t('agent.hostTools.tool.acp_dispatch_task.requestId'); } },
        isolateWorktree: { type: 'boolean' },
        autonomyMode: { type: 'string', enum: ['readonly', 'confirm', 'autonomous'] },
        title: { type: 'string' },
      },
      required: ['prompt', 'todoId', 'requestId'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_session_status',
    get description() { return t('agent.hostTools.tool.acp_session_status'); },
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delegate_specialists',
    get description() { return t('agent.hostTools.tool.delegate_specialists'); },
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string' },
        requestId: { type: 'string' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['researcher', 'coder', 'reviewer', 'ops'] },
              title: { type: 'string' },
              prompt: { type: 'string' },
              agentId: { type: 'string' },
              autonomyMode: { type: 'string', enum: ['readonly', 'confirm', 'autonomous'] },
              isolateWorktree: { type: 'boolean' },
              workspaceRoot: { type: 'string' },
            },
            required: ['role', 'title', 'prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['todoId', 'requestId', 'tasks'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_list_prs',
    get description() { return t('agent.hostTools.tool.github_list_prs'); },
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_list_issues',
    get description() { return t('agent.hostTools.tool.github_list_issues'); },
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_get_pr_diff',
    get description() { return t('agent.hostTools.tool.github_get_pr_diff'); },
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'integer', minimum: 1 },
      },
      required: ['owner', 'repo', 'number'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_get_issue',
    get description() { return t('agent.hostTools.tool.github_get_issue'); },
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'integer', minimum: 1 },
        commentLimit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['owner', 'repo', 'number'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'github_create_comment',
    get description() { return t('agent.hostTools.tool.github_create_comment'); },
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'integer', minimum: 1 },
        body: { type: 'string' },
        workspaceRoot: { type: 'string' },
      },
      required: ['owner', 'repo', 'number', 'body'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'browser_inspect_url',
    get description() { return t('agent.hostTools.tool.browser_inspect_url'); },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'integer', minimum: 200, maximum: 32000 },
        allowInsecureLan: { type: 'boolean' },
        workspaceRoot: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'project_policy_check',
    get description() { return t('agent.hostTools.tool.project_policy_check'); },
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        actionKind: { type: 'string', enum: ['command', 'file_read', 'file_write', 'network', 'external'] },
        target: { type: 'string' },
      },
      required: ['actionKind', 'target'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'read_activity_stream',
    get description() { return t('agent.hostTools.tool.read_activity_stream'); },
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        source: { type: 'string', enum: ['chat', 'acp', 'work_ledger', 'watchpoint', 'user', 'system'] },
        unconsumedOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 60 },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'read_room_messages',
    get description() { return t('agent.hostTools.tool.read_room_messages'); },
    inputSchema: {
      type: 'object',
      properties: {
        rid: { type: 'string' },
        since: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 40 },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_inspect_session',
    get description() { return t('agent.hostTools.tool.acp_inspect_session'); },
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: { type: 'string' },
        todoId: { type: 'string' },
        messageLimit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'acp_steer_session',
    get description() { return t('agent.hostTools.tool.acp_steer_session'); },
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: { type: 'string' },
        action: { type: 'string', enum: ['followup', 'resolve_permission', 'cancel'] },
        prompt: { type: 'string' },
        requestId: { type: 'string' },
        optionId: { type: 'string' },
      },
      required: ['sessionKey', 'action'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'watchpoint_manage',
    get description() { return t('agent.hostTools.tool.watchpoint_manage'); },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['set', 'list', 'cancel'] },
        id: { type: 'string' },
        reason: { type: 'string' },
        kind: { type: 'string', enum: ['after_minutes', 'acp_session_settle', 'room_activity', 'work_card_change'] },
        afterMinutes: { type: 'number', minimum: 1, maximum: 10080 },
        ttlMinutes: { type: 'number', minimum: 5, maximum: 10080 },
        sessionKey: { type: 'string' },
        rid: { type: 'string' },
        contains: { type: 'string' },
        todoId: { type: 'string' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'surface_proactive_insight',
    get description() { return t('agent.hostTools.tool.surface_proactive_insight'); },
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['silent_log', 'inbox', 'interrupt'] },
        kind: { type: 'string', enum: ['decision', 'progress', 'risk', 'draft'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        rid: { type: 'string' },
        todoId: { type: 'string' },
        sessionKey: { type: 'string' },
        actionId: { type: 'string' },
        suggestedActions: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              prompt: { type: 'string' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      required: ['level', 'title', 'summary'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'skill_evolve',
    get description() { return t('agent.hostTools.tool.skill_evolve'); },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read', 'upsert'] },
        id: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        instructionsMd: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' } },
        allowedTools: { type: 'array', items: { type: 'string' } },
        workspaceRoot: { type: 'string' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
];

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] as boolean : undefined;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(t('agent.hostTools.cannotBeEmpty', { key }));
  return value;
}

function scheduledTaskEnum(
  key: 'kind' | 'status' | 'notificationPolicy',
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const allowed = key === 'kind'
    ? ['cron', 'heartbeat']
    : key === 'status'
      ? ['ACTIVE', 'PAUSED']
      : ['all_runs', 'important_updates', 'failed_runs_only'];
  if (!allowed.includes(value)) throw new Error(t('agent.hostTools.invalidValue', { key }));
  return value;
}

function scheduledTaskInput(args: Record<string, unknown>): ScheduledTaskInput {
  const kind = scheduledTaskEnum('kind', optionalString(args, 'kind')) as ScheduledTaskInput['kind'];
  const status = scheduledTaskEnum('status', optionalString(args, 'status')) as ScheduledTaskInput['status'];
  const notificationPolicy = scheduledTaskEnum(
    'notificationPolicy',
    optionalString(args, 'notificationPolicy'),
  ) as ScheduledTaskInput['notificationPolicy'];
  return {
    name: requiredString(args, 'name'),
    prompt: requiredString(args, 'prompt'),
    rrule: requiredString(args, 'rrule'),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(optionalString(args, 'workspaceRoot') ? { workspaceRoot: optionalString(args, 'workspaceRoot') } : {}),
    ...(optionalString(args, 'targetThreadId') ? { targetThreadId: optionalString(args, 'targetThreadId') } : {}),
    ...(optionalString(args, 'model') ? { model: optionalString(args, 'model') } : {}),
    ...(optionalString(args, 'reasoningEffort') ? { reasoningEffort: optionalString(args, 'reasoningEffort') } : {}),
    ...(notificationPolicy ? { notificationPolicy } : {}),
    ...(optionalString(args, 'skillName') ? { skillName: optionalString(args, 'skillName') } : {}),
    ...(optionalString(args, 'pluginTemplateId') ? { pluginTemplateId: optionalString(args, 'pluginTemplateId') } : {}),
  };
}

function scheduledTaskPatch(args: Record<string, unknown>): ScheduledTaskPatch {
  const input = { ...args };
  delete input.id;
  const patch: ScheduledTaskPatch = { id: requiredString(args, 'id') };
  for (const key of [
    'kind',
    'name',
    'prompt',
    'rrule',
    'status',
    'workspaceRoot',
    'targetThreadId',
    'model',
    'reasoningEffort',
    'notificationPolicy',
    'skillName',
    'pluginTemplateId',
  ] as const) {
    const value = optionalString(input, key);
    if (!value) continue;
    const validated = key === 'kind' || key === 'status' || key === 'notificationPolicy'
      ? scheduledTaskEnum(key, value)
      : value;
    (patch as unknown as Record<string, unknown>)[key] = validated;
  }
  return patch;
}

function response(value: unknown, success = true): DynamicToolCallResponse {
  return {
    contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
    success,
  };
}

function matches(value: string, query?: string): boolean {
  return !query || value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function dateRange(from?: string, to?: string): string[] | undefined {
  if (!from && !to) return undefined;
  const start = from ?? to!;
  const end = to ?? from!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(t('agent.hostTools.dateRangeFormat'));
  }
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime()) || cursor > last) {
    throw new Error(t('agent.hostTools.dateRangeInvalid'));
  }
  const dates: string[] = [];
  while (cursor <= last && dates.length <= MAX_CALENDAR_DAYS) {
    dates.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
        cursor.getDate(),
      ).padStart(2, '0')}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  if (dates.length > MAX_CALENDAR_DAYS) throw new Error(t('agent.hostTools.dateRangeLimit'));
  return dates;
}

async function listMentions(args: Record<string, unknown>): Promise<unknown> {
  const user = useAuth.getState().user;
  if (!user?.username) throw new Error(t('agent.hostTools.notLoggedIn'));
  const since = optionalString(args, 'since');
  const sinceAt = since ? Date.parse(since) : undefined;
  if (sinceAt !== undefined && !Number.isFinite(sinceAt)) throw new Error(t('agent.hostTools.sinceInvalid'));
  const unprocessedOnly = optionalBoolean(args, 'unprocessedOnly') ?? false;
  const subscriptions = Object.values(useChat.getState().subscriptions);
  const candidates = subscriptions.filter((subscription) => (subscription.userMentions ?? 0) > 0);
  const lastSeen = new Map(candidates.map((subscription) => [subscription.rid, tsMs(subscription.ls)]));
  const result = await collectMentionInbox(
    candidates.map((subscription) => ({
      rid: subscription.rid,
      name: subscription.fname || subscription.name || subscription.rid,
      userMentions: subscription.userMentions ?? 0,
    })),
    { _id: user._id, username: user.username },
    (rid, offset, count) => rest.getMentionedMessagesPage(rid, offset, count),
  );
  const matching = result.items
    .filter(({ message }) => sinceAt === undefined || tsMs(message.ts) > sinceAt)
    .filter(({ message }) => !unprocessedOnly || tsMs(message.ts) > (lastSeen.get(message.rid) ?? 0));
  const items = matching.slice(0, LIMIT).map(({ message, roomName }) => ({
    id: message._id,
    rid: message.rid,
    roomName,
    sender: message.u.name || message.u.username,
    ts: new Date(tsMs(message.ts)).toISOString(),
    text: stripAgentSessionMarker(message.msg).slice(0, 240),
    link: permalinkOf(message.rid, message._id),
  }));
  return {
    items,
    coverage: {
      complete: result.warnings.length === 0 && matching.length <= LIMIT,
      truncated: matching.length > LIMIT,
      returned: items.length,
      limit: LIMIT,
      roomsChecked: candidates.length,
      ...(since ? { since } : {}),
    },
    warnings: result.warnings,
  };
}

function listTodos(args: Record<string, unknown>): unknown {
  const query = optionalString(args, 'query');
  const includeDone = optionalBoolean(args, 'includeDone') ?? false;
  const matching = useTodos.getState().todos
    .filter((todo) => includeDone || !todo.done)
    .filter((todo) => matches(
      `${todo.note ?? ''} ${todo.excerpt ?? ''} ${todo.title ?? ''} ${todo.roomName ?? ''} ${todo.author ?? ''}`,
      query,
    ))
    .sort((left, right) => (left.due ?? '9999-12-31').localeCompare(right.due ?? '9999-12-31'));
  const items = matching.slice(0, LIMIT)
    .map((todo) => ({
      id: todo.id,
      text: todo.note || todo.excerpt || todo.title || t('agent.hostTools.todoFallback'),
      due: todo.due,
      priority: todo.priority,
      roomName: todo.roomName,
      author: todo.author,
      waitingFor: todo.waitingFor,
      committedTo: todo.committedTo,
      done: todo.done,
      link: todo.rid && todo.mid ? permalinkOf(todo.rid, todo.mid) : undefined,
    }));
  return {
    items,
    coverage: {
      complete: matching.length <= LIMIT,
      truncated: matching.length > LIMIT,
      returned: items.length,
      limit: LIMIT,
    },
  };
}

function listCalendar(args: Record<string, unknown>): unknown {
  const query = optionalString(args, 'query');
  const dates = dateRange(optionalString(args, 'from'), optionalString(args, 'to'));
  const events = useCalendar.getState().events;
  const occurrences = dates
    ? dates.flatMap((date) => eventsForDate(events, date).map((event) => ({ event, date })))
    : events.map((event) => ({ event, date: event.date }));
  const matching = occurrences
    .filter(({ event, date }) => matches(`${event.title} ${event.description ?? ''} ${date}`, query))
    .sort((left, right) => `${left.date} ${left.event.startTime ?? ''}`.localeCompare(
      `${right.date} ${right.event.startTime ?? ''}`,
    ));
  const items = matching.slice(0, LIMIT)
    .map(({ event, date }) => ({
      id: event.id,
      title: event.title,
      date,
      startTime: event.startTime,
      endTime: event.endTime,
      allDay: event.allDay,
      done: isEventDone(event, date),
      description: event.description?.slice(0, 240),
      origin: event.origin,
    }));
  return {
    items,
    coverage: {
      complete: matching.length <= LIMIT,
      truncated: matching.length > LIMIT,
      returned: items.length,
      limit: LIMIT,
    },
  };
}

export async function executeRocketxDynamicTool(params: unknown): Promise<DynamicToolCallResponse> {
  const request = record(params);
  const tool = typeof request.tool === 'string' ? request.tool : '';
  const args = record(request.arguments);
  try {
    if (tool === 'list_mentions') return response(await listMentions(args));
    if (tool === 'list_todos') return response(listTodos(args));
    if (tool === 'list_calendar') return response(listCalendar(args));
    if (tool === 'list_scheduled_tasks') return response(await requireScheduledTaskAdapter().list());
    if (tool === 'create_scheduled_task') {
      return response(await requireScheduledTaskAdapter().create(scheduledTaskInput(args)));
    }
    if (tool === 'update_scheduled_task') {
      return response(await requireScheduledTaskAdapter().update(scheduledTaskPatch(args)));
    }
    if (tool === 'delete_scheduled_task') {
      return response(await requireScheduledTaskAdapter().remove(requiredString(args, 'id')));
    }
    if (tool === 'run_scheduled_task') {
      return response(await requireScheduledTaskAdapter().run(requiredString(args, 'id')));
    }
    if (tool === 'list_work_cards') {
      const ledger = useWorkLedger.getState();
      ledger.syncWithTodos();
      const stageFilter = optionalString(args, 'stage');
      const includeDone = optionalBoolean(args, 'includeDone') ?? false;
      const cards = useWorkLedger.getState().cards
        .filter((c) => (stageFilter ? c.state.stage === stageFilter : includeDone || c.state.stage !== 'done'))
        .slice(0, LIMIT)
        .map((c) => ({
          todoId: c.id,
          title: c.title,
          goal: c.state.goal,
          stage: c.state.stage,
          waitState: c.state.waitState,
          waitReason: c.state.waitReason,
          nextStep: c.state.nextStep,
          autonomyMode: c.state.autonomyMode,
          requirementsVersion: c.state.requirementsVersion ?? 0,
          contentVersion: c.state.contentVersion ?? 0,
          acceptance: c.state.acceptance,
          visibility: c.state.visibility,
          adoWorkItemId: c.adoWorkItemId,
          sessions: ledger.sessions
            .filter((s) => s.todoId === c.id)
            .map((s) => ({ id: s.id, runtime: s.runtime, controlMode: s.controlMode, workspaceRoot: s.workspaceRoot })),
          validEvidences: ledger.evidences.filter((e) => e.todoId === c.id && e.passed && !e.stale).length,
          completionGate: evaluateCardCompletionGate(c, ledger.evidences),
        }));
      return response({ items: cards, returned: cards.length });
    }
    if (tool === 'create_work_card') {
      const assertAccount = captureWorkLedgerAccount();
      const acceptance = Array.isArray(args.acceptance) ? args.acceptance.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim()) : [];
      if (!acceptance.length) throw new Error(t('agent.hostTools.acceptanceRequired'));
      const adoWorkItemId = typeof args.adoWorkItemId === 'number' && Number.isInteger(args.adoWorkItemId) && args.adoWorkItemId > 0 ? args.adoWorkItemId : undefined;
      const rid = optionalString(args, 'rid'); const mid = optionalString(args, 'mid');
      const card = await useWorkLedger.getState().createCard({ requestId: requiredString(args, 'requestId'), title: requiredString(args, 'title'), goal: requiredString(args, 'goal'), acceptance,
        boundaries: Array.isArray(args.boundaries) ? args.boundaries.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [],
        ownerKind: 'ai_suggested', enroll: true, source: adoWorkItemId ? 'ado' : mid ? 'message' : 'manual', rid, mid, adoWorkItemId,
        adoProject: optionalString(args, 'adoProject'), projectKey: optionalString(args, 'projectKey') ?? optionalString(args, 'adoProject') ?? null,
      });
      const ledger = useWorkLedger.getState();
      assertAccount();
      const workspaceRoot = optionalString(args, 'workspaceRoot');
      if (workspaceRoot && !ledger.links.some((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.externalId === card.id)) await ledger.upsertLink({ todoId: card.id, kind: 'kanban_card', externalId: card.id, project: card.state.projectKey, repo: workspaceRoot, rid: card.rid, headSha: null, title: t('agent.hostTools.workspaceLinkTitle'), webUrl: null, stateSnapshot: 'workspace' });
      assertAccount();
      if (card.adoWorkItemId) await ledger.upsertLink({ todoId: card.id, kind: 'ado_work_item', externalId: String(card.adoWorkItemId), project: card.adoProject, repo: null, rid: card.rid, headSha: null, title: card.title, webUrl: null, stateSnapshot: null });
      assertAccount();
      if (card.rid && card.mid) await ledger.upsertLink({ todoId: card.id, kind: 'message', externalId: card.mid, project: card.state.projectKey, repo: null, rid: card.rid, headSha: null, title: t('agent.hostTools.sourceMessageTitle'), webUrl: null, stateSnapshot: null });
      assertAccount();
      return response({ card, completionGate: evaluateCardCompletionGate(card, ledger.evidences) });
    }
    if (tool === 'update_work_card') {
      const todoId = requiredString(args, 'todoId');
      const card = useWorkLedger.getState().cards.find((item) => item.id === todoId);
      if (!card) throw new Error(t('agent.hostTools.workMissing'));
      if (optionalString(args, 'stage') === 'done') await observeWorkArtifacts(todoId);
      const scopeChange = Object.hasOwn(args, 'goal') || Object.hasOwn(args, 'acceptance') || Object.hasOwn(args, 'boundaries') || optionalBoolean(args, 'rework') === true;
      if (scopeChange && (typeof args.expectedRequirementsVersion !== 'number' || !Number.isInteger(args.expectedRequirementsVersion) || args.expectedRequirementsVersion < 0)) throw new Error(t('agent.hostTools.reqVersionRequired'));
      const updated = await useWorkLedger.getState().updateCard(todoId, {
        expectedRequirementsVersion: typeof args.expectedRequirementsVersion === 'number' ? args.expectedRequirementsVersion : card.state.requirementsVersion ?? 0,
        expectedContentVersion: typeof args.expectedContentVersion === 'number' ? args.expectedContentVersion : card.state.contentVersion ?? 0,
        ...(optionalString(args, 'stage') ? { stage: optionalString(args, 'stage') as WorkCardStage } : {}),
        ...(optionalString(args, 'waitState') ? { waitState: optionalString(args, 'waitState') as WorkCardWaitState } : {}),
        ...(optionalString(args, 'waitReason') ? { waitReason: optionalString(args, 'waitReason')! } : {}),
        ...(optionalString(args, 'nextStep') ? { nextStep: optionalString(args, 'nextStep')! } : {}),
        ...(optionalString(args, 'goal') ? { goal: optionalString(args, 'goal')! } : {}),
        ...(Array.isArray(args.acceptance) ? { acceptance: args.acceptance.filter((item): item is string => typeof item === 'string' && !!item.trim()) } : {}),
        ...(Array.isArray(args.boundaries) ? { boundaries: args.boundaries.filter((item): item is string => typeof item === 'string' && !!item.trim()) } : {}),
        ...(optionalBoolean(args, 'rework') ? { rework: true } : {}),
      });
      return response({ todoId: updated.id, stage: updated.state.stage, waitState: updated.state.waitState,
        requirementsVersion: updated.state.requirementsVersion ?? 0, contentVersion: updated.state.contentVersion ?? 0,
        completionGate: evaluateCardCompletionGate(updated, useWorkLedger.getState().evidences) });
    }
    if (tool === 'record_work_evidence') {
      const todoId = requiredString(args, 'todoId');
      const claimedKind = requiredString(args, 'kind');
      if (!['test_run', 'ci_build', 'pr_status', 'diff_check', 'agent_report'].includes(claimedKind)) throw new Error(t('agent.hostTools.cannotRecordManualAck'));
      const title = requiredString(args, 'title');
      const claimedPassed = optionalBoolean(args, 'passed') ?? true;
      const ev = await useWorkLedger.getState().addEvidence({
        todoId,
        sessionId: null,
        kind: 'agent_report',
        title,
        summary: t('agent.hostTools.agentReportSummary', { kind: claimedKind, claimed: claimedPassed ? t('agent.hostTools.claimedPassed') : t('agent.hostTools.claimedFailed'), summary: optionalString(args, 'summary') ?? '' }),
        headSha: optionalString(args, 'headSha') ?? null,
        workspaceRoot: null,
        webUrl: null,
        passed: false,
        criterionIds: Array.isArray(args.criterionIds) ? args.criterionIds.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [],
        requirementsVersion: typeof args.requirementsVersion === 'number' && Number.isInteger(args.requirementsVersion) ? args.requirementsVersion : undefined,
        contentVersion: typeof args.contentVersion === 'number' && Number.isInteger(args.contentVersion) ? args.contentVersion : undefined,
      });
      return response({ evidenceId: ev.id, todoId: ev.todoId, kind: ev.kind, passed: ev.passed, stale: ev.stale, claimedKind, claimedPassed, verification: 'agent_statement_unverified' });
    }
    if (tool === 'verify_work_ci_evidence') {
      const buildId = args.buildId;
      const requirementsVersion = args.requirementsVersion;
      const contentVersion = args.contentVersion;
      if (typeof buildId !== 'number' || !Number.isInteger(buildId) || typeof requirementsVersion !== 'number' || !Number.isInteger(requirementsVersion) || typeof contentVersion !== 'number' || !Number.isInteger(contentVersion)) throw new Error(t('agent.hostTools.ciParamsRequired'));
      const evidence = await verifyWorkCiEvidence({ workId: requiredString(args, 'todoId'), project: requiredString(args, 'project'), buildId, requirementsVersion, contentVersion,
        criterionIds: Array.isArray(args.criterionIds) ? args.criterionIds.filter((item): item is string => typeof item === 'string') : [] });
      return response({ evidence, verification: 'ado_build_api', scope: 'ci_status_only' });
    }
    if (tool === 'memory_search') {
      const query = optionalString(args, 'query');
      const category = optionalString(args, 'category') as ButlerMemoryCategory | undefined;
      const workspaceRoot = optionalString(args, 'workspaceRoot');
      const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 6;
      const entries = await useButlerMemory.getState().recallRelevantMemories({
        query,
        category,
        workspaceRoot: workspaceRoot ?? null,
        limit: rawLimit,
      });
      return response({
        paused: useButlerMemory.getState().memoryPaused,
        returned: entries.length,
        items: entries.map((m) => ({
          id: m.id,
          category: m.category,
          title: m.title,
          content: m.content,
          tags: m.tags,
          workspaceRoot: m.workspaceRoot,
          pinned: m.pinned,
          recallCount: m.recallCount,
        })),
      });
    }
    if (tool === 'memory_save') {
      const category = requiredString(args, 'category') as ButlerMemoryCategory;
      const title = requiredString(args, 'title');
      const content = requiredString(args, 'content');
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : [];
      const saved = await useButlerMemory.getState().upsertMemory({
        category,
        title,
        content,
        tags,
        workspaceRoot: optionalString(args, 'workspaceRoot') ?? null,
        pinned: optionalBoolean(args, 'pinned') ?? false,
        sourceKind: 'conversation',
      });
      return response({
        id: saved.id,
        category: saved.category,
        title: saved.title,
        pinned: saved.pinned,
      });
    }
    if (tool === 'memory_delete') {
      const id = requiredString(args, 'id');
      const deleted = await useButlerMemory.getState().deleteMemory(id);
      return response({ id, deleted });
    }
    if (tool === 'assistant_daily_brief') {
      const rawKind = optionalString(args, 'kind') ?? 'focus_digest';
      const kind: PersonalAssistantBriefKind =
        rawKind === 'morning_brief' || rawKind === 'evening_review' || rawKind === 'focus_digest'
          ? rawKind
          : 'focus_digest';
      const snapshot = generatePersonalAssistantBrief(kind);
      const saveDigest = optionalBoolean(args, 'saveDigest') ?? false;
      const saved = saveDigest ? await saveAssistantSnapshotDigest(snapshot) : null;
      return response({
        kind: snapshot.kind,
        dateKey: snapshot.dateKey,
        title: snapshot.title,
        metrics: snapshot.metrics,
        focusItems: snapshot.focusItems,
        commitments: snapshot.commitments,
        actionItems: snapshot.actionItems,
        markdown: snapshot.markdown,
        ...(saved ? { digestId: saved.id } : {}),
      });
    }
    if (tool === 'workflow_report_generate') {
      const todoId = optionalString(args, 'todoId');
      const sessionKey = optionalString(args, 'sessionKey');
      const ledger = useWorkLedger.getState();
      const acpState = useAcpAgents.getState();
      const card = todoId ? ledger.cards.find((c) => c.id === todoId) ?? null : null;
      const acpSession = sessionKey
        ? acpState.sessions[sessionKey] ?? null
        : todoId
          ? Object.values(acpState.sessions).find((s) => s.linkedTodoId === todoId) ?? null
          : null;
      const report = buildWorkflowExecutionReport({
        card,
        acpSession,
        sessions: todoId ? ledger.sessions.filter((s) => s.todoId === todoId) : [],
        evidences: todoId ? ledger.evidences.filter((e) => e.todoId === todoId) : [],
        links: todoId ? ledger.links.filter((l) => l.todoId === todoId) : [],
      });
      if (optionalBoolean(args, 'recordEvidence') && todoId) {
        await recordReportAsWorkEvidence(todoId, report);
      }
      if (optionalBoolean(args, 'distillMemory')) {
        await distillReportToMemory(report);
      }
      return response(report);
    }
    if (tool === 'workflow_report_publish') {
      const todoId = requiredString(args, 'todoId');
      const ledger = useWorkLedger.getState();
      const card = ledger.cards.find((item) => item.id === todoId);
      if (!card) throw new Error(t('agent.hostTools.workMissing'));
      const acpSession = Object.values(useAcpAgents.getState().sessions).find((session) => session.linkedTodoId === todoId) ?? null;
      const report = buildWorkflowExecutionReport({ card, acpSession, sessions: ledger.sessions, evidences: ledger.evidences, links: ledger.links });
      const action = await publishWorkReport({ workId: todoId, rid: requiredString(args, 'rid'), reportId: requiredString(args, 'operationId'), reportTitle: report.title, reportGeneratedAt: report.generatedAt, markdown: report.markdown });
      return response({ action, deliveryConfirmed: action.state === 'acknowledged' || action.state === 'completed' });
    }
    if (tool === 'work_ado_state_sync') {
      const expectedRevision = args.expectedRevision;
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new Error(t('agent.hostTools.expectedRevPositive'));
      const action = await syncWorkAdoState({ workId: requiredString(args, 'todoId'), operationId: requiredString(args, 'operationId'), expectedRevision, expectedState: requiredString(args, 'expectedState'), targetState: requiredString(args, 'targetState') });
      return response({ action, syncConfirmed: action.state === 'acknowledged' || action.state === 'completed' });
    }
    if (tool === 'work_external_action_continue') {
      const action = await executePreparedExternalAction(requiredString(args, 'actionId'), false, optionalBoolean(args, 'retryReport'));
      return response({ action, deliveryConfirmed: action.state === 'acknowledged' || action.state === 'completed' });
    }
    if (tool === 'acp_list_agents') {
      const includeDisabled = optionalBoolean(args, 'includeDisabled') ?? true;
      const acpState = useAcpAgents.getState();
      const agents = acpState.agents.filter((a) => includeDisabled || a.enabled);
      return response({
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          preset: a.preset,
          command: a.command,
          args: a.args,
          enabled: a.enabled,
          autoApproveSafeReads: a.autoApproveSafeReads,
        })),
        discovered: acpState.discovered,
        activeSessions: Object.keys(acpState.sessions).length,
      });
    }
    if (tool === 'acp_dispatch_task') {
      const prompt = requiredString(args, 'prompt');
      const todoId = requiredString(args, 'todoId');
      const requestId = requiredString(args, 'requestId');
      const agentId = optionalString(args, 'agentId');
      const customTitle = optionalString(args, 'title');
      const requestedAutonomy = optionalString(args, 'autonomyMode');
      const ledger = useWorkLedger.getState();
      const card = ledger.cards.find((item) => item.id === todoId);
      if (!card) throw new Error(t('agent.hostTools.mustCreateCardFirst'));
      if (!card.state.goal?.trim() || !card.state.acceptance.length) throw new Error(t('agent.hostTools.goalAndAcceptanceFirst'));
      const autonomyRank = { readonly: 0, confirm: 1, autonomous: 2 } as const;
      const cardAutonomy = card.state.autonomyMode;
      const validRequested = requestedAutonomy && requestedAutonomy in autonomyRank
        ? requestedAutonomy as keyof typeof autonomyRank
        : null;
      const effectiveAutonomy = validRequested && autonomyRank[validRequested] < autonomyRank[cardAutonomy]
        ? validRequested
        : cardAutonomy;
      const workspaceRoot = optionalString(args, 'workspaceRoot') ??
        ledger.links.find((link) => link.todoId === todoId && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ??
        ledger.sessions.find((session) => session.todoId === todoId)?.workspaceRoot ?? '';
      const acp = useAcpAgents.getState();
      const targetAgent =
        (agentId ? acp.agents.find((a) => a.id === agentId) : undefined) ??
        acp.agents.find((a) => a.enabled);
      if (!targetAgent) {
        throw new Error(t('agent.hostTools.noAcpClient'));
      }
      if (!workspaceRoot) {
        throw new Error(t('agent.hostTools.workspaceRootRequired'));
      }
      const dispatchTitle = customTitle || card.title;
      const specText = renderDispatchSpec({ title: dispatchTitle, goal: t('agent.hostTools.dispatchGoal', { goal: card.state.goal, prompt }),
        acceptance: card.state.acceptance, boundaries: card.state.boundaries, evidence: card.note ? [{ label: t('agent.hostTools.cardNotes'), text: card.note }] : [] });
      const action = await ledger.prepareDispatchAction({
        idempotencyKey: JSON.stringify(['acp-dispatch', todoId, requestId]), todoId, actionKind: 'session_create',
        specJson: JSON.stringify({ specText, runtime: 'acp', acpAgentId: targetAgent.id, repoRootOverride: workspaceRoot,
          ...(customTitle ? { title: customTitle } : {}),
          autonomyMode: effectiveAutonomy,
          isolateWorktree: optionalBoolean(args, 'isolateWorktree') ?? false,
          requirementsVersion: card.state.requirementsVersion ?? 0, contentVersion: card.state.contentVersion ?? 0 }),
        requireConfirmation: effectiveAutonomy !== 'autonomous',
      });
      return response({ accepted: true, todoId, actionId: action.id, state: action.state, agentId: targetAgent.id,
        title: dispatchTitle, autonomyMode: effectiveAutonomy,
        workspaceRoot, message: action.state === 'awaiting_approval' ? t('agent.hostTools.dispatchAwaitingApproval') : t('agent.hostTools.dispatchQueued') });
    }
    if (tool === 'acp_session_status') {
      const sessionKey = optionalString(args, 'sessionKey');
      const sessions = useAcpAgents.getState().sessions;
      if (sessionKey) {
        const s = sessions[sessionKey];
        if (!s) throw new Error(t('agent.hostTools.acpSessionMissing', { sessionKey }));
        return response({
          sessionKey: s.sessionKey,
          acpSessionId: s.acpSessionId,
          agentName: s.agentName,
          status: s.status,
          mode: s.modes?.currentModeId ?? null,
          plan: s.plan,
          pendingPermissions: s.pendingPermissions.length,
          toolCalls: s.toolCalls.length,
          lastMessage: s.messages.at(-1)?.text ?? '',
        });
      }
      return response({
        sessions: Object.values(sessions).map((s) => ({
          sessionKey: s.sessionKey,
          acpSessionId: s.acpSessionId,
          agentName: s.agentName,
          title: s.title,
          status: s.status,
          workspaceRoot: s.workspaceRoot,
          linkedTodoId: s.linkedTodoId,
          pendingPermissions: s.pendingPermissions.length,
        })),
      });
    }
    if (tool === 'delegate_specialists') {
      const todoId = requiredString(args, 'todoId');
      const requestId = requiredString(args, 'requestId');
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const ledger = useWorkLedger.getState();
      const card = ledger.cards.find((item) => item.id === todoId);
      if (!card) throw new Error(t('agent.hostTools.mustCreateCardFirst'));
      if (!card.state.goal?.trim() || !card.state.acceptance.length) {
        throw new Error(t('agent.hostTools.goalAndAcceptanceFirst'));
      }
      const defaultWorkspaceRoot =
        ledger.links.find((link) => link.todoId === todoId && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ??
        ledger.sessions.find((session) => session.todoId === todoId)?.workspaceRoot ??
        '';
      const acp = useAcpAgents.getState();
      const planned = buildSpecialistPlan({
        tasks: rawTasks.map((entry) => {
          const item = record(entry);
          return {
            role: typeof item.role === 'string' ? item.role : '',
            title: typeof item.title === 'string' ? item.title : '',
            prompt: typeof item.prompt === 'string' ? item.prompt : '',
            agentId: optionalString(item, 'agentId'),
            autonomyMode: optionalString(item, 'autonomyMode'),
            isolateWorktree: optionalBoolean(item, 'isolateWorktree'),
            workspaceRoot: optionalString(item, 'workspaceRoot'),
          };
        }),
        parentCeiling: card.state.autonomyMode,
        defaultWorkspaceRoot,
        availableAgents: acp.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          preset: agent.preset,
          enabled: agent.enabled,
        })),
      });

      const dispatches = [];
      for (const item of planned) {
        const specText = renderDispatchSpec({
          title: `[${item.role}] ${item.title}`,
          goal: t('agent.hostTools.dispatchGoal', { goal: card.state.goal, prompt: item.enrichedPrompt }),
          acceptance: card.state.acceptance,
          boundaries: card.state.boundaries,
          evidence: card.note ? [{ label: t('agent.hostTools.cardNotes'), text: card.note }] : [],
        });
        const action = await ledger.prepareDispatchAction({
          idempotencyKey: JSON.stringify(['cos-delegate', todoId, requestId, item.index, item.role]),
          todoId,
          actionKind: 'session_create',
          specJson: JSON.stringify({
            specText,
            runtime: 'acp',
            acpAgentId: item.agentId,
            repoRootOverride: item.workspaceRoot,
            title: item.title,
            specialistRole: item.role,
            autonomyMode: item.autonomyMode,
            isolateWorktree: item.isolateWorktree,
            requirementsVersion: card.state.requirementsVersion ?? 0,
            contentVersion: card.state.contentVersion ?? 0,
          }),
          requireConfirmation: item.autonomyMode !== 'autonomous',
        });
        dispatches.push({
          index: item.index,
          role: item.role,
          title: item.title,
          agentId: item.agentId,
          agentName: item.agentName,
          autonomyMode: item.autonomyMode,
          isolateWorktree: item.isolateWorktree,
          actionId: action.id,
          state: action.state,
        });
      }

      const summary = synthesizeDelegationSummary(
        dispatches.map((d) => ({
          role: d.role,
          title: d.title,
          agentName: d.agentName,
          autonomyMode: d.autonomyMode,
          status: d.state === 'awaiting_approval' ? 'awaiting_approval' : 'queued',
        })),
      );
      return response({
        delegationId: requestId,
        todoId,
        count: dispatches.length,
        dispatches,
        summary,
      });
    }
    if (tool === 'github_list_prs') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const owner = requiredString(args, 'owner');
      const repo = requiredString(args, 'repo');
      const stateRaw = optionalString(args, 'state');
      const state = stateRaw === 'closed' || stateRaw === 'all' ? stateRaw : 'open';
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : 20;
      const pulls = await butlerGithubListPrs({ owner, repo, state, limit });
      return response({ owner, repo, state, pulls });
    }
    if (tool === 'github_list_issues') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const owner = requiredString(args, 'owner');
      const repo = requiredString(args, 'repo');
      const stateRaw = optionalString(args, 'state');
      const state = stateRaw === 'closed' || stateRaw === 'all' ? stateRaw : 'open';
      const limit = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : 20;
      const issues = await butlerGithubListIssues({ owner, repo, state, limit });
      return response({ owner, repo, state, issues });
    }
    if (tool === 'github_get_pr_diff') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const owner = requiredString(args, 'owner');
      const repo = requiredString(args, 'repo');
      const number = args.number;
      if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
        throw new Error(t('agent.hostTools.invalidPrNumber'));
      }
      const result = await butlerGithubGetPrDiff({ owner, repo, number });
      return response(result);
    }
    if (tool === 'github_get_issue') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const owner = requiredString(args, 'owner');
      const repo = requiredString(args, 'repo');
      const number = args.number;
      if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
        throw new Error(t('agent.hostTools.invalidIssueNumber'));
      }
      const commentLimit =
        typeof args.commentLimit === 'number' && Number.isInteger(args.commentLimit)
          ? args.commentLimit
          : undefined;
      const result = await butlerGithubGetIssueDetail({ owner, repo, number, commentLimit });
      return response(result);
    }
    if (tool === 'github_create_comment') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const owner = requiredString(args, 'owner');
      const repo = requiredString(args, 'repo');
      const number = args.number;
      if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
        throw new Error(t('agent.hostTools.invalidIssueNumber'));
      }
      const body = requiredString(args, 'body');
      const workspaceRoot = optionalString(args, 'workspaceRoot') ?? '';
      if (workspaceRoot) {
        const policyDecision = await butlerPolicyEvaluate({
          workspaceRoot,
          actionKind: 'external',
          target: `https://github.com/${owner}/${repo}/issues/${number}`,
        });
        if (policyDecision.verdict === 'deny') {
          throw new Error(policyDecision.reason);
        }
      }
      const result = await butlerGithubCreateComment({ owner, repo, number, body });
      return response({ ok: true, owner, repo, number, result });
    }
    if (tool === 'browser_inspect_url') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const url = requiredString(args, 'url');
      const workspaceRoot = optionalString(args, 'workspaceRoot') ?? '';
      if (workspaceRoot) {
        const policyDecision = await butlerPolicyEvaluate({
          workspaceRoot,
          actionKind: 'network',
          target: url,
        });
        if (policyDecision.verdict === 'deny') {
          throw new Error(policyDecision.reason);
        }
      }
      const maxChars = typeof args.maxChars === 'number' && Number.isInteger(args.maxChars) ? args.maxChars : undefined;
      const allowInsecureLan = optionalBoolean(args, 'allowInsecureLan') ?? false;
      const result = await butlerBrowserInspect({ url, maxChars, allowInsecureLan });
      return response(result);
    }
    if (tool === 'project_policy_check') {
      if (!isTauriRuntime()) throw new Error(t('agent.hostTools.desktopOnly'));
      const workspaceRoot = optionalString(args, 'workspaceRoot') ?? '';
      const actionKind = requiredString(args, 'actionKind');
      const target = requiredString(args, 'target');
      const decision = await butlerPolicyEvaluate({ workspaceRoot, actionKind, target });
      return response(decision);
    }
    if (tool === 'read_activity_stream') {
      const cog = useButlerCognition.getState();
      cog.hydrate();
      const sinceRaw = optionalString(args, 'since');
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
      if (sinceRaw && !Number.isFinite(sinceMs)) {
        throw new Error(t('agent.hostTools.sinceInvalid'));
      }
      const sourceFilter = optionalString(args, 'source');
      const unconsumedOnly = optionalBoolean(args, 'unconsumedOnly') ?? false;
      const limit = Math.min(
        60,
        Math.max(1, typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : 25),
      );
      const observations = cog.observations
        .filter((o) => (!Number.isFinite(sinceMs) || o.at > sinceMs))
        .filter((o) => (!sourceFilter || o.source === sourceFilter))
        .filter((o) => (!unconsumedOnly || !o.consumedAt))
        .slice(0, limit);
      const unreadInsights = cog.insights.filter((i) => i.status === 'unread').slice(0, 15);
      return response({
        lastUserActivityAt: cog.lastUserActivityAt > 0 ? new Date(cog.lastUserActivityAt).toISOString() : null,
        lastUserChannel: cog.lastUserChannel,
        lastAmbientWakeAt: cog.lastAmbientWakeAt > 0 ? new Date(cog.lastAmbientWakeAt).toISOString() : null,
        lastDreamDate: cog.lastDreamDate,
        observationsCount: observations.length,
        observations: observations.map((o) => ({
          id: o.id,
          at: new Date(o.at).toISOString(),
          source: o.source,
          kind: o.kind,
          salience: o.salience,
          summary: o.summary,
          ref: o.ref ?? null,
          consumed: Boolean(o.consumedAt),
        })),
        armedWatchpoints: cog.watchpoints
          .filter((w) => w.status === 'armed')
          .map((w) => ({
            id: w.id,
            reason: w.reason,
            condition: w.condition,
            expiresAt: new Date(w.expiresAt).toISOString(),
          })),
        unreadInsightsCount: unreadInsights.length,
        unreadInsights: unreadInsights.map((i) => ({
          id: i.id,
          level: i.level,
          kind: i.kind,
          title: i.title,
          summary: i.summary,
          createdAt: new Date(i.createdAt).toISOString(),
        })),
      });
    }
    if (tool === 'read_room_messages') {
      const chat = useChat.getState();
      const rid = optionalString(args, 'rid');
      const sinceRaw = optionalString(args, 'since');
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
      if (sinceRaw && !Number.isFinite(sinceMs)) {
        throw new Error(t('agent.hostTools.sinceInvalid'));
      }
      const query = optionalString(args, 'query');
      const limit = Math.min(
        40,
        Math.max(1, typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : 20),
      );
      if (!rid) {
        const subs = Object.values(chat.subscriptions)
          .filter((s) => s.open !== false)
          .sort((a, b) => {
            const mentionDiff = (b.userMentions ?? 0) - (a.userMentions ?? 0);
            if (mentionDiff !== 0) return mentionDiff;
            const unreadDiff = (b.unread ?? 0) - (a.unread ?? 0);
            if (unreadDiff !== 0) return unreadDiff;
            const lmA = tsMs(chat.rooms[a.rid]?.lm ?? chat.rooms[a.rid]?.lastMessage?.ts ?? a.ls);
            const lmB = tsMs(chat.rooms[b.rid]?.lm ?? chat.rooms[b.rid]?.lastMessage?.ts ?? b.ls);
            return lmB - lmA;
          })
          .slice(0, limit);
        return response({
          rooms: subs.map((s) => {
            const room = chat.rooms[s.rid];
            const lmAt = tsMs(room?.lm ?? room?.lastMessage?.ts ?? s.ls);
            return {
              rid: s.rid,
              name: s.fname || s.name || s.rid,
              type: s.t,
              unread: s.unread ?? 0,
              userMentions: s.userMentions ?? 0,
              lastMessageAt: lmAt > 0 ? new Date(lmAt).toISOString() : null,
              lastMessagePreview: room?.lastMessage?.msg
                ? stripAgentSessionMarker(room.lastMessage.msg).slice(0, 180)
                : '',
            };
          }),
        });
      }
      let roomMessages = chat.messages[rid] ?? [];
      if (roomMessages.length === 0 && useAuth.getState().user?._id) {
        try {
          const roomType = chat.subscriptions[rid]?.t ?? chat.rooms[rid]?.t ?? 'p';
          roomMessages = await rest.getHistory(rid, roomType, limit);
        } catch {
          roomMessages = [];
        }
      }
      const filtered = roomMessages
        .filter((m) => !Number.isFinite(sinceMs) || tsMs(m.ts) > sinceMs)
        .filter((m) => matches(m.msg, query))
        .slice(-limit);
      return response({
        rid,
        roomName: chat.subscriptions[rid]?.fname || chat.subscriptions[rid]?.name || rid,
        messages: filtered.map((m) => ({
          id: m._id,
          sender: m.u?.name || m.u?.username || 'unknown',
          ts: new Date(tsMs(m.ts)).toISOString(),
          text: stripAgentSessionMarker(m.msg).slice(0, 500),
          link: permalinkOf(m.rid, m._id),
        })),
      });
    }
    if (tool === 'acp_inspect_session') {
      const sessionKey = optionalString(args, 'sessionKey');
      const todoId = optionalString(args, 'todoId');
      const messageLimit = Math.min(
        20,
        Math.max(1, typeof args.messageLimit === 'number' && Number.isInteger(args.messageLimit) ? args.messageLimit : 6),
      );
      const sessions = Object.values(useAcpAgents.getState().sessions);
      const target = sessionKey
        ? useAcpAgents.getState().sessions[sessionKey]
        : todoId
          ? sessions.find((s) => s.linkedTodoId === todoId)
          : sessions[0];
      if (!target) {
        throw new Error(t('agent.hostTools.acpSessionMissing', { sessionKey: sessionKey || todoId || 'any' }));
      }
      return response({
        sessionKey: target.sessionKey,
        acpSessionId: target.acpSessionId,
        agentName: target.agentName,
        preset: target.preset,
        status: target.status,
        autonomyMode: target.autonomyMode,
        error: target.error,
        workspaceRoot: target.workspaceRoot,
        linkedTodoId: target.linkedTodoId,
        turnCount: target.turnCount,
        lastStopReason: target.lastStopReason,
        plan: target.plan,
        recentMessages: target.messages.slice(-messageLimit).map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text.slice(0, 800),
          thoughts: m.thoughts ? m.thoughts.slice(0, 300) : undefined,
          at: new Date(m.timestamp).toISOString(),
        })),
        recentToolCalls: target.toolCalls.slice(-10).map((tc) => ({
          toolCallId: tc.toolCallId,
          title: tc.title,
          kind: tc.kind,
          status: tc.status,
        })),
        pendingPermissions: target.pendingPermissions.map((p) => ({
          requestId: p.requestId,
          reason: p.reason,
          createdAt: new Date(p.createdAt).toISOString(),
          toolTitle: p.toolCall.title ?? '',
          toolKind: p.toolCall.kind ?? '',
          locations: p.toolCall.locations ?? [],
          rawInput: p.toolCall.rawInput ?? null,
          options: p.options.map((opt) => ({
            optionId: opt.optionId,
            name: opt.name,
            kind: opt.kind,
          })),
        })),
      });
    }
    if (tool === 'acp_steer_session') {
      const sessionKey = requiredString(args, 'sessionKey');
      const action = requiredString(args, 'action');
      const acpState = useAcpAgents.getState();
      const session = acpState.sessions[sessionKey];
      if (!session) {
        throw new Error(t('agent.hostTools.acpSessionMissing', { sessionKey }));
      }
      if (action === 'cancel') {
        await acpState.cancelTurn(sessionKey);
        return response({ sessionKey, action: 'cancel', ok: true });
      }
      if (action === 'followup') {
        const prompt = requiredString(args, 'prompt');
        if (session.status === 'running') {
          const queueId = acpState.enqueuePrompt(sessionKey, prompt);
          return response({ sessionKey, action: 'followup', queued: true, queueId });
        }
        void acpState.sendPrompt(sessionKey, prompt, { injectMemory: true }).catch(() => undefined);
        return response({ sessionKey, action: 'followup', dispatched: true });
      }
      if (action === 'resolve_permission') {
        const requestId = requiredString(args, 'requestId');
        const optionId = optionalString(args, 'optionId');
        const perm = session.pendingPermissions.find((p) => p.requestId === requestId);
        const chosenOpt = optionId ? perm?.options.find((o) => o.optionId === optionId) : undefined;
        const isGrant = Boolean(optionId && (!chosenOpt?.kind || chosenOpt.kind.includes('allow')));
        const linkedCard = session.linkedTodoId
          ? useWorkLedger.getState().cards.find((c) => c.id === session.linkedTodoId)
          : undefined;
        const effectiveAutonomy = linkedCard?.state.autonomyMode ?? session.autonomyMode;
        if (isGrant && effectiveAutonomy !== 'autonomous') {
          return response({
            sessionKey,
            requestId,
            blocked: true,
            autonomyMode: effectiveAutonomy,
            message: t('agent.hostTools.permissionRequiresHuman'),
          });
        }
        await acpState.resolvePermission(sessionKey, requestId, optionId ?? null);
        return response({ sessionKey, requestId, optionId: optionId ?? null, resolved: true });
      }
      throw new Error(t('agent.hostTools.unsupportedTool', { tool: `acp_steer_session:${action}` }));
    }
    if (tool === 'watchpoint_manage') {
      const cog = useButlerCognition.getState();
      cog.hydrate();
      const op = requiredString(args, 'op');
      if (op === 'list') {
        return response({
          watchpoints: cog.watchpoints.map((w) => ({
            id: w.id,
            reason: w.reason,
            condition: w.condition,
            status: w.status,
            createdAt: new Date(w.createdAt).toISOString(),
            expiresAt: new Date(w.expiresAt).toISOString(),
          })),
        });
      }
      if (op === 'cancel') {
        const id = requiredString(args, 'id');
        return response({ id, cancelled: cog.cancelWatchpoint(id) });
      }
      if (op === 'set') {
        const reason = requiredString(args, 'reason');
        const kind = requiredString(args, 'kind');
        const ttlMinutes = typeof args.ttlMinutes === 'number' && Number.isFinite(args.ttlMinutes)
          ? args.ttlMinutes
          : 24 * 60;
        const ttlMs = ttlMinutes * 60_000;
        let condition:
          | { kind: 'after_timestamp'; wakeAt: number }
          | { kind: 'acp_session_settle'; sessionKey: string }
          | { kind: 'room_activity'; rid: string; contains?: string }
          | { kind: 'work_card_change'; todoId: string };
        if (kind === 'after_minutes') {
          const mins = typeof args.afterMinutes === 'number' && Number.isFinite(args.afterMinutes)
            ? Math.max(1, args.afterMinutes)
            : 15;
          condition = { kind: 'after_timestamp', wakeAt: Date.now() + mins * 60_000 };
        } else if (kind === 'acp_session_settle') {
          condition = { kind: 'acp_session_settle', sessionKey: requiredString(args, 'sessionKey') };
        } else if (kind === 'room_activity') {
          const contains = optionalString(args, 'contains');
          condition = { kind: 'room_activity', rid: requiredString(args, 'rid'), ...(contains ? { contains } : {}) };
        } else if (kind === 'work_card_change') {
          condition = { kind: 'work_card_change', todoId: requiredString(args, 'todoId') };
        } else {
          throw new Error(t('agent.hostTools.unsupportedTool', { tool: `watchpoint:${kind}` }));
        }
        const wp = cog.addWatchpoint({ reason, condition, ttlMs });
        return response(wp);
      }
      throw new Error(t('agent.hostTools.unsupportedTool', { tool: `watchpoint_manage:${op}` }));
    }
    if (tool === 'surface_proactive_insight') {
      const cog = useButlerCognition.getState();
      cog.hydrate();
      const rawLevel = requiredString(args, 'level');
      const level = rawLevel === 'silent_log' || rawLevel === 'interrupt' ? rawLevel : 'inbox';
      const rawKind = optionalString(args, 'kind');
      const kind = rawKind === 'progress' || rawKind === 'risk' || rawKind === 'draft' ? rawKind : 'decision';
      const suggestedActions = Array.isArray(args.suggestedActions)
        ? args.suggestedActions
          .map((item) => {
            const rec = record(item);
            const label = typeof rec.label === 'string' ? rec.label.trim() : '';
            if (!label) return null;
            const prompt = typeof rec.prompt === 'string' && rec.prompt.trim() ? rec.prompt.trim() : undefined;
            return { label, ...(prompt ? { prompt } : {}) };
          })
          .filter((item): item is { label: string; prompt?: string } => item !== null)
        : undefined;
      const rid = optionalString(args, 'rid');
      const todoId = optionalString(args, 'todoId');
      const sessionKey = optionalString(args, 'sessionKey');
      const actionId = optionalString(args, 'actionId');
      const ref = (rid || todoId || sessionKey || actionId)
        ? {
            ...(rid ? { rid } : {}),
            ...(todoId ? { todoId } : {}),
            ...(sessionKey ? { sessionKey } : {}),
            ...(actionId ? { actionId } : {}),
          }
        : undefined;
      const insight = cog.surfaceInsight({
        level,
        kind,
        title: requiredString(args, 'title'),
        summary: requiredString(args, 'summary'),
        ...(suggestedActions?.length ? { suggestedActions } : {}),
        ...(ref ? { ref } : {}),
      });
      return response({ id: insight.id, level: insight.level, kind: insight.kind, status: insight.status });
    }
    if (tool === 'skill_evolve') {
      const skillsStore = useButlerSkills.getState();
      await skillsStore.hydrate();
      const op = requiredString(args, 'op');
      if (op === 'list') {
        return response({
          skills: skillsStore.skills.map((s) => ({
            id: s.id,
            slug: s.slug,
            name: s.name,
            category: s.category,
            description: s.description,
            triggers: s.triggers,
            approvalPolicy: s.approvalPolicy,
            runCount: s.runCount,
          })),
        });
      }
      if (op === 'read') {
        const lookupId = optionalString(args, 'id');
        const lookupSlug = optionalString(args, 'slug')?.replace(/^\//, '').toLowerCase();
        const found = skillsStore.skills.find((s) =>
          (lookupId && s.id === lookupId) || (lookupSlug && s.slug.toLowerCase() === lookupSlug),
        );
        if (!found) {
          throw new Error(t('agent.hostTools.unsupportedTool', { tool: `skill:${lookupSlug || lookupId || 'missing'}` }));
        }
        return response({
          id: found.id,
          slug: found.slug,
          name: found.name,
          description: found.description,
          category: found.category,
          instructionsMd: found.instructionsMd,
          triggers: found.triggers,
          allowedTools: found.allowedTools,
          approvalPolicy: found.approvalPolicy,
          workspaceRoot: found.workspaceRoot,
          enabled: found.enabled,
          runCount: found.runCount,
        });
      }
      if (op === 'upsert') {
        const saved = await skillsStore.upsertSkill({
          id: optionalString(args, 'id'),
          slug: optionalString(args, 'slug'),
          name: requiredString(args, 'name'),
          description: optionalString(args, 'description') ?? '',
          category: optionalString(args, 'category') ?? 'general',
          instructionsMd: requiredString(args, 'instructionsMd'),
          triggers: Array.isArray(args.triggers)
            ? args.triggers.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
            : [],
          allowedTools: Array.isArray(args.allowedTools)
            ? args.allowedTools.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
            : [],
          approvalPolicy: 'confirm_write',
          workspaceRoot: optionalString(args, 'workspaceRoot') ?? null,
          enabled: true,
        });
        return response({
          id: saved.id,
          slug: saved.slug,
          name: saved.name,
          approvalPolicy: saved.approvalPolicy,
        });
      }
      throw new Error(t('agent.hostTools.unsupportedTool', { tool: `skill_evolve:${op}` }));
    }
    throw new Error(t('agent.hostTools.unsupportedTool', { tool: tool || 'unknown' }));
  } catch (error) {
    return response({
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    }, false);
  }
}
