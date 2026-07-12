/** emoji 短代码表：短代码需与 Rocket.Chat（emojione 命名）一致，chat.react 直接用 */
export interface EmojiEntry {
  code: string;
  char: string;
}

export const EMOJI_LIST: EmojiEntry[] = [
  { code: 'grinning', char: '😀' },
  { code: 'smile', char: '😄' },
  { code: 'laughing', char: '😆' },
  { code: 'joy', char: '😂' },
  { code: 'blush', char: '😊' },
  { code: 'heart_eyes', char: '😍' },
  { code: 'kissing_heart', char: '😘' },
  { code: 'stuck_out_tongue_winking_eye', char: '😜' },
  { code: 'thinking', char: '🤔' },
  { code: 'sunglasses', char: '😎' },
  { code: 'upside_down', char: '🙃' },
  { code: 'sleeping', char: '😴' },
  { code: 'cry', char: '😢' },
  { code: 'sob', char: '😭' },
  { code: 'rage', char: '😡' },
  { code: 'scream', char: '😱' },
  { code: 'exploding_head', char: '🤯' },
  { code: 'pleading_face', char: '🥺' },
  { code: 'partying_face', char: '🥳' },
  { code: 'wave', char: '👋' },
  { code: 'thumbsup', char: '👍' },
  { code: 'thumbsdown', char: '👎' },
  { code: 'ok_hand', char: '👌' },
  { code: 'pray', char: '🙏' },
  { code: 'clap', char: '👏' },
  { code: 'muscle', char: '💪' },
  { code: 'handshake', char: '🤝' },
  { code: 'v', char: '✌️' },
  { code: 'eyes', char: '👀' },
  { code: 'raised_hands', char: '🙌' },
  { code: 'heart', char: '❤️' },
  { code: 'broken_heart', char: '💔' },
  { code: 'tada', char: '🎉' },
  { code: 'confetti_ball', char: '🎊' },
  { code: 'star', char: '⭐' },
  { code: 'fire', char: '🔥' },
  { code: '100', char: '💯' },
  { code: 'sparkles', char: '✨' },
  { code: 'rocket', char: '🚀' },
  { code: 'zap', char: '⚡' },
  { code: 'white_check_mark', char: '✅' },
  { code: 'x', char: '❌' },
  { code: 'warning', char: '⚠️' },
  { code: 'question', char: '❓' },
  { code: 'exclamation', char: '❗' },
  { code: 'bulb', char: '💡' },
  { code: 'pushpin', char: '📌' },
  { code: 'calendar', char: '📅' },
  { code: 'alarm_clock', char: '⏰' },
  { code: 'bell', char: '🔔' },
];

export const EMOJI_MAP: Record<string, string> = Object.fromEntries(
  EMOJI_LIST.map((e) => [e.code, e.char]),
);
// 常见别名
EMOJI_MAP['+1'] = '👍';
EMOJI_MAP['-1'] = '👎';
EMOJI_MAP['grin'] = '😀';
EMOJI_MAP['slight_smile'] = '🙂';

export function emojiFromShortcode(code: string): string {
  const name = code.replace(/:/g, '');
  return EMOJI_MAP[name] ?? `:${name}:`;
}
