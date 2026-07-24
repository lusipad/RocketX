import { useEffect, useLayoutEffect, useRef } from 'react';
import katex from 'katex';

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const BASE_OPTIONS = {
  trust: false,
  maxSize: 20,
  maxExpand: 1000,
  output: 'htmlAndMathml' as const,
  throwOnError: true,
  globalGroup: false,
};

export default function MarkdownMath({
  value,
  display,
}: {
  value: string;
  display: boolean;
}) {
  const displayRef = useRef<HTMLDivElement>(null);
  const inlineRef = useRef<HTMLSpanElement>(null);

  useClientLayoutEffect(() => {
    const element = display ? displayRef.current : inlineRef.current;
    if (!element) return;

    try {
      katex.render(value, element, {
        ...BASE_OPTIONS,
        displayMode: display,
        macros: {},
      });
    } catch {
      element.textContent = value;
    }
  }, [display, value]);

  if (display) {
    return (
      <div
        ref={displayRef}
        data-rocketx-math="display"
        suppressHydrationWarning
        className="rocketx-math-display"
      />
    );
  }

  return (
    <span
      ref={inlineRef}
      data-rocketx-math="inline"
      suppressHydrationWarning
      className="rocketx-math-inline"
    />
  );
}
