/**
 * MSDS safety & awareness lexicon — English thesis-scope runtime.
 *
 * The Tagalog/Filipino lexicon is intentionally kept on the separate
 * tagalog-kws-experimental branch. Accepted English safety speech is compared
 * against this list; unmatched speech is not promoted to a safety event.
 *
 * severity:
 *   critical -> life threatening, triggers the emergency screen
 *   high     -> urgent, needs attention now
 *   medium   -> awareness / early warning
 */

export type SafetySeverity = 'critical' | 'high' | 'medium';

export type SafetyCategory =
  | 'medical'
  | 'fire'
  | 'fall'
  | 'intruder'
  | 'violence'
  | 'child'
  | 'water'
  | 'gas'
  | 'electrical'
  | 'accident'
  | 'distress'
  | 'help'
  | 'awareness';

export interface SafetyPhrase {
  /** Lowercase phrase as it would appear in a transcript. */
  phrase: string;
  lang: 'en';
  category: SafetyCategory;
  severity: SafetySeverity;
  /** 0–1 confidence that this phrase alone means real trouble. */
  confidence: number;
}

const P = (
  phrase: string,
  lang: 'en' | 'tl',
  category: SafetyCategory,
  severity: SafetySeverity,
  confidence: number,
): SafetyPhrase => ({ phrase, lang, category, severity, confidence });

/* ------------------------------------------------------------------ */
/* ENGLISH                                                             */
/* ------------------------------------------------------------------ */

const EN_HELP: SafetyPhrase[] = [
  P('help', 'en', 'help', 'high', 0.9),
  P('help me', 'en', 'help', 'critical', 0.97),
  P('help us', 'en', 'help', 'critical', 0.96),
  P('help please', 'en', 'help', 'critical', 0.96),
  P('please help', 'en', 'help', 'critical', 0.96),
  P('please help me', 'en', 'help', 'critical', 0.98),
  P('somebody help', 'en', 'help', 'critical', 0.97),
  P('someone help', 'en', 'help', 'critical', 0.97),
  P('someone help me', 'en', 'help', 'critical', 0.98),
  P('i need help', 'en', 'help', 'critical', 0.96),
  P('we need help', 'en', 'help', 'critical', 0.96),
  P('i need help now', 'en', 'help', 'critical', 0.98),
  P('need assistance', 'en', 'help', 'high', 0.88),
  P('can anyone hear me', 'en', 'help', 'high', 0.9),
  P('is anyone there', 'en', 'help', 'medium', 0.7),
  P('sos', 'en', 'help', 'critical', 0.95),
  P('mayday', 'en', 'help', 'critical', 0.95),
  P('rescue me', 'en', 'help', 'critical', 0.97),
  P('save me', 'en', 'help', 'critical', 0.97),
  P('get help', 'en', 'help', 'critical', 0.95),
  P('go get help', 'en', 'help', 'critical', 0.95),
];

const EN_EMERGENCY: SafetyPhrase[] = [
  P('emergency', 'en', 'distress', 'critical', 0.95),
  P('this is an emergency', 'en', 'distress', 'critical', 0.98),
  P('call 911', 'en', 'distress', 'critical', 0.98),
  P('call 117', 'en', 'distress', 'critical', 0.98),
  P('call the police', 'en', 'intruder', 'critical', 0.97),
  P('call police', 'en', 'intruder', 'critical', 0.97),
  P('call the cops', 'en', 'intruder', 'critical', 0.95),
  P('someone call the police', 'en', 'intruder', 'critical', 0.98),
  P('get the police', 'en', 'intruder', 'critical', 0.95),
  P('call an ambulance', 'en', 'medical', 'critical', 0.98),
  P('call the ambulance', 'en', 'medical', 'critical', 0.98),
  P('call the fire department', 'en', 'fire', 'critical', 0.98),
  P('call the barangay', 'en', 'distress', 'high', 0.9),
  P('call my family', 'en', 'distress', 'high', 0.88),
  P('call the hospital', 'en', 'medical', 'critical', 0.95),
  P('police', 'en', 'intruder', 'high', 0.85),
  P('ambulance', 'en', 'medical', 'critical', 0.95),
  P('paramedic', 'en', 'medical', 'critical', 0.93),
  P('fire department', 'en', 'fire', 'critical', 0.94),
];

