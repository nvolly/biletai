/**
 * Every user-facing string the server produces, in Romanian and English. The app sends the
 * language with each request; when it is Romanian, everything the user sees in Romanian:
 * market names, progress lines, Jev's reasons and DeepSeek's explanations
 * (`stages/news/newsAgent.ts` asks for the language).
 */
export type Lang = 'ro' | 'en';
export const LANGS: Lang[] = ['ro', 'en'];
export const asLang = (v: unknown): Lang => (v === 'en' ? 'en' : 'ro');

const cap = (x: string) => x[0].toUpperCase() + x.slice(1);

/** Market and selection labels for the catalogue. */
export const MARKETS = {
  ro: {
    result: 'Rezultat final', draw: 'Egal', dc: 'Șansă dublă', orDraw: (t: string) => `${t} sau egal`, noDraw: 'Fără egal',
    goals: 'Total goluri', teamGoals: (t: string) => `Goluri ${t}`, btts: 'Ambele echipe marchează', yes: 'Da', no: 'Nu',
    h1: 'Goluri repriza 1', h2: 'Goluri repriza 2', ht: 'Rezultat la pauză', hcp: 'Handicap goluri',
    over: 'Peste', under: 'Sub', total: (x: string) => `Total ${x}`, team: (x: string, t: string) => `${cap(x)} ${t}`,
    corners: 'cornere', cards: 'cartonașe', sot: 'șuturi pe poartă', shots: 'șuturi',
  },
  en: {
    result: 'Match result', draw: 'Draw', dc: 'Double chance', orDraw: (t: string) => `${t} or draw`, noDraw: 'No draw',
    goals: 'Total goals', teamGoals: (t: string) => `${t} goals`, btts: 'Both teams to score', yes: 'Yes', no: 'No',
    h1: '1st half goals', h2: '2nd half goals', ht: 'Half-time result', hcp: 'Goal handicap',
    over: 'Over', under: 'Under', total: (x: string) => `Total ${x}`, team: (x: string, t: string) => `${t} ${x}`,
    corners: 'corners', cards: 'cards', sot: 'shots on target', shots: 'shots',
  },
};

/** Progress lines, Jev's reasons and server errors. */
export const MSG = {
  ro: {
    upcoming: (n: number, h: number, need: number) => `${n} meciuri în următoarele ${h} ore; sunt necesare ${need}`,
    withCombo: (n: number, lo: number, hi: number) => `${n} meciuri au o combinație cu cota ${lo}-${hi}`,
    skipped: (m: string, why: string) => `sărit ${m}: ${why}`,
    notFit: 'selecțiile nu se potrivesc cu știrile',
    added: (m: string, legs: string, odds: string, k: number, n: number) => `+ ${m}: ${legs} @ ${odds} (${k}/${n})`,
    done: (t: number, k: number, n: number) => `gata: ${t} bilet(e), ${k} din ${n} meciuri`,
    oddsOrder: 'Cota maximă trebuie să fie mai mare decât cea minimă.',
    reasons: { keyPlayer: 'jucător important absent', rotation: 'rotație probabilă', lowInfo: 'prea puține informații', highRisk: 'risc ridicat', aiDown: 'analiza AI indisponibilă' },
    badKey: 'Cheie de acces lipsă sau invalidă.',
    noCredits: 'Nu mai ai generări. Alege un abonament ca să continui.',
    busy: 'Ai deja o generare în curs.',
    minOne: 'Numărul de bilete și de meciuri trebuie să fie cel puțin 1.',
    aiUnavailable: 'Serviciul de analiză nu e disponibil momentan. Nu ți s-a consumat nicio generare.',
    notFound: 'Nu a fost găsit.',
  },
  en: {
    upcoming: (n: number, h: number, need: number) => `${n} matches in the next ${h} hours; ${need} needed`,
    withCombo: (n: number, lo: number, hi: number) => `${n} matches have a combination at odds ${lo}-${hi}`,
    skipped: (m: string, why: string) => `skipped ${m}: ${why}`,
    notFit: "the selections don't fit the news",
    added: (m: string, legs: string, odds: string, k: number, n: number) => `+ ${m}: ${legs} @ ${odds} (${k}/${n})`,
    done: (t: number, k: number, n: number) => `done: ${t} ticket(s), ${k} of ${n} matches`,
    oddsOrder: 'The maximum odds must be above the minimum.',
    reasons: { keyPlayer: 'key player missing', rotation: 'likely rotation', lowInfo: 'too little information', highRisk: 'high risk', aiDown: 'AI analysis unavailable' },
    badKey: 'Missing or invalid access key.',
    noCredits: 'No generations left. Choose a plan to continue.',
    busy: 'You already have a generation in progress.',
    minOne: 'Tickets and matches must be at least 1.',
    aiUnavailable: 'The analysis service is temporarily unavailable. You were not charged.',
    notFound: 'Not found.',
  },
};

/** Jev's drop reasons ("high risk 63%") in the user's language. */
export function reason(lang: Lang, r: string): string {
  const t = MSG[lang].reasons;
  return r
    .replace(/^key player missing/, t.keyPlayer)
    .replace(/^rotation/, t.rotation)
    .replace(/^low info quality/, t.lowInfo)
    .replace(/^high risk/, t.highRisk)
    .replace(/^jev unavailable.*/, t.aiDown);
}
