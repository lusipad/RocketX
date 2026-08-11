import { useEffect, useState } from 'react';
import { isTauri } from '../lib/http';
import { openExternal } from '../lib/client';
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
import ReverseMcpSettings from './ReverseMcpSettings';
import AgentBotSettings from './AgentBotSettings';
import { Row } from './SettingControls';

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
  return source === 'manual'
    ? '手动'
    : source === 'system'
      ? '系统'
      : source === 'standard'
        ? '标准安装'
        : source === 'bundled'
          ? '内置'
          : '未知';
}

export default function AiSettings() {
  const [manualCodexPath, setManualCodexPathState] = useState(getCodexManualPath);
  const [ocrRuntime, setOcrRuntime] = useState<ImageOcrRuntimeProbe>();
  const codexRuntime = useCodexRuntime();

  useEffect(() => {
    if (!isTauri) return;
    void probeImageOcrRuntime().then(setOcrRuntime, (error) => {
      setOcrRuntime({ reason: error instanceof Error ? error.message : String(error) });
    });
  }, []);

  const codexSourceLabel = codexRuntime.source === 'manual'
    ? '手动指定'
    : codexRuntime.source === 'system'
      ? '系统 Codex'
      : codexRuntime.source === 'standard'
        ? '标准位置 Codex'
        : codexRuntime.source === 'bundled'
          ? 'RocketX 内置 Codex'
          : '未检测到';
  const codexCompatibilityLabel = codexRuntime.compatibilityStatus === 'verified'
    ? '已验证'
    : codexRuntime.compatibilityStatus === 'untested-newer'
      ? '新版待验证'
      : codexRuntime.compatibilityStatus === 'blocked'
        ? '已阻止'
        : '';

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

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Codex</h2>
        <div className="rounded-lg bg-surface px-4 shadow-raise">
          {codexRuntime.phase !== 'ready' ? (
            <Row label="运行状态" hint="RocketX 的任务、Skills、Memory、审批和已安排任务都由 Codex 驱动。">
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm leading-6 text-ink">
                <p>{codexRuntime.reason ?? 'Codex 暂不可用'}</p>
                <div className="mt-2 space-y-1 text-xs text-ink-2">
                  <p>判定：{codexReasonLabel(codexRuntime.reasonCode)}</p>
                  {codexRuntime.version ? <p>版本：{codexRuntime.version}</p> : null}
                  {codexRuntime.source ? <p>来源：{codexSourceLabel}</p> : null}
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
                {codexSourceLabel}
                {codexRuntime.version ? ` · ${codexRuntime.version}` : ''}
                {codexCompatibilityLabel ? ` · ${codexCompatibilityLabel}` : ''}
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
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">外部集成</h2>
        <div className="space-y-6 rounded-lg bg-surface p-4 shadow-raise">
          <ReverseMcpSettings />
          <AgentBotSettings />
        </div>
      </section>
    </div>
  );
}
