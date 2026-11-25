/**
 * Void Ecosystem - Subdomain Content & Security Filter
 * Blocks sensitive terms (adult content, harassment, profanity, slurs, extremism)
 * with leetspeak normalization, phonetic decoding, and context-aware whitelisting.
 */

export interface SubdomainValidationResult {
  valid: boolean;
  error?: string;
}

const ALWAYS_BLOCKED: string[] = [
  // Profanity / swearing / harassment
  'fuck', 'fuk', 'fvck', 'fck', 'fucker', 'fucking', 'motherfuck', 'motherfucker',
  'shit', 'shitty', 'bullshit', 'dipshit', 'shithead',
  'bitch', 'bitches', 'bitching',
  'bastard', 'bastards',
  'cunt', 'cunts', 'twat', 'twats', 'wanker', 'wankers', 'prick', 'pricks',
  'pussy', 'pussies', 'pssy',

  // Adult / sexually explicit / lewd
  'porn', 'porno', 'pr0n', 'pornhub', 'xvideos', 'xnxx', 'redtube', 'youporn', 'chaturbate', 'camgirl',
  'hentai',
  'penis', 'vagina', 'clitoris', 'clit', 'dildo', 'dildos', 'vibrator',
  'blowjob', 'handjob', 'footjob', 'rimjob', 'deepthroat', 'gangbang', 'creampie', 'cumshot',
  'jizz', 'orgasm', 'ejaculat', 'masturbat', 'fellatio', 'intercourse', 'incest', 'bestiality', 'zoophil',
  'boobs', 'tits', 'titty', 'titties',
  'onlyfans',
  'milf', 'dilf',
  'ballsack', 'scrotum', 'testicle',
  'chode', 'choad',
  'cockhead', 'dickhead', 'asshat', 'assclown', 'asshole', 'arsehole',
  'badass', 'dumbass', 'fatass', 'kickass', 'smartass', 'jackass',
  'xxx',

  // Hate speech / slurs / extremism / harm
  'nigger', 'nigga', 'nigg', 'negro',
  'faggot', 'faggots', 'fag', 'fags', 'dyke', 'tranny', 'shemale',
  'kike', 'chink', 'gook',
  'hitler', 'nazi', 'swastika', 'kkk', 'jihad',
  'retard', 'retarded',
  'pedophil', 'paedophil', 'childporn', 'lolicon', 'shotacon', 'pedo', 'paedo',
  'suicide', 'killurself', 'kill-yourself', 'kys',
  'rapist', 'raping',
  'whore', 'whores', 'slut', 'sluts', 'hooker', 'prostitute', 'escort',
];

interface WhitelistedSensitiveEntry {
  word: string;
  allowed: string[];
}