const EN_MEDICAL: SafetyPhrase[] = [
  P('i cannot breathe', 'en', 'medical', 'critical', 0.98),
  P("i can't breathe", 'en', 'medical', 'critical', 0.98),
  P('hard to breathe', 'en', 'medical', 'critical', 0.95),
  P('i am choking', 'en', 'medical', 'critical', 0.98),
  P('choking', 'en', 'medical', 'critical', 0.95),
  P('chest pain', 'en', 'medical', 'critical', 0.97),
  P('my chest hurts', 'en', 'medical', 'critical', 0.97),
  P('heart attack', 'en', 'medical', 'critical', 0.98),
  P('stroke', 'en', 'medical', 'critical', 0.96),
  P('i feel dizzy', 'en', 'medical', 'high', 0.88),
  P('i am dizzy', 'en', 'medical', 'high', 0.88),
  P('i feel faint', 'en', 'medical', 'high', 0.9),
  P('i am going to faint', 'en', 'medical', 'critical', 0.94),
  P('she fainted', 'en', 'medical', 'critical', 0.96),
  P('he fainted', 'en', 'medical', 'critical', 0.96),
  P('she is unconscious', 'en', 'medical', 'critical', 0.98),
  P('he is unconscious', 'en', 'medical', 'critical', 0.98),
  P('not breathing', 'en', 'medical', 'critical', 0.98),
  P('no pulse', 'en', 'medical', 'critical', 0.98),
  P('i am bleeding', 'en', 'medical', 'critical', 0.96),
  P('bleeding a lot', 'en', 'medical', 'critical', 0.97),
  P('so much blood', 'en', 'medical', 'critical', 0.96),
  P('seizure', 'en', 'medical', 'critical', 0.96),
  P('he is seizing', 'en', 'medical', 'critical', 0.96),
  P('allergic reaction', 'en', 'medical', 'critical', 0.94),
  P('my medicine', 'en', 'medical', 'high', 0.8),
  P('i need my medicine', 'en', 'medical', 'high', 0.9),
  P('i need my inhaler', 'en', 'medical', 'critical', 0.95),
  P('asthma attack', 'en', 'medical', 'critical', 0.96),
  P('sugar is low', 'en', 'medical', 'high', 0.88),
  P('high blood', 'en', 'medical', 'high', 0.85),
  P('i am in pain', 'en', 'medical', 'high', 0.9),
  P('it hurts so much', 'en', 'medical', 'high', 0.9),
  P('i think i broke my', 'en', 'medical', 'high', 0.9),
  P('i feel sick', 'en', 'medical', 'medium', 0.75),
  P('i am not okay', 'en', 'distress', 'high', 0.85),
];

const EN_FALL: SafetyPhrase[] = [
  P('i fell', 'en', 'fall', 'critical', 0.95),
  P('i have fallen', 'en', 'fall', 'critical', 0.95),
  P('i fell down', 'en', 'fall', 'critical', 0.96),
  P('i fell and i cannot get up', 'en', 'fall', 'critical', 0.99),
  P("i can't get up", 'en', 'fall', 'critical', 0.97),
  P('i cannot get up', 'en', 'fall', 'critical', 0.97),
  P('i cannot move', 'en', 'fall', 'critical', 0.97),
  P("i can't move", 'en', 'fall', 'critical', 0.97),
  P('i slipped', 'en', 'fall', 'high', 0.9),
  P('she fell', 'en', 'fall', 'critical', 0.95),
  P('he fell', 'en', 'fall', 'critical', 0.95),
  P('grandma fell', 'en', 'fall', 'critical', 0.97),
  P('grandpa fell', 'en', 'fall', 'critical', 0.97),
  P('i am stuck', 'en', 'fall', 'high', 0.9),
  P('i am trapped', 'en', 'fall', 'critical', 0.96),
];

const EN_FIRE: SafetyPhrase[] = [
  P('fire', 'en', 'fire', 'critical', 0.95),
  P('there is a fire', 'en', 'fire', 'critical', 0.98),
  P('the house is on fire', 'en', 'fire', 'critical', 0.99),
  P('it is burning', 'en', 'fire', 'critical', 0.96),
  P('something is burning', 'en', 'fire', 'high', 0.92),
  P('i smell smoke', 'en', 'fire', 'high', 0.93),
  P('smoke', 'en', 'fire', 'high', 0.85),
  P('too much smoke', 'en', 'fire', 'critical', 0.95),
  P('get the extinguisher', 'en', 'fire', 'critical', 0.95),
  P('fire extinguisher', 'en', 'fire', 'high', 0.9),
  P('evacuate', 'en', 'fire', 'critical', 0.96),
  P('get out of the house', 'en', 'fire', 'critical', 0.96),
  P('everybody out', 'en', 'fire', 'critical', 0.95),
];

