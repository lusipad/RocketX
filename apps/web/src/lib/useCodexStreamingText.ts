import { useEffect, useState } from 'react';
import { useCodexWorkspace } from '../stores/codexWorkspace';

const STREAM_RENDER_INTERVAL_MS = 50;
type CodexWorkspaceState = ReturnType<typeof useCodexWorkspace.getState>;
type CodexStreamingView = Pick<CodexWorkspaceState, 'streamingText' | 'events'>;

function useCoalescedCodexProjection<T>(
  select: (state: CodexWorkspaceState) => T,
  changed: (state: CodexWorkspaceState, previous: CodexWorkspaceState) => boolean,
  settled: (state: CodexWorkspaceState) => boolean,
): T {
  const [value, setValue] = useState(() => select(useCodexWorkspace.getState()));

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      timer = undefined;
      setValue(select(useCodexWorkspace.getState()));
    };
    const unsubscribe = useCodexWorkspace.subscribe((state, previous) => {
      const threadChanged = state.activeThreadId !== previous.activeThreadId;
      if (!threadChanged && !changed(state, previous)) return;
      if (threadChanged || settled(state)) {
        if (timer !== undefined) window.clearTimeout(timer);
        sync();
      } else if (timer === undefined) {
        timer = window.setTimeout(sync, STREAM_RENDER_INTERVAL_MS);
      }
    });

    sync();
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [changed, select, settled]);

  return value;
}

const selectStreamingText = (state: CodexWorkspaceState): string => state.streamingText;
const streamingTextChanged = (state: CodexWorkspaceState, previous: CodexWorkspaceState): boolean => (
  state.streamingText !== previous.streamingText
);
const streamingTextSettled = (state: CodexWorkspaceState): boolean => !state.streamingText;

const selectStreamingView = (state: CodexWorkspaceState): CodexStreamingView => ({
  streamingText: state.streamingText,
  events: state.events,
});
const streamingViewChanged = (state: CodexWorkspaceState, previous: CodexWorkspaceState): boolean => (
  state.streamingText !== previous.streamingText || state.events !== previous.events
);
const streamingViewSettled = (state: CodexWorkspaceState): boolean => (
  !state.streamingText && state.events.every((event) => event.status !== 'running')
);

/** 保留完整 store 文本，只合并高频的界面刷新。 */
export function useCodexStreamingText(): string {
  return useCoalescedCodexProjection(
    selectStreamingText,
    streamingTextChanged,
    streamingTextSettled,
  );
}

/** 主管家同时合并回答与任务过程的高频刷新。 */
export function useCodexStreamingView(): CodexStreamingView {
  return useCoalescedCodexProjection(
    selectStreamingView,
    streamingViewChanged,
    streamingViewSettled,
  );
}