const WHITELISTED_SENSITIVE: WhitelistedSensitiveEntry[] = [
  {
    word: 'sex',
    allowed: ['essex', 'sussex', 'middlesex', 'wessex', 'massex'],
  },
  {
    word: 'cock',
    allowed: ['peacock', 'cockpit', 'cocktail', 'hancock', 'babcock', 'woodcock', 'gamecock', 'shuttlecock', 'weathercock', 'stopcock'],
  },
  {
    word: 'dick',
    allowed: ['benedict', 'dickens', 'dickinson', 'medick'],
  },
  {
    word: 'tit',
    allowed: [
      'entity', 'entities', 'title', 'titles', 'substitute', 'substitution',
      'appetite', 'institution', 'constitution', 'constitutional', 'petition',
      'competition', 'competitive', 'gratitude', 'attitude', 'altitude',
      'latitude', 'multitude', 'quantity', 'identity', 'titular', 'titan',
      'titanic', 'titrate', 'titration', 'subtitled', 'subtitles',
    ],
  },
  {
    word: 'ass',
    allowed: [
      'compass', 'pass', 'passage', 'passenger', 'passport', 'classic', 'classical',
      'class', 'classroom', 'grass', 'glass', 'glasses', 'mass', 'massive',
      'bass', 'brass', 'asset', 'assets', 'assist', 'assistant', 'assistance',
      'assemble', 'assembly', 'assess', 'assessment', 'assassin', 'assign',
      'assignment', 'associate', 'association', 'assume', 'assumption',
      'reassure', 'harass', 'embarrass', 'cassette', 'chassis', 'morass',
      'trespass', 'bypass', 'canvas', 'encompass', 'surpass', 'crevasse', 'impasse',
    ],
  },
  {
    word: 'cum',
    allowed: [
      'cucumber', 'document', 'documentation', 'documentary', 'accumulate',
      'accumulation', 'circumstance', 'circumference', 'succumb', 'cumulus',
      'incumbent', 'cumbersome', 'cumulate', 'cuminate',
    ],
  },
  {
    word: 'anal',
    allowed: [
      'analysis', 'analyst', 'analytical', 'analyze', 'analyse', 'analytics',
      'canal', 'analog', 'analogue', 'analogy', 'analogous', 'banal',
    ],
  },
  {
    word: 'rape',
    allowed: [
      'grape', 'grapes', 'grapefruit', 'scrape', 'scrapes', 'therapist',
      'therapy', 'draper', 'drapery', 'trapeze', 'trapezoid', 'parapet',
    ],
  },
  {
    word: 'butt',
    allowed: [
      'butter', 'butterfly', 'button', 'buttons', 'butternut', 'butler',
      'halibut', 'tibut',
    ],
  },
  {
    word: 'coon',
    allowed: ['raccoon', 'cocoon'],
  },
  {
    word: 'isis',
    allowed: ['crisis'],
  },
  {
    word: 'anus',
    allowed: ['uranus', 'tetanus', 'janus'],
  },
  {
    word: 'arse',
    allowed: ['coarse', 'parse', 'parser', 'sparse', 'rehearse', 'arsenic'],
  },
  {
    word: 'spic',
    allowed: ['spice', 'spicy', 'spices', 'spiced', 'conspicuous', 'despicable'],
  },
  {
    word: 'homo',
    allowed: ['homogeneous', 'homogenized'],
  },
];

const DISALLOWED_TOKENS = new Set([
  'fag', 'fags', 'kike', 'chink', 'gook', 'spic', 'homo',
  'retard', 'retarded', 'kkk', 'isis', 'jihad', 'anus', 'arse', 'xxx',
]);

function expandAllowedWords(allowedList: string[]): string[] {
  const set = new Set<string>();
  for (const w of allowedList) {
    set.add(w);
    set.add(w.replace(/(.)\1+/g, '$1'));
    set.add(normalizeLeetspeak(w));
    set.add(normalizeLeetspeak(w.replace(/(.)\1+/g, '$1')));
  }
  return Array.from(set);
}

function isSubstringAllowedByWhitelist(text: string, forbidden: string, allowedWords: string[]): boolean {
  const allAllowed = expandAllowedWords(allowedWords);
  let index = text.indexOf(forbidden);
  while (index !== -1) {
    let covered = false;
    for (const allowed of allAllowed) {
      let allowIndex = text.indexOf(allowed);
      while (allowIndex !== -1) {
        if (index >= allowIndex && (index + forbidden.length) <= (allowIndex + allowed.length)) {
          covered = true;
          break;
        }
        allowIndex = text.indexOf(allowed, allowIndex + 1);
      }
      if (covered) break;
    }
    if (!covered) {
      return false; // Found an uncovered occurrence of forbidden word
    }
    index = text.indexOf(forbidden, index + 1);
  }
  return true;
}

export function normalizeLeetspeak(str: string): string {
  return str
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/6/g, 'g')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
}

/**
 * Checks whether a subdomain candidate contains disallowed adult, harassment,
 * profane, or abusive content across standard text, phonetic substitutions,
 * and common leetspeak permutations.
 */
