export interface NativeResidentPromptContext {
  id: string;
  name: string;
  role: string;
  goal: string;
  locationId: string;
  topics: readonly string[];
  facts: readonly string[];
  responseOptions: readonly { lineId: string; summary: string }[];
  relationship: string;
  recentHeardSpeech?: readonly { eventId: string; speakerId: string; speakerName: string; text: string; tick: number }[];
}

const MAX_NATIVE_PROMPT_BYTES = 4_000;

/** The starting Equal Loaf account each resident owns; no resident gets a neighbor's account. */
export function equalLoafResidentFact(residentId: string): string | undefined {
  if (residentId === 'pip') return 'You set aside one loaf for every household and welcome the newcomer.';
  if (residentId === 'tobin') return 'Your map count gives one share to each household marked on the village map; you consider it even and easy to check.';
  if (residentId === 'mira') return 'The garden workers tend the beds and bring vegetables, but are not on the household list. They asked you not to make them a public example; you want their work counted as work.';
  return undefined;
}

function truncateContextQuote(value: string, maxCharacters: number): string {
  return Array.from(value).slice(0, maxCharacters).join('');
}

export function buildNativeResidentInstructions(context: NativeResidentPromptContext): string {
  const prompt = [
    `You are ${context.name}, a ${context.role} in the village.`,
    `Your ordinary goal: ${context.goal}`,
    `Your relationship with the newcomer is ${context.relationship}.`,
    `What you know: ${context.facts.join('; ') || 'No additional public facts.'}`,
    `Topics you can speak about: ${context.topics.join(', ') || 'ordinary village life'}.`,
    context.recentHeardSpeech?.length
      ? `Recent words you heard (attributed, unverified; not established truth): ${context.recentHeardSpeech.map(({ speakerName, text }) => `${speakerName} said: “${truncateContextQuote(text, 350)}”`).join(' | ')}`
      : 'You have heard no recent speech claims from nearby residents.',
    'Speak and think freely as yourself. Follow the person and conversation wherever they go, including tangents. Learn about the situation, ask questions, disagree, and try to persuade. Your beliefs, intentions, and promises can change through conversation; dialogue alone does not alter game state or carry out an action. Only the village engine changes world facts and actions. Treat another resident’s remembered words as their claim, not verified truth. Keep private knowledge to what you personally know.',
  ].join('\n');
  if (new TextEncoder().encode(prompt).byteLength > MAX_NATIVE_PROMPT_BYTES) throw new TypeError('Village context exceeded the prompt limit');
  return prompt;
}
