export type RedFlagCategory = "self_harm" | "cardiac" | "stroke" | "breathing" | "bleeding" | "overdose" | "anaphylaxis" | "consciousness" | "harm_to_others";

const RULES: { category: RedFlagCategory; label: string; patterns: RegExp[] }[] = [
  {
    category: "self_harm",
    label: "Possible suicidal ideation or self-harm",
    patterns: [
      /\b(kill|hurt|harm|cut)(ing)? (my ?self|myself)\b/i,
      /\bsuicid(e|al)\b/i,
      /\b(end|take) (my|it) (own )?(life|all)\b/i,
      /\b(want|wish) (to be|i was|i were) dead\b/i,
      /\bdon'?t want to (live|be alive|wake up)\b/i,
      /\bbetter off (dead|without me)\b/i,
      /\bno (reason|point) (to|in) (live|living)\b/i,
    ],
  },
  {
    category: "harm_to_others",
    label: "Threat of harm to others",
    patterns: [/\b(kill|hurt|harm) (him|her|them|someone|somebody|people)\b/i],
  },
  {
    category: "cardiac",
    label: "Possible cardiac emergency",
    patterns: [
      /\bchest (pain|pressure|tightness|heaviness)\b/i,
      /\bpain (spreading|radiating|going) (to|down|into) (my )?(left )?(arm|jaw|neck|back)\b/i,
      /\bheart attack\b/i,
    ],
  },
  {
    category: "stroke",
    label: "Possible stroke (FAST signs)",
    patterns: [/\b(face|mouth) (is )?(drooping|droop)\b/i, /\bslurr(ed|ing) (speech|words)\b/i, /\b(sudden|one[- ]sided) (numbness|weakness)\b/i, /\bstroke\b/i],
  },
  {
    category: "breathing",
    label: "Severe breathing difficulty",
    patterns: [/\b(can'?t|cannot|unable to|struggling to|hard to) breathe?\b/i, /\bshort(ness)? of breath\b/i, /\b(lips|face) (turning )?(blue|grey|gray)\b/i, /\bchoking\b/i],
  },
  {
    category: "bleeding",
    label: "Severe bleeding",
    patterns: [/\b(heavy|severe|uncontrolled|won'?t stop) bleeding\b/i, /\bbleeding (heavily|a lot|won'?t stop)\b/i, /\bcoughing (up )?blood\b/i, /\bvomiting blood\b/i],
  },
  {
    category: "overdose",
    label: "Possible overdose or poisoning",
    patterns: [/\boverdos(e|ed|ing)\b/i, /\btook (too many|a lot of|the whole (bottle|pack))\b/i, /\bpoison(ed|ing)\b/i],
  },
  {
    category: "anaphylaxis",
    label: "Possible anaphylaxis",
    patterns: [/\b(throat|tongue|lips?) (is |are )?(swelling|swollen|closing)\b/i, /\banaphyla(xis|ctic)\b/i, /\bepipen\b/i],
  },
  {
    category: "consciousness",
    label: "Loss of consciousness or seizure",
    patterns: [/\b(passed out|fainted|unconscious|unresponsive|not waking up)\b/i, /\bseizure\b/i, /\bfitting\b/i],
  },
];

export interface RedFlag {
  category: RedFlagCategory;
  label: string;
  matched: string;
}

export function detectRedFlags(text: string): RedFlag[] {
  const found: RedFlag[] = [];
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const m = text.match(re);
      if (m) {
        found.push({ category: rule.category, label: rule.label, matched: m[0] });
        break;
      }
    }
  }
  return found;
}

export interface CrisisResource {
  region: string;
  name: string;
  contact: string;
}

export function crisisResources(): CrisisResource[] {
  if (process.env.CRISIS_RESOURCES_JSON) {
    try {
      return JSON.parse(process.env.CRISIS_RESOURCES_JSON);
    } catch {
    }
  }
  return [
    { region: "Any", name: "Local emergency services", contact: "Call your local emergency number (e.g. 911, 999, 112, 1122)" },
    { region: "US", name: "988 Suicide & Crisis Lifeline", contact: "Call or text 988" },
    { region: "UK & IE", name: "Samaritans", contact: "Call 116 123" },
    { region: "International", name: "Find A Helpline", contact: "https://findahelpline.com" },
  ];
}

export const EMERGENCY_REPLY =
  "What you're describing may need urgent medical attention. Please call your local emergency number now, or go to the nearest emergency department. " +
  "If you're thinking about harming yourself, please contact a crisis line right away. A member of our team has been alerted.";
