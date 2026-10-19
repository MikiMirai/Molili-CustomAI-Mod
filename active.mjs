/**
 * active.mjs — the character's own messages ("active messages") when you have not written for a while.
 *
 * The game's setting "Active Message Frequency" (randomMsgFrequency in the account settings) picks the level:
 *   STD = Normal, HIGH = Higher, FREQ = High.  The game has no setting for how many messages, so that is ACTIVE_MAX_MESSAGES.
 * One burst at most per silence: after a burst, the next one waits for your next message.
 */

const LEVEL_OF = { STD: 'NORMAL', HIGH: 'HIGHER', FREQ: 'HIGH' };

/** the game's setting, STD when it is missing or unknown */
export function frequencyOf(configs) {
  const v = configs?.randomMsgFrequency?.propVal;
  return LEVEL_OF[v] ? v : 'STD';
}

/** hours of silence before a burst, from the mod's own settings (keys ACTIVE_HOURS_NORMAL / _HIGHER / _HIGH) */
export function hoursFor(freq, cfg) {
  const key = { STD: 'ACTIVE_HOURS_NORMAL', HIGH: 'ACTIVE_HOURS_HIGHER', FREQ: 'ACTIVE_HOURS_HIGH' }[freq];
  const n = Number(cfg(key));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** due when you have been silent for `hours` since your last message, and no burst was sent for that silence */
export function activeDue({ now, lastUserTs, sentFor, hours }) {
  if (!lastUserTs || !(hours > 0)) return false;
  if (sentFor === lastUserTs) return false;
  return now - lastUserTs >= hours * 3600e3;
}

/** the instruction the model gets for one burst */
export function burstInstruction({ hours, count, you, timeOfDay }) {
  return `You have not heard from ${you} for about ${Math.round(hours)} hours. Write ${count} short message${count > 1 ? 's' : ''} that you send on your own, `
    + `one per line, 1 or 2 sentences each. Say you miss them or wonder where they are, and mention something you were doing `
    + `and the time of day where you are (${timeOfDay}). Do not quote anything, do not use labels, numbers or bullet points.`;
}

/** clean the model's text into chat lines: no thinking, no quote/label prefixes, no empty or repeated lines */
export function parseBurst(raw, max) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think>[\s\S]*$/i, '');
  const seen = new Set(), out = [];
  for (let line of text.split('\n')) {
    line = line.replace(/\[(?:EX_[A-Z_]+|DEFAULT)\]\s*/gi, '')        // mood tags: the chat reads them as expressions, not text
      .replace(/^\s*(?:quote\s*>\s*|>\s*)+/i, '')          // "quote>" and markdown quote marks
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')                       // bullets and numbering
      .replace(/^\s*(?:Kotonoha|Molili|Character|Assistant)\s*:\s*/i, '')
      .replace(/^["“「]\s*|\s*["”」]$/g, '')
      .trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line.length > 200 ? line.slice(0, 200) : line);
    if (out.length >= max) break;
  }
  return out;
}
