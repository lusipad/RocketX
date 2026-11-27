import { t } from '../i18n';
import { renderDispatchSpec } from './dispatchSpec';
import {
  buildSessionContextImportSpec,
  checkSessionDispatchEligibility,
} from './sessionAdapter';
import {
  latestBuildsByDefinitionProject,
  type ButlerBuildIdentity,
} from '../lib/butlerBuilds';

export interface ButlerBuildSummary extends ButlerBuildIdentity {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  sourceBranch?: string;
}
import type {
  DispatchActionKind,
  ExternalEventCorrelationTier,
  NativeDispatchActionRecord,
  NativeExternalEventRecord,
  NativeWorkCard,
  NativeWorkEvidence,
  NativeWorkLedgerSnapshot,
  NativeWorkLink,
  NativeWorkSessionRecord,
  WorkSessionRuntime,
} from '../platform/desktopCommands';

export interface ExternalEventInput {
  dedupeKey: string;
  source: string;
  eventType: string;
  resourceKey: string;
  resourceVersion: number;
  project?: string | null;
  repo?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  workItemId?: number | null;
  prId?: number | null;
  buildId?: number | null;
  rid?: string | null;
  payloadJson?: string;
  occurredAt?: number;
}

export interface EventCorrelationMatch {
  todoId: string | null;
  tier: ExternalEventCorrelationTier;
  reason: string;
}

