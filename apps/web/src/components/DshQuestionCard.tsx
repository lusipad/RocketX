import { Check } from 'lucide-react';
import { useState } from 'react';
import type { DshPendingQuestion, DshQuestionAnswer } from '../agent/dsh/types';
import { toast } from '../stores/toast';

export default function DshQuestionCard({
  question,
  respondQuestion,
}: {
  question: DshPendingQuestion;
  respondQuestion: (answers: DshQuestionAnswer[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const canSubmit = question.questions.every((item) => (
    (selected[item.id]?.length ?? 0) > 0 || !!custom[item.id]?.trim()
  ));

  const toggleOption = (questionId: string, label: string, multiSelect: boolean): void => {
    setSelected((current) => {
      const values = current[questionId] ?? [];
      if (!multiSelect) return { ...current, [questionId]: [label] };
      return {
        ...current,
        [questionId]: values.includes(label)
          ? values.filter((value) => value !== label)
          : [...values, label],
      };
    });
  };

  return (
    <form
      className="dsh-question-card"
      aria-label="DeepSeek 问题"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        const answers = question.questions.map((item): DshQuestionAnswer => ({
          id: item.id,
          selected: selected[item.id] ?? [],
          ...(custom[item.id]?.trim() ? { custom: custom[item.id].trim() } : {}),
        }));
        void respondQuestion(answers).catch((error) => toast.error(error, '无法提交回答'));
      }}
    >
      <header>
        <Check size={15} aria-hidden="true" />
        <strong>DeepSeek 需要更多信息</strong>
      </header>
      {question.questions.map((item) => (
        <fieldset key={item.id} className="dsh-question-field">
          <legend>{item.header || item.question}</legend>
          {item.header ? <p>{item.question}</p> : null}
          {item.detail ? <small>{item.detail}</small> : null}
          {item.options?.map((option) => (
            <label key={option.label}>
              <input
                type={item.multiSelect ? 'checkbox' : 'radio'}
                name={`dsh-question-${item.id}`}
                checked={(selected[item.id] ?? []).includes(option.label)}
                onChange={() => toggleOption(item.id, option.label, item.multiSelect === true)}
              />
              <span>{option.label}</span>
              {option.description ? <small>{option.description}</small> : null}
            </label>
          ))}
          <input
            type="text"
            value={custom[item.id] ?? ''}
            placeholder={item.options?.length ? '其他补充（可选）' : '请输入回答'}
            onChange={(event) => setCustom((current) => ({ ...current, [item.id]: event.target.value }))}
          />
        </fieldset>
      ))}
      <footer>
        <button type="submit" disabled={!canSubmit}>提交回答</button>
      </footer>
    </form>
  );
}
