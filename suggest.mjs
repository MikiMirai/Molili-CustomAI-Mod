// suggest.mjs — smart replies: short lines the player could say next, made by LM Studio.
// The game asks for them after a reply (POST chatApi/v1/suggest/latest) and shows them as clickable
// text. The game's "smart reply" switch is the setting enableFollowUp; when it is off the list is empty.

export const MAX_SUGGESTIONS = 3;
const MAX_LEN = 80;

/** true when the game's smart-reply switch is on (the value the game stores with updateSettingsConfig) */
export function followUpEnabled(configs) {
  const v = configs?.enableFollowUp?.propVal;
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** Prompt for LM Studio: the last few turns, and the request for short player lines. */
export function buildSuggestMessages(context, { name = '' } = {}) {
  const recent = context.slice(-8);
  const lastUser = [...recent].reverse().find(m => m.role === 'user');
  const lang = lastUser ? `in the same language the player uses (${lastUser.content.slice(0, 120)})` : 'in English';
  const transcript = recent.map(m => `${m.role === 'user' ? 'Player' : (name || 'Character')}: ${m.content}`).join('\n');
  return [
    { role: 'system', content: 'You write the next lines the player could send in a chat with a character. ' +
      'Each line is short (under 12 words), natural, and says something different from the others. ' +
      'Output only the lines, one per line, with no numbers, bullets, quotes or explanations.' },
    { role: 'user', content: `Conversation so far:\n${transcript}\n\nWrite ${MAX_SUGGESTIONS} short lines the player could say next, ${lang}.` },
  ];
}

/** Turns the model's text into up to MAX_SUGGESTIONS clean lines. Anything that is not a usable line is dropped. */
export function parseSuggestions(raw) {
  let text = String(raw ?? '');
  if (/<think>/i.test(text) && !/<\/think>/i.test(text)) return [];   // unfinished reasoning: nothing usable
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
      .replace(/^[-*•]\s+/, '')                 // bullets
      .replace(/^\d+[.)]\s+/, '')               // "1. " or "1) "
      .replace(/^["'“‘]+|["'”’]+$/g, '')        // surrounding quotes
      .trim();
    if (!line || line.length > MAX_LEN) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}