const BRANCH_WORK_ITEM_REGEX = /(?:^|\/)(?:ai|feature|bugfix|fix|hotfix|task)\/(\d{2,8})(?:[-_]|$)/i;
const TEXT_WORK_ITEM_REGEX = /(?:AB#|#)(\d{2,8})\b/i;

export function normalizeGitBranch(branch: string | null | undefined): string {
  if (!branch) return '';
  return branch.trim().replace(/^refs\/heads\//i, '');
}

/**
 * 三级置信度关联算法：
 * 1. exact：PR ID、Work Item ID、Git 分支名、讨论房间 rid 精确命中
 * 2. heuristic：分支名包含工作项号（如 ai/292-xxx）、载荷提及 #ID、或同项目同仓库唯一定位活跃卡片（仅入待确认，不自动派发）
 * 3. unmatched：未能可靠关联，保留在事件收件箱供管家/用户归档或建卡
 */
export function correlateExternalEvent(
  input: ExternalEventInput,
  cards: NativeWorkCard[],
  links: NativeWorkLink[],
): EventCorrelationMatch {
  if (input.prId != null) {
    const prKey = String(input.prId);
    const prLink = links.find(
      (link) =>
        link.kind === 'ado_pr' &&
        link.externalId === prKey &&
        (!input.project || !link.project || link.project === input.project),
    );
    if (prLink) {
      return {
        todoId: prLink.todoId,
        tier: 'exact',
        reason: t('agent.workCoord.exactPr', { id: input.prId }),
      };
    }
  }

  if (input.workItemId != null) {
    const wiKey = String(input.workItemId);
    const wiLink = links.find(
      (link) => link.kind === 'ado_work_item' && link.externalId === wiKey,
    );
    if (wiLink) {
      return {
        todoId: wiLink.todoId,
        tier: 'exact',
        reason: t('agent.workCoord.exactWorkItemLink', { id: input.workItemId }),
      };
    }
    const wiCard = cards.find((card) => card.adoWorkItemId === input.workItemId);
    if (wiCard) {
      return {
        todoId: wiCard.id,
        tier: 'exact',
        reason: t('agent.workCoord.exactWorkItemField', { id: input.workItemId }),
      };
    }
  }

  const normalizedBranch = normalizeGitBranch(input.branch);
  if (normalizedBranch) {
    const branchLink = links.find(
      (link) =>
        link.kind === 'git_branch' &&
        normalizeGitBranch(link.externalId) === normalizedBranch,
    );
    if (branchLink) {
      return {
        todoId: branchLink.todoId,
        tier: 'exact',
        reason: t('agent.workCoord.exactBranch', { branch: normalizedBranch }),
      };
    }
  }

  if (input.rid) {
    const ridLink = links.find(
      (link) =>
        (link.kind === 'discussion' || link.kind === 'message') &&
        (link.rid === input.rid || link.externalId === input.rid),
    );
    if (ridLink) {
      return {
        todoId: ridLink.todoId,
        tier: 'exact',
        reason: t('agent.workCoord.exactDiscussionLink', { rid: input.rid }),
      };
    }
    const ridCard = cards.find((card) => card.rid === input.rid);
    if (ridCard) {
      return {
        todoId: ridCard.id,
        tier: 'exact',
        reason: t('agent.workCoord.exactRoomSource', { rid: input.rid }),
      };
    }
  }

  // Heuristic 1: 分支名中提取工作项号（例如 ai/292-fix-build）
  if (normalizedBranch) {
    const branchMatch = normalizedBranch.match(BRANCH_WORK_ITEM_REGEX);
    if (branchMatch?.[1]) {
      const extractedId = Number.parseInt(branchMatch[1], 10);
      const matchedCard =
        cards.find((card) => card.adoWorkItemId === extractedId) ??
        cards.find((card) =>
          links.some(
            (link) =>
              link.todoId === card.id &&
              link.kind === 'ado_work_item' &&
              link.externalId === String(extractedId),
          ),
        );
      if (matchedCard) {
        return {
          todoId: matchedCard.id,
          tier: 'heuristic',
          reason: t('agent.workCoord.heuristicBranch', { branch: normalizedBranch, id: extractedId }),
        };
      }
    }
  }

  // Heuristic 2: payloadJson 中包含 #workItemId
  if (input.payloadJson) {
    const textMatch = input.payloadJson.match(TEXT_WORK_ITEM_REGEX);
    if (textMatch?.[1]) {
      const extractedId = Number.parseInt(textMatch[1], 10);
      const matchedCard = cards.find((card) => card.adoWorkItemId === extractedId);
      if (matchedCard) {
        return {
          todoId: matchedCard.id,
          tier: 'heuristic',
          reason: t('agent.workCoord.heuristicPayload', { id: extractedId }),
        };
      }
    }
  }

  // Heuristic 3: 同 project 仅有一张处于 in_progress / verifying 的卡片
  if (input.project) {
    const activeProjectCards = cards.filter(
      (card) =>
        (card.adoProject === input.project || card.state.projectKey === input.project) &&
        (card.state.stage === 'in_progress' || card.state.stage === 'verifying'),
    );
    if (activeProjectCards.length === 1) {
      return {
        todoId: activeProjectCards[0].id,
        tier: 'heuristic',
        reason: t('agent.workCoord.heuristicProject', { project: input.project }),
      };
    }
  }

  return {
    todoId: null,
    tier: 'unmatched',
    reason: t('agent.workCoord.unmatched'),
  };
}

export interface LiveStateVerificationOptions {
  recentBuilds?: ButlerBuildSummary[];
  latestPrHeadSha?: string | null;
}

export interface LiveStateVerificationResult {
  stale: boolean;
  reason: string;
  invalidateOldEvidenceOnSha?: string | null;
}

/**
 * 步骤 4：核实当前状态（先拉取/核对最新状态，不盲信单条历史通知）
 * - 若收到旧的构建失败事件，但同一定义+项目已有更新的构建成功记录，则判定为 verified_stale
 * - 若事件携带新的 PR/分支 commitSha，触发旧 SHA 证据过期失效
 */
export function verifyExternalEventAgainstLiveState(
  event: Pick<
    NativeExternalEventRecord,
    'eventType' | 'project' | 'buildId' | 'commitSha' | 'occurredAt'
  >,
  card: NativeWorkCard,
  options: LiveStateVerificationOptions = {},
): LiveStateVerificationResult {
  if (
    card.state.revokedAt != null &&
    event.occurredAt <= card.state.revokedAt
  ) {
    return {
      stale: true,
      reason: t('agent.workCoord.staleRevoked'),
    };
  }

  if (card.state.waitState === 'paused' || card.state.waitState === 'canceled') {
    return {
      stale: true,
      reason: t('agent.workCoord.staleWaitState', { waitState: card.state.waitState }),
    };
  }

  if (event.eventType === 'build.complete' && options.recentBuilds?.length) {
    const latestBuilds = latestBuildsByDefinitionProject(options.recentBuilds);
    const newerBuildOnProject = latestBuilds.find(
      (b) =>
        (!event.project || b.project === event.project) &&
        event.buildId != null &&
        b.id > event.buildId,
    );
    if (newerBuildOnProject) {
      return {
        stale: true,
        reason: t('agent.workCoord.staleNewerBuild', { build: newerBuildOnProject.buildNumber || newerBuildOnProject.id, outcome: newerBuildOnProject.result || newerBuildOnProject.status || '', eventBuildId: event.buildId ?? '' }),
      };
    }
  }

  const effectiveSha = options.latestPrHeadSha ?? event.commitSha ?? null;
  if (effectiveSha && effectiveSha.trim()) {
    return {
      stale: false,
      reason: t('agent.workCoord.verifiedNewSha'),
      invalidateOldEvidenceOnSha: effectiveSha.trim(),
    };
  }

  return {
    stale: false,
    reason: t('agent.workCoord.verified'),
  };
}

export interface DispatchDecision {
  decision:
    | 'ignore_stale'
    | 'unmatched_triage'
    | 'require_confirmation'
    | 'auto_dispatch'
    | 'blocked_privacy'
    | 'blocked_readonly_session';
  actionKind: DispatchActionKind;
  targetSessionId: string | null;
  targetRuntime?: WorkSessionRuntime;
  requiresColdResume: boolean;
  suggestImportFromSessionId: string | null;
  specText: string;
  reason: string;
}

export function selectPreferredSessionForCard(
  cardId: string,
  sessions: readonly NativeWorkSessionRecord[],
  preferredRuntime?: WorkSessionRuntime,
): NativeWorkSessionRecord | null {
  const cardSessions = sessions.filter((s) => s.todoId === cardId);
  if (cardSessions.length === 0) return null;
  if (preferredRuntime) {
    const exactRuntime =
      cardSessions.find(
        (s) => s.runtime === preferredRuntime && s.controlMode === 'controllable',
      ) ??
      cardSessions.find(
        (s) => s.runtime === preferredRuntime && s.controlMode === 'resumable',
      ) ??
      cardSessions.find((s) => s.runtime === preferredRuntime);
    if (exactRuntime) return exactRuntime;
  }
  return (
    cardSessions.find((s) => s.controlMode === 'controllable') ??
    cardSessions.find((s) => s.controlMode === 'resumable') ??
    cardSessions[0] ??
    null
  );
}

/**
 * 步骤 5 & 6：管家判断 + 权限/自主级别/预算/隐私防火墙检查
 */
export function evaluateEventDispatchDecision(
  event: NativeExternalEventRecord,
  card: NativeWorkCard | null,
  sessions: NativeWorkSessionRecord[],
  verification: LiveStateVerificationResult,
): DispatchDecision {
  if (!card || event.correlationTier === 'unmatched') {
    return {
      decision: 'unmatched_triage',
      actionKind: 'session_prompt',
      targetSessionId: null,
      requiresColdResume: false,
      suggestImportFromSessionId: null,
      specText: '',
      reason: t('agent.workCoord.unmatchedTriage'),
    };
  }

  if (verification.stale) {
    return {
      decision: 'ignore_stale',
      actionKind: 'session_prompt',
      targetSessionId: null,
      requiresColdResume: false,
      suggestImportFromSessionId: null,
      specText: '',
      reason: verification.reason,
    };
  }

  const preferredSession = selectPreferredSessionForCard(card.id, sessions);

  const specText = renderDispatchSpec({
    title: card.title,
    goal: t('agent.workCoord.eventGoal', { goal: card.state.goal || card.title, source: event.source, eventType: event.eventType, resourceKey: event.resourceKey, resourceVersion: event.resourceVersion }),
    acceptance:
      card.state.acceptance.length > 0
        ? card.state.acceptance
        : [t('agent.workCoord.eventDefaultAcceptance')],
    boundaries: [
      ...card.state.boundaries,
      t('agent.superAgent.adoBoundary'),
      t('agent.workCoord.eventBoundaryUntrusted'),
    ],
    evidence: [
      {
        label: `${event.source}:${event.eventType} (${event.resourceKey})`,
        text: event.payloadJson,
      },
    ],
  });

  if (preferredSession) {
    const eligibility = checkSessionDispatchEligibility(
      preferredSession,
      card.state.visibility,
      'session_prompt',
    );
    if (!eligibility.allowed) {
      if (card.state.visibility === 'private' && preferredSession.visibility === 'room_shared') {
        return {
          decision: 'blocked_privacy',
          actionKind: 'session_prompt',
          targetSessionId: preferredSession.id,
          requiresColdResume: false,
          suggestImportFromSessionId: null,
          specText,
          reason: eligibility.reason,
        };
      }
      return {
        decision: 'blocked_readonly_session',
        actionKind: 'session_create',
        targetSessionId: null,
        requiresColdResume: false,
        suggestImportFromSessionId: eligibility.fallbackToImportContext
          ? preferredSession.id
          : null,
        specText: buildSessionContextImportSpec({
          sourceSession: preferredSession,
          cardGoal: card.state.goal || card.title,
          acceptance: card.state.acceptance,
          boundaries: card.state.boundaries,
          recentTranscriptExcerpt: t('agent.workCoord.eventImportExcerpt', { eventType: event.eventType, resourceKey: event.resourceKey }),
          nextInstruction: t('agent.workCoord.eventImportNext'),
        }),
        reason: eligibility.reason,
      };
    }
  }

  // 启发式匹配、只读/确认模式、或自动轮次预算耗尽时，一律进入待确认
  const budgetExhausted =
    card.state.autoTurnsUsed >= card.state.maxAutoTurns ||
    card.state.consecutiveFailures >= 2;

  if (
    event.correlationTier === 'heuristic' ||
    card.state.autonomyMode !== 'autonomous' ||
    budgetExhausted
  ) {
    const whyConfirm =
      event.correlationTier === 'heuristic'
        ? t('agent.workCoord.confirmHeuristic')
        : budgetExhausted
          ? t('agent.workCoord.confirmBudget', { used: card.state.autoTurnsUsed, max: card.state.maxAutoTurns, failures: card.state.consecutiveFailures })
          : t('agent.workCoord.confirmMode', { mode: card.state.autonomyMode === 'readonly' ? t('agent.workCoord.modeReadonly') : t('agent.workCoord.modeConfirm') });

    return {
      decision: 'require_confirmation',
      actionKind: preferredSession ? 'session_prompt' : 'session_create',
      targetSessionId: preferredSession?.id ?? null,
      targetRuntime: preferredSession?.runtime,
      requiresColdResume: preferredSession?.controlMode === 'resumable',
      suggestImportFromSessionId: null,
      specText,
      reason: whyConfirm,
    };
  }

  return {
    decision: 'auto_dispatch',
    actionKind: preferredSession ? 'session_prompt' : 'session_create',
    targetSessionId: preferredSession?.id ?? null,
    targetRuntime: preferredSession?.runtime,
    requiresColdResume: preferredSession?.controlMode === 'resumable',
    suggestImportFromSessionId: null,
    specText,
    reason: t('agent.workCoord.autoDispatch', { turn: card.state.autoTurnsUsed + 1, max: card.state.maxAutoTurns }),
  };
}

export interface ReconcileActionOutcome {
  actionId: string;
  nextState: 'acknowledged' | 'prepared' | 'failed' | 'verifying_delivery';
  receiptRef?: string;
  reason: string;
}

/**
 * 步骤 7 & 8：崩溃恢复与去重对账（Reconciliation before Retry）
 * 应用重启后扫描处于 verifying_delivery / dispatched 的动作：
 * 水位只说明会话有变化，不构成该动作的因果回执；核对完成前保留未知，绝不盲目重发。
 */
export function reconcilePendingDispatchActions(
  actions: NativeDispatchActionRecord[],
  sessions: NativeWorkSessionRecord[],
): ReconcileActionOutcome[] {
  const outcomes: ReconcileActionOutcome[] = [];
  for (const action of actions) {
    if (action.actionKind === 'ado_state_write' || action.actionKind === 'rc_report' || action.actionKind === 'ado_comment') continue;
    if (action.state !== 'verifying_delivery' && action.state !== 'dispatched') {
      continue;
    }
    const session = action.sessionId
      ? sessions.find((s) => s.id === action.sessionId)
      : undefined;
    if (!session) {
      outcomes.push({
        actionId: action.id,
        nextState: 'verifying_delivery',
        reason: t('agent.workCoord.reconcileNoSession'),
      });
      continue;
    }

    const marker = action.baselineMarker?.trim() ?? '';
    const seqMatch = marker.match(/^seq:(\d+)$/);
    if (seqMatch && session.lastEventSeq != null) {
      const baselineSeq = Number.parseInt(seqMatch[1], 10);
      if (session.lastEventSeq > baselineSeq) {
        outcomes.push({
          actionId: action.id,
          nextState: 'verifying_delivery',
          reason: t('agent.workCoord.reconcileNewSeq', { from: baselineSeq, to: session.lastEventSeq }),
        });
        continue;
      }
    }

    const turnMatch = marker.match(/^turn:(.+)$/);
    if (turnMatch && session.lastTurnId && session.lastTurnId !== turnMatch[1]) {
      outcomes.push({
        actionId: action.id,
        nextState: 'verifying_delivery',
        reason: t('agent.workCoord.reconcileNewTurn', { from: turnMatch[1], to: session.lastTurnId }),
      });
      continue;
    }

    outcomes.push({
      actionId: action.id,
      nextState: 'verifying_delivery',
      reason: t('agent.workCoord.reconcileUnchanged'),
    });
  }
  return outcomes;
}

export interface CardCompletionEvaluation {
  canMarkDone: boolean;
  recommendedStage: 'in_progress' | 'verifying' | 'done';
  validEvidences: NativeWorkEvidence[];
  staleEvidences: NativeWorkEvidence[];
  reason: string;
}

export function isFollowedWork(card: NativeWorkCard): boolean {
  return (card.state.requirementsVersion ?? 0) > 0 || card.state.acceptance.length > 0 || card.state.ownerKind !== 'human';
}

/**
 * 步骤 9：验收证据与完成门禁（Session idle != 任务完成）
 */
export function evaluateCardCompletionGate(
  card: NativeWorkCard,
  evidences: NativeWorkEvidence[],
  _humanConfirmedDone = false,
): CardCompletionEvaluation {
  const cardEvidences = evidences.filter((e) => e.todoId === card.id);
  const requirementVersion = card.state.requirementsVersion ?? 0;
  const contentVersion = card.state.contentVersion ?? 0;
  const currentVersion = (e: NativeWorkEvidence) =>
    e.requirementsVersion === requirementVersion && e.contentVersion === contentVersion;
  const validEvidences = cardEvidences.filter((e) => e.passed && !e.stale && currentVersion(e) && (
    e.kind === 'manual_ack'
      ? Boolean(e.acceptedBy?.trim()) && Boolean(e.acceptanceScope?.length)
      : !['agent_report', 'manual_note'].includes(e.kind)
  ));
  const staleEvidences = cardEvidences.filter((e) => e.stale || !currentVersion(e));
  const missing = card.state.acceptance.filter((criterion) => !validEvidences.some((e) =>
    e.criterionIds?.includes(criterion) && (e.kind !== 'manual_ack' || e.acceptanceScope?.includes(criterion))));
  let reason = '';
  if (isFollowedWork(card) && (!card.state.goal?.trim() || !card.state.acceptance.length)) {
    reason = t('agent.workCoord.gateGoalAndAcceptance');
  } else if (card.state.waitState !== 'none') {
    reason = t('agent.workCoord.gateWaitState');
  } else if (missing.length) {
    reason = t('agent.workCoord.gateMissingCriteria', { criteria: missing.join(t('agent.common.listSep')) });
  } else if (!isFollowedWork(card) || validEvidences.length > 0) {
    return { canMarkDone: true, recommendedStage: 'done', validEvidences, staleEvidences, reason: t('agent.workCoord.gatePassed') };
  } else {
    reason = t('agent.workCoord.gateNeedEvidence');
  }
  return {
    canMarkDone: false,
    recommendedStage: 'verifying',
    validEvidences,
    staleEvidences,
    reason,
  };
}

export function buildCardSummaryFromSnapshot(
  cardId: string,
  snapshot: NativeWorkLedgerSnapshot,
) {
  const card = snapshot.cards.find((c) => c.id === cardId) ?? null;
  const links = snapshot.links.filter((l) => l.todoId === cardId);
  const sessions = snapshot.sessions.filter((s) => s.todoId === cardId);
  const evidences = snapshot.evidences.filter((e) => e.todoId === cardId);
  const events = snapshot.events.filter((ev) => ev.todoId === cardId);
  const actions = snapshot.actions.filter((a) => a.todoId === cardId);
  return { card, links, sessions, evidences, events, actions };
}