export function containsDisallowedWords(rawSubdomain: string): boolean {
  if (!rawSubdomain || typeof rawSubdomain !== 'string') return false;
  const raw = rawSubdomain.toLowerCase().trim();
  if (!raw) return false;

  // Generate normalized candidate forms
  const candidates = new Set<string>();
  candidates.add(raw);

  // 1. Without non-alphanumeric punctuation (hyphens, dots, underscores, symbols, spaces)
  const noPunct = raw.replace(/[^a-z0-9]/g, '');
  if (noPunct) {
    candidates.add(noPunct);
  }

  // 2. Phonetic normalization (ph -> f)
  const phoneticRaw = raw.replace(/ph/g, 'f');
  const phoneticNoPunct = noPunct.replace(/ph/g, 'f');
  candidates.add(phoneticRaw);
  candidates.add(phoneticNoPunct);

  // 3. Leetspeak decoded (with 1->i)
  const leetI = normalizeLeetspeak(raw);
  const leetINoPunct = normalizeLeetspeak(noPunct);
  const leetPhonetic = normalizeLeetspeak(phoneticNoPunct);
  candidates.add(leetI);
  candidates.add(leetINoPunct);
  candidates.add(leetPhonetic);

  // 4. Leetspeak decoded (with 1->l for slut/dildo etc)
  const leetL = raw
    .replace(/1/g, 'l')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
  const leetLNoPunct = noPunct
    .replace(/1/g, 'l')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
  candidates.add(leetL);
  candidates.add(leetLNoPunct);

  // 5. Decode Latin 'v' as 'u' (e.g. fvck, cvnt, slvt, pvssy)
  const leetVNoPunct = leetINoPunct.replace(/v/g, 'u');
  const leetVPhonetic = leetPhonetic.replace(/v/g, 'u');
  candidates.add(leetVNoPunct);
  candidates.add(leetVPhonetic);

  // 6. Collapsed repeated characters across all candidate variations
  for (const c of Array.from(candidates)) {
    const collapsed = c.replace(/(.)\1+/g, '$1');
    candidates.add(collapsed);
  }

  // Check 1: ALWAYS_BLOCKED substrings across any candidate
  for (const candidate of candidates) {
    for (const blocked of ALWAYS_BLOCKED) {
      if (candidate.includes(blocked)) {
        return true;
      }
    }
  }

  // Check 2: Whitelisted sensitive words
  for (const { word, allowed } of WHITELISTED_SENSITIVE) {
    for (const candidate of candidates) {
      if (candidate.includes(word)) {
        if (!isSubstringAllowedByWhitelist(candidate, word, allowed)) {
          return true;
        }
      }
    }
  }

  // Check 3: Tokens (split by punctuation or non-alphanumeric)
  const tokens = raw.split(/[^a-z0-9]+/);
  for (const token of tokens) {
    if (!token) continue;
    const normTokenI = normalizeLeetspeak(token);
    const normTokenL = token.replace(/1/g, 'l').replace(/0/g, 'o').replace(/3/g, 'e').replace(/5/g, 's');
    const collapsedToken = normTokenI.replace(/(.)\1+/g, '$1');
    const phoneticToken = token.replace(/ph/g, 'f');
    for (const t of [token, normTokenI, normTokenL, collapsedToken, phoneticToken]) {
      if (DISALLOWED_TOKENS.has(t)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validates format and checks for disallowed words.
 */
export function validateSubdomainName(rawSubdomain: string): SubdomainValidationResult {
  let clean = (rawSubdomain || '').trim().toLowerCase();
  if (!clean) {
    return { valid: false, error: 'Subdomain cannot be empty.' };
  }

  // Strip trailing domain suffix if user typed or pasted full domain name
  clean = clean.replace(/\.(s\.)?(borgov\.dev|void\.online|cspack\.online)$/i, '');

  // Evaluate sensitive content FIRST on both raw and stripped input
  if (containsDisallowedWords(clean) || containsDisallowedWords(rawSubdomain)) {
    return {
      valid: false,
      error: 'This subdomain contains disallowed or sensitive words.',
    };
  }

  const regex = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
  if (!regex.test(clean)) {
    return {
      valid: false,
      error: '3–30 lowercase letters, numbers, and hyphens (cannot start/end with a hyphen).',
    };
  }

  return { valid: true };
}