const EN_GAS_ELEC_WATER: SafetyPhrase[] = [
  P('gas leak', 'en', 'gas', 'critical', 0.97),
  P('i smell gas', 'en', 'gas', 'critical', 0.96),
  P('the lpg is leaking', 'en', 'gas', 'critical', 0.97),
  P('turn off the gas', 'en', 'gas', 'high', 0.92),
  P('turn off the stove', 'en', 'gas', 'high', 0.9),
  P('the stove is still on', 'en', 'gas', 'high', 0.9),
  P('short circuit', 'en', 'electrical', 'critical', 0.95),
  P('sparks', 'en', 'electrical', 'high', 0.9),
  P('electric shock', 'en', 'electrical', 'critical', 0.97),
  P('i got shocked', 'en', 'electrical', 'critical', 0.96),
  P('turn off the power', 'en', 'electrical', 'high', 0.9),
  P('the wire is burning', 'en', 'electrical', 'critical', 0.96),
  P('flood', 'en', 'water', 'high', 0.9),
  P('the water is rising', 'en', 'water', 'critical', 0.95),
  P('water is everywhere', 'en', 'water', 'high', 0.88),
  P('leaking water', 'en', 'water', 'medium', 0.75),
  P('drowning', 'en', 'water', 'critical', 0.98),
  P('he is drowning', 'en', 'water', 'critical', 0.99),
];

const EN_INTRUDER: SafetyPhrase[] = [
  P('thief', 'en', 'intruder', 'critical', 0.95),
  P('there is a thief', 'en', 'intruder', 'critical', 0.97),
  P('robber', 'en', 'intruder', 'critical', 0.96),
  P('robbery', 'en', 'intruder', 'critical', 0.97),
  P('burglar', 'en', 'intruder', 'critical', 0.96),
  P('someone is inside', 'en', 'intruder', 'critical', 0.95),
  P('someone is in the house', 'en', 'intruder', 'critical', 0.97),
  P('stranger outside', 'en', 'intruder', 'high', 0.88),
  P('someone is at the door', 'en', 'awareness', 'medium', 0.7),
  P('they are breaking in', 'en', 'intruder', 'critical', 0.98),
  P('he has a knife', 'en', 'violence', 'critical', 0.99),
  P('he has a gun', 'en', 'violence', 'critical', 0.99),
  P('lock the door', 'en', 'intruder', 'high', 0.85),
  P('call security', 'en', 'intruder', 'high', 0.9),
  P('intruder', 'en', 'intruder', 'critical', 0.96),
];

const EN_VIOLENCE: SafetyPhrase[] = [
  P('stop', 'en', 'violence', 'high', 0.8),
  P('please stop', 'en', 'violence', 'high', 0.92),
  P('stop it', 'en', 'violence', 'high', 0.9),
  P('leave me alone', 'en', 'violence', 'high', 0.92),
  P('get away from me', 'en', 'violence', 'critical', 0.95),
  P('do not touch me', 'en', 'violence', 'critical', 0.95),
  P("don't touch me", 'en', 'violence', 'critical', 0.95),
  P('do not hurt me', 'en', 'violence', 'critical', 0.97),
  P("don't hurt me", 'en', 'violence', 'critical', 0.97),
  P('he is hurting me', 'en', 'violence', 'critical', 0.98),
  P('she is hurting me', 'en', 'violence', 'critical', 0.98),
  P('stop hitting me', 'en', 'violence', 'critical', 0.98),
  P('let me go', 'en', 'violence', 'critical', 0.95),
  P('i am scared', 'en', 'distress', 'high', 0.88),
  P('i am afraid', 'en', 'distress', 'high', 0.85),
];

const EN_CHILD_AWARENESS: SafetyPhrase[] = [
  P('the baby is crying', 'en', 'child', 'medium', 0.75),
  P('where is the baby', 'en', 'child', 'high', 0.88),
  P('the child is missing', 'en', 'child', 'critical', 0.97),
  P('the baby fell', 'en', 'child', 'critical', 0.98),
  P('watch the child', 'en', 'child', 'medium', 0.72),
  P('be careful', 'en', 'awareness', 'medium', 0.7),
  P('watch out', 'en', 'awareness', 'high', 0.82),
  P('look out', 'en', 'awareness', 'high', 0.82),
  P('danger', 'en', 'awareness', 'high', 0.9),
  P('it is dangerous', 'en', 'awareness', 'high', 0.88),
  P('earthquake', 'en', 'accident', 'critical', 0.96),
  P('take cover', 'en', 'accident', 'critical', 0.94),
  P('accident', 'en', 'accident', 'high', 0.9),
  P('there was an accident', 'en', 'accident', 'critical', 0.95),
  P('broken glass', 'en', 'awareness', 'medium', 0.75),
  P('the floor is wet', 'en', 'awareness', 'medium', 0.7),
  P('i am locked out', 'en', 'awareness', 'medium', 0.72),
  P('i am alone', 'en', 'awareness', 'medium', 0.7),
];

