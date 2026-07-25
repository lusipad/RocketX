export interface ButlerScenePrompt {
  scene: string;
  prompt: string;
}

/**
 * 空状态的场景例句：回答「我能问它什么」。
 *
 * 硬编码而不是从技能描述派生——技能描述写的是「技能是什么」，不是「用户怎么问」，
 * 而且找文件这类场景根本没有对应技能。人名/编号是占位符，点击只填进输入框不直接发送。
 * 选材来自 docs/m12-implementation-plan.md 的七类真实任务场景里可以变成提问的那几类。
 */
export const BUTLER_SCENE_PROMPTS: readonly ButlerScenePrompt[] = [
  { scene: '找文件', prompt: '昨天张三在群里发的那个文件是哪个？' },
  { scene: '比较 PR', prompt: '比较这两个 PR：#101 和 #102，说说改动、风险和评审顺序。' },
  { scene: '提取承诺', prompt: '提取研发群这周消息里的承诺：谁答应了什么、什么时候兑现。' },
  { scene: '跟进逾期', prompt: '我名下有哪些工作项已经逾期了？' },
  { scene: '查构建', prompt: '最近哪个构建挂了？为什么？' },
];

/** 空状态的一句话能力边界：信任是用「它不会做什么」建立的。 */
export const BUTLER_BOUNDARY_NOTE = '我只读你本来就能看到的东西；动手之前一定先问你。';

/**
 * 「交给管家」入口的固定提问。
 *
 * **这两句是硬约束不是文案偏好**：必须命中 butlerTaskContext 的场景正则
 * （extract-commitments 的 /(?:提取|整理|查找).*(?:承诺|答应|跟进项)/），
 * 否则管家会先反问「要从哪个群聊提取承诺」白跑一轮。改字前先跑
 * butler-scene-prompts 回归。
 */
export const BUTLER_EXTRACT_COMMITMENTS_PROMPT =
  '提取这些消息里的承诺：谁答应了什么、什么时候兑现。';

export const BUTLER_SUMMARIZE_PROMPT = '总结这段对话的结论和待办。';

/**
 * 「和另一个比较」的提问。
 *
 * 两个前置条件缺一不可，否则管家会反问「请给出要比较的两个 PR 编号」：
 * ① 文本命中 /(?:比较|对比).*(?:PR|拉取请求)/；
 * ② 上下文里有 ≥2 个 pull-request 来源。编号同时写进正文是双保险。
 */
export function butlerComparePullRequestsPrompt(first: number, second: number): string {
  return `比较这两个 PR：#${first} 和 #${second}，说说改动、风险和评审顺序。`;
}
