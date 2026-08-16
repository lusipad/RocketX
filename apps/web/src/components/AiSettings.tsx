import { useEffect, useState } from 'react';
import { isTauri } from '../lib/http';
import { openExternal } from '../lib/client';
import { getAiRuntimeStartupResolution } from '../lib/aiRuntimeBootstrap';
import {
  getAiRuntimeProvider,
  persistAiRuntimeProvider,
  readConfiguredAiRuntimeProvider,
  runtimeFeatures,
  type AiRuntimeProvider,
} from '../lib/runtimeMode';
import {
  ocrBackendLabel,
  probeImageOcrRuntime,
  type ImageOcrRuntimeProbe,
} from '../lib/imageOcr';
import {
  buildCodexDiagnosticSummary,
  getCodexManualPath,
  setCodexManualPath,
  useCodexRuntime,
} from '../stores/codexRuntime';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ReverseMcpSettings from './ReverseMcpSettings';
import AgentBotSettings from './AgentBotSettings';
import { RadioGroup, Row } from './SettingControls';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';
const secondaryButtonCls =
  'h-8 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50';

function codexReasonLabel(reasonCode: ReturnType<typeof useCodexRuntime.getState>['reasonCode']): string {
  switch (reasonCode) {
    case 'not-found':
      return '未找到可用 Codex';
    case 'outdated':
      return '版本过旧';
    case 'manual-path':
      return '手动路径不可用';
    case 'missing-app-server':
      return '缺少 app-server';
    case 'not-logged-in':
      return '尚未登录';
    case 'unavailable':
      return '运行时不可用';
    default:
      return '待检测';
  }
}

function codexSourceName(source: ReturnType<typeof useCodexRuntime.getState>['source']): string {
  switch (source) {
    case 'manual':
      return '手动';
    case 'system':
      return '系统';
    case 'standard':
      return '标准安装';
    case 'bundled':
      return '内置';
    default:
      return '未知';
  }
}

function codexSourceLabel(source: ReturnType<typeof useCodexRuntime.getState>['source']): string {
  switch (source) {
    case 'manual':
      return '手动指定';
    case 'system':
      return '系统 Codex';
    case 'standard':
      return '标准位置 Codex';
    case 'bundled':
      return 'RocketX 内置 Codex';
    default:
      return '未检测到';
  }
}

function codexCompatibilityLabel(
  status: ReturnType<typeof useCodexRuntime.getState>['compatibilityStatus'],
): string {
  switch (status) {
    case 'verified':
      return '已验证';
    case 'untested-newer':
      return '新版待验证';
    case 'blocked':
      return '已阻止';
    default:
      return '';
  }
}

function aiRuntimeLabel(provider: AiRuntimeProvider): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'deepseek':
      return 'DSH';
    default:
      return '无 AI';
  }
}

