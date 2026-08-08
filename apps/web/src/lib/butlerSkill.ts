export interface ButlerSkill {
  name: string;
  description: string;
  body: string;
  /** Checked-in SKILL.md source for bundled Skills. User-authored Skills are rendered from fields. */
  source?: string;
}
