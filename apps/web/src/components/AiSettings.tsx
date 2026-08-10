import { useEffect, useState } from 'react';
import { isTauri } from '../lib/http';
import { openExternal } from '../lib/client';
import {
  ocrBackendLabel,
  probeImageOcrRuntime,
  type ImageOcrRuntimeProbe,
} from '../lib/imageOcr';
import {
  getCodexManualPath,
  setCodexManualPath,
  useCodexRuntime,
} from '../stores/codexRuntime';
import ReverseMcpSettings from './ReverseMcpSettings';
import AgentBotSettings from './AgentBotSettings';
import { Row } from './SettingControls';

const inputCls =
  'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm outline-none transition focus:border-primary';

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

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Codex</h2>
        <div className="rounded-lg bg-surface px-4 shadow-raise">
          {codexRuntime.phase !== 'ready' ? (
            <Row label="运行状态" hint="RocketX 的任务、Skills、Memory、审批和已安排任务都由 Codex 驱动。">
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm leading-6 text-ink">
                <p>{codexRuntime.reason ?? 'Codex 暂不可用'}</p>
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
                <button
                  type="button"
                  onClick={() => void codexRuntime.probe()}
                  disabled={codexRuntime.phase === 'checking'}
                  className="mt-2 h-8 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
                >
                  {codexRuntime.phase === 'checking' ? '检测中…' : '重试'}
                </button>
              </div>
            </Row>
          ) : null}
          <Row label="运行时" hint="默认使用系统 Codex；只有需要固定另一份安装时才填写手动路径。">
            <div className="space-y-2">
              <p className="text-sm text-ink-2">
                {codexSourceLabel}
                {codexRuntime.version ? ` · ${codexRuntime.version}` : ''}
                {codexCompatibilityLabel ? ` · ${codexCompatibilityLabel}` : ''}
                {codexRuntime.executablePath ? ` · ${codexRuntime.executablePath}` : ''}
              </p>
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