export default function AiSettings() {
  const activeAiRuntime = getAiRuntimeProvider();
  const startupResolution = getAiRuntimeStartupResolution();
  const [selectedAiRuntime, setSelectedAiRuntime] = useState<AiRuntimeProvider>(
    () => readConfiguredAiRuntimeProvider() ?? getAiRuntimeProvider(),
  );
  const [manualCodexPath, setManualCodexPathState] = useState(getCodexManualPath);
  const [ocrRuntime, setOcrRuntime] = useState<ImageOcrRuntimeProbe>();
  const codexRuntime = useCodexRuntime();
  const openButlerConversation = useUI((state) => state.openButlerConversation);

  useEffect(() => {
    if (!isTauri || !runtimeFeatures().ocr) return;
    void probeImageOcrRuntime().then(setOcrRuntime, (error) => {
      setOcrRuntime({ reason: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const codexSource = codexSourceLabel(codexRuntime.source);
  const codexCompatibility = codexCompatibilityLabel(codexRuntime.compatibilityStatus);

  const saveCodexPath = async () => {
    setCodexManualPath(manualCodexPath);
    await codexRuntime.probe();
  };
  const copyCodexSummary = async () => {
    try {
      await navigator.clipboard.writeText(buildCodexDiagnosticSummary(codexRuntime));
      toast.success('已复制诊断摘要');
    } catch (error) {
      toast.error(error, '复制诊断摘要失败');
    }
  };
  const clearManualCodexPath = async () => {
    setCodexManualPath('');
    setManualCodexPathState('');
    await codexRuntime.probe();
  };
  const rejectedCandidates = codexRuntime.candidates.filter((candidate) => candidate.outcome === 'rejected');
  const hasOutdatedCandidate = rejectedCandidates.some((candidate) => candidate.reasonCode === 'outdated')
    || codexRuntime.reasonCode === 'outdated';
  const selectAiRuntime = (provider: AiRuntimeProvider): void => {
    setSelectedAiRuntime(persistAiRuntimeProvider(provider));
  };
  const activeAiRuntimeLabel = aiRuntimeLabel(activeAiRuntime);
  const startupModeHint = startupResolution.source === 'automatic'
    ? '（按本机可用性自动判断）'
    : startupResolution.source === 'full-default'
      ? '（完整包默认）'
      : '';
  const explicitRuntimeUnavailable = startupResolution.source === 'explicit-unavailable'
    && selectedAiRuntime === startupResolution.configured;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">AI 运行时</h2>
        <div className="rounded-lg bg-surface px-4 shadow-raise">
          <Row label="执行后端" hint="全局只启用一个后端，主管家、房间侧栏和 AI 托管共用该选择。">
            <div className="space-y-2">
              <RadioGroup
                value={selectedAiRuntime}
                options={[
                  { key: 'codex', label: 'Codex', hint: '使用 Codex 原生任务、Skills 和插件' },
                  { key: 'deepseek', label: 'DSH', hint: '使用 DeepSeek DSH 原生界面与配置' },
                  { key: 'none', label: '无 AI', hint: '不启动本地 AI；仍可查看已有托管记录' },
                ]}
                onChange={selectAiRuntime}
              />
              <p className="text-xs leading-5 text-ink-3">
                当前运行：{activeAiRuntimeLabel}{startupModeHint}。修改后重启 RocketX 生效；当前进程不会热切换或同时启动两个后端。
              </p>
              {explicitRuntimeUnavailable ? (
                <p className="text-xs font-medium leading-5 text-warning" role="status">
                  {aiRuntimeLabel(selectedAiRuntime)} 选择已保留，但当前运行时不可用，本次未启用 AI。
                  {startupResolution.reason ? ` ${startupResolution.reason}` : ''}
                  {' '}修复后重启 RocketX 即可继续使用。
                </p>
              ) : selectedAiRuntime !== activeAiRuntime ? (
                <p className="text-xs font-medium text-warning" role="status">
                  已保存，重启后切换为 {aiRuntimeLabel(selectedAiRuntime)}。
                </p>
              ) : null}
            </div>
          </Row>
        </div>
      </section>

      {activeAiRuntime === 'codex' ? <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Codex</h2>
        <div className="rounded-lg bg-surface px-4 shadow-raise">
          {codexRuntime.phase !== 'ready' ? (
            <Row label="运行状态" hint="RocketX 的任务、Skills、Memory、审批和已安排任务都由 Codex 驱动。">
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm leading-6 text-ink">
                <p>{codexRuntime.reason ?? 'Codex 暂不可用'}</p>
                <div className="mt-2 space-y-1 text-xs text-ink-2">
                  <p>判定：{codexReasonLabel(codexRuntime.reasonCode)}</p>
                  {codexRuntime.version ? <p>版本：{codexRuntime.version}</p> : null}
                  {codexRuntime.source ? <p>来源：{codexSource}</p> : null}
                  {codexRuntime.executablePath ? (
                    <p>路径：<span className="break-all font-mono">{codexRuntime.executablePath}</span></p>
                  ) : null}
                  {codexRuntime.protocolBaseline ? <p>协议基线：{codexRuntime.protocolBaseline}</p> : null}
                </div>
                {codexRuntime.reasonCode === 'not-found' ? (
                  <div className="mt-2 space-y-2">
                    <code className="block rounded bg-fill px-2 py-1 font-mono text-xs">
                      npm install -g @openai/codex
                    </code>
                    <button
                      type="button"
                      onClick={() => void openExternal('https://help.openai.com/en/articles/11096431')}
                      className="text-primary hover:underline"
                    >
                      查看 Codex 官方安装说明
                    </button>
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyCodexSummary()}
                    className={secondaryButtonCls}
                  >
                    复制诊断摘要
                  </button>
                  {hasOutdatedCandidate ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void openExternal('https://help.openai.com/en/articles/11096431')}
                        className={secondaryButtonCls}
                      >
                        官方升级说明
                      </button>
                      <button
                        type="button"
                        onClick={() => void codexRuntime.probe()}
                        disabled={codexRuntime.phase === 'checking'}
                        className={secondaryButtonCls}
                      >
                        {codexRuntime.phase === 'checking' ? '检测中…' : '升级后重新检测'}
                      </button>
                    </>
                  ) : null}
                  {codexRuntime.reasonCode === 'manual-path' ? (
                    <button
                      type="button"
                      onClick={() => void clearManualCodexPath()}
                      disabled={codexRuntime.phase === 'checking'}
                      className={secondaryButtonCls}
                    >
                      清除手动路径并自动检测
                    </button>
                  ) : null}
                  {!hasOutdatedCandidate ? (
                    <button
                      type="button"
                      onClick={() => void codexRuntime.probe()}
                      disabled={codexRuntime.phase === 'checking'}
                      className={secondaryButtonCls}
                    >
                      {codexRuntime.phase === 'checking' ? '检测中…' : '重试'}
                    </button>
                  ) : null}
                </div>
              </div>
            </Row>
          ) : null}
          <Row label="运行时" hint="默认自动检测系统和标准安装位置；只有需要固定另一份安装时才填写手动路径。">
            <div className="space-y-2">
              <p className="text-sm text-ink-2">
                {codexSource}
                {codexRuntime.version ? ` · ${codexRuntime.version}` : ''}
                {codexCompatibility ? ` · ${codexCompatibility}` : ''}
              </p>
              {codexRuntime.executablePath ? (
                <p className="break-all font-mono text-xs leading-5 text-ink-3">{codexRuntime.executablePath}</p>
              ) : null}
              <div className="flex max-w-2xl items-center gap-2">
                <input
                  aria-label="手动 Codex 路径"
                  value={manualCodexPath}
                  onChange={(event) => setManualCodexPathState(event.target.value)}
                  placeholder="留空自动检测"
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => void saveCodexPath()}
                  disabled={codexRuntime.phase === 'checking'}
                  className="h-9 shrink-0 rounded-md border border-line px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
                >
                  应用并检测
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copyCodexSummary()}
                  className={secondaryButtonCls}
                >
                  复制诊断摘要
                </button>
                <button
                  type="button"
                  onClick={() => void codexRuntime.probe()}
                  disabled={codexRuntime.phase === 'checking'}
                  className={secondaryButtonCls}
                >
                  {codexRuntime.phase === 'checking' ? '检测中…' : '重新检测'}
                </button>
              </div>
              {rejectedCandidates.length > 0 ? (
                <details className="group border-t border-line/80 pt-2">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-ink-3 hover:text-ink-2">
                    查看 {rejectedCandidates.length} 个被跳过的候选
                  </summary>
                  <div className="mt-2 space-y-2 text-xs leading-5 text-ink-2">
                    {rejectedCandidates.map((candidate, index) => (
                      <div key={`${candidate.source}:${candidate.path}:${index}`} className="rounded-md bg-fill px-2 py-1">
                        <p>{codexSourceName(candidate.source)} · {candidate.reasonCode ? codexReasonLabel(candidate.reasonCode) : '已跳过'}</p>
                        <p className="break-all font-mono">{candidate.path}</p>
                        {candidate.version ? <p>版本：{candidate.version}</p> : null}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </Row>
          <Row label="图片文字识别" hint="增强资源存在时使用 PP-OCRv5，否则使用系统识别。">
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                {ocrRuntime?.backend ? ocrBackendLabel(ocrRuntime.backend) : '正在检测识别引擎…'}
                {ocrRuntime?.resourceRoot ? ` · ${ocrRuntime.resourceRoot}` : ''}
              </p>
              {ocrRuntime?.reason ? <p className="text-xs leading-5 text-ink-3">{ocrRuntime.reason}</p> : null}
            </div>
          </Row>
        </div>
      </section> : activeAiRuntime === 'deepseek' ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink">DSH</h2>
          <div className="rounded-lg bg-surface px-4 shadow-raise">
            <Row label="原生配置" hint="模型、Agent、凭据和权限统一由 DSH Web 管理。">
              <button
                type="button"
                onClick={() => openButlerConversation()}
                className={secondaryButtonCls}
              >
                打开 DSH 配置
              </button>
            </Row>
          </div>
        </section>
      ) : (
        <section className="rounded-lg bg-surface px-4 py-3 text-sm leading-6 text-ink-2 shadow-raise">
          当前启动未启用 AI。聊天、工作台和普通协作能力保持可用。
        </section>
      )}

      {activeAiRuntime !== 'none' ? <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">外部集成</h2>
        <div className="space-y-6 rounded-lg bg-surface p-4 shadow-raise">
          <ReverseMcpSettings />
          <AgentBotSettings />
        </div>
      </section> : null}
    </div>
  );
}