/** Chapter I language scope for the panelist-compliance runtime. */
export const SAFETY_LANGUAGE_SCOPE = 'en' as const;

/**
 * English-only runtime lexicon. The Tagalog lexicon remains preserved on
 * tagalog-kws-experimental and is intentionally absent from this branch.
 */
export const SAFETY_LEXICON: SafetyPhrase[] = [
  ...EN_HELP, ...EN_EMERGENCY, ...EN_MEDICAL, ...EN_FALL, ...EN_FIRE,
  ...EN_GAS_ELEC_WATER, ...EN_INTRUDER, ...EN_VIOLENCE, ...EN_CHILD_AWARENESS,
];

const VARIANTS: Record<string, string> = {
  'help help': 'help me',
  'nine one one': 'call 911',
};

const normalize = (value: string) =>
  value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const INDEX: { key: string; entry: SafetyPhrase }[] = SAFETY_LEXICON
  .map(entry => ({ key: normalize(entry.phrase), entry }))
  .concat(
    Object.entries(VARIANTS).flatMap(([variant, target]) => {
      const entry = SAFETY_LEXICON.find(e => normalize(e.phrase) === normalize(target));
      return entry ? [{ key: normalize(variant), entry }] : [];
    }),
  )
  // Longest English phrases first so a specific emergency phrase wins over a shorter token.
  .sort((a, b) => b.key.length - a.key.length);

export interface SafetyMatch {
  matched: boolean;
  phrase: string;
  category: SafetyCategory | null;
  severity: SafetySeverity | null;
  lang: 'en' | null;
  confidence: number;
  /** Every distinct lexicon phrase found in the text. */
  all: SafetyPhrase[];
}

export const NO_MATCH: SafetyMatch = {
  matched: false, phrase: '', category: null, severity: null, lang: null, confidence: 0, all: [],
};

/** Find every safety phrase present in a transcript; strongest one wins. */
export function matchSafetyPhrase(transcript: string): SafetyMatch {
  const text = ` ${normalize(transcript)} `;
  if (text.trim().length === 0) return NO_MATCH;

  const found: SafetyPhrase[] = [];
  const seen = new Set<string>();
  for (const { key, entry } of INDEX) {
    if (!key || seen.has(entry.phrase)) continue;
    if (text.includes(` ${key} `)) {
      seen.add(entry.phrase);
      found.push(entry);
    }
  }
  if (found.length === 0) return NO_MATCH;

  const rank: Record<SafetySeverity, number> = { critical: 3, high: 2, medium: 1 };
  const best = found.reduce((a, b) =>
    rank[b.severity] > rank[a.severity] || (rank[b.severity] === rank[a.severity] && b.confidence > a.confidence)
      ? b : a);

  return {
    matched: true,
    phrase: best.phrase,
    category: best.category,
    severity: best.severity,
    lang: best.lang,
    confidence: best.confidence,
    all: found,
  };
}

/** True when the transcript contains speech that needs an emergency response. */
export const isEmergencySpeech = (transcript: string) =>
  matchSafetyPhrase(transcript).severity === 'critical';

/** Total number of phrases in the library — shown in the UI/diagnostics. */
export const SAFETY_LEXICON_SIZE = SAFETY_LEXICON.length;

/**
 * Wake words: the safety-only subset. Everyday awareness chatter ("be careful",
 * "someone is at the door") never wakes the system — only urgent, safety
 * phrases such as help, help me, police, call the police, fire, and emergency do.
 */
export const SAFETY_WAKE_WORDS: SafetyPhrase[] = SAFETY_LEXICON.filter(
  p => p.severity === 'critical' || p.severity === 'high',
);

export const SAFETY_WAKE_WORD_COUNT = SAFETY_WAKE_WORDS.length;

/** Match a transcript against the safety-only wake-word subset. */
export function matchWakeWord(transcript: string): SafetyMatch {
  const match = matchSafetyPhrase(transcript);
  if (!match.matched) return NO_MATCH;
  const urgent = match.all.filter(p => p.severity === 'critical' || p.severity === 'high');
  if (urgent.length === 0) return NO_MATCH;
  const rank: Record<SafetySeverity, number> = { critical: 3, high: 2, medium: 1 };
  const best = urgent.reduce((a, b) =>
    rank[b.severity] > rank[a.severity] || (rank[b.severity] === rank[a.severity] && b.confidence > a.confidence)
      ? b : a);
  return {
    matched: true,
    phrase: best.phrase,
    category: best.category,
    severity: best.severity,
    lang: best.lang,
    confidence: best.confidence,
    all: urgent,
  };
}
