import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as yaml from 'js-yaml';
import { z } from 'zod';

/**
 * BiletAI configuration. Secrets come ONLY from the server's environment (a .env on the
 * server, or the hosting provider's secret settings). The desktop/mobile apps never see them.
 */
dotenv.config();

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().optional(),      // news research (server only)
  TYPESAFE_API_KEY: z.string().optional(),      // Jev decisions (server only; read by the SDK)
  NEWS_MODEL: z.string().optional(),            // default deepseek-flash
  ADMIN_TOKEN: z.string().optional(),           // protects /admin endpoints
  PORT: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

const builderSchema = z.object({
  // One builder = several selections on ONE match; its fair odds = 1 / P(all win).
  minLegs: z.number().int().min(1).max(5).default(2),
  maxLegs: z.number().int().min(1).max(5).default(4),
  minOdds: z.number().gt(1).default(1.25),
  maxOdds: z.number().gt(1).default(2),
  // A leg more likely than 1/legMinOdds (95%) adds a leg count, nothing else.
  legMinOdds: z.number().gt(1).default(1.05),
  maxCandidateLegs: z.number().int().positive().default(40),
  beamWidth: z.number().int().positive().default(8),
}).refine((b) => b.maxLegs >= b.minLegs && b.maxOdds > b.minOdds, { message: 'builder: max must be above min' });

const ticketsSchema = z.object({
  windowHours: z.number().positive().max(240).default(72),
  defaultTickets: z.number().int().min(1).default(1),
  defaultMatches: z.number().int().min(1).default(5),
  maxTickets: z.number().int().min(1).default(5),
  maxMatches: z.number().int().min(1).default(15),
});

const modelSchema = z.object({
  seasons: z.number().int().min(1).max(10).default(3),
  decayPerDay: z.number().min(0).default(0.0019),
  shrinkage: z.number().min(0).default(4),
  simulations: z.number().int().min(1000).default(20000),
  maxStaleDays: z.number().int().positive().default(14),
  // Weight of the model against the market's average 1X2 / O-U 2.5 prices when setting
  // expected goals (1 = model only). 0.25 came from the walk-forward backtest.
  modelWeight: z.number().min(0).max(1).default(0.25),
});

const jevSchema = z.object({
  model: z.string().default('jev-latest'),
  dropIfKeyPlayerMissing: z.number().min(0).max(1.01).default(0.97),
  keyPlayerDownweight: z.number().min(0).max(1).default(0.05),
  dropIfHighRisk: z.number().min(0).max(1).default(0.5),
  dropIfLowInfo: z.number().min(0).max(1).default(0.6),
  dropIfRotation: z.number().min(0).max(1).default(0.7),
  riskDownweight: z.number().min(0).max(1).default(0.15),
  minSlipConsistency: z.number().min(0).max(1).default(0.5),
});

const newsSchema = z.object({
  maxSearches: z.number().int().min(0).max(10).default(2),
  cacheHours: z.number().positive().default(36),
});

// A monthly plan renews its generations every month; a "once" pack adds generations that
// never expire. `questions` = "ask about the ticket" questions per generation it pays for.
const planSchema = z.object({
  id: z.string(), name: z.string(), generations: z.number().int().positive(), priceRon: z.number().nonnegative(),
  period: z.enum(['month', 'once']).default('month'), questions: z.number().int().min(0).max(20).default(5),
  featured: z.boolean().default(false),
});

// Prices in USD for the cost meter (utils/costMeter.ts). Defaults are DeepSeek's PEAK rates for
// deepseek-flash and TypeSafe's Jev list price (checked 2026-10-09), so estimates err high.
const costsSchema = z.object({
  deepseekInputPerM: z.number().min(0).default(0.3),
  deepseekCachedInputPerM: z.number().min(0).default(0.006),
  deepseekOutputPerM: z.number().min(0).default(1.2),
  webSearchEach: z.number().min(0).default(0),
  jevInputPerM: z.number().min(0).default(0.042),
  usdToRon: z.number().positive().default(4.5),
});

const settingsSchema = z.object({
  builder: builderSchema.default({ minLegs: 2, maxLegs: 4, minOdds: 1.25, maxOdds: 2, legMinOdds: 1.05, maxCandidateLegs: 40, beamWidth: 8 }),
  tickets: ticketsSchema.default({ windowHours: 72, defaultTickets: 1, defaultMatches: 5, maxTickets: 5, maxMatches: 15 }),
  model: modelSchema.default({ seasons: 3, decayPerDay: 0.0019, shrinkage: 4, simulations: 20000, maxStaleDays: 14, modelWeight: 0.25 }),
  jev: jevSchema.default({
    model: 'jev-latest', dropIfKeyPlayerMissing: 0.97, keyPlayerDownweight: 0.05, dropIfHighRisk: 0.5, dropIfLowInfo: 0.6,
    dropIfRotation: 0.7, riskDownweight: 0.15, minSlipConsistency: 0.5,
  }),
  news: newsSchema.default({ maxSearches: 2, cacheHours: 36 }),
  // AI stages (news + Jev). Off = statistical models only (free, no API keys needed).
  ai: z.object({ enabled: z.boolean().default(true), parallel: z.number().int().min(1).max(16).default(6) }).default({ enabled: true, parallel: 6 }),
  server: z.object({
    port: z.number().int().positive().default(8787),
    freeGenerations: z.number().int().nonnegative().default(2),
    freeQuestions: z.number().int().nonnegative().default(3),   // per free generation
    userStore: z.enum(['json', 'sqlite']).default('json'),      // where accounts are stored (data/users.json or data/users.db)
    helpUrl: z.string().default('https://biletai.ro/ajutor'),   // support link shown in pause messages and other help pointers
  }).default({ port: 8787, freeGenerations: 2, freeQuestions: 3, userStore: 'json', helpUrl: 'https://biletai.ro/ajutor' }),
  plans: z.array(planSchema).default([]),
  costs: costsSchema.default({ deepseekInputPerM: 0.3, deepseekCachedInputPerM: 0.006, deepseekOutputPerM: 1.2, webSearchEach: 0, jevInputPerM: 0.042, usdToRon: 4.5 }),
});

export type Settings = z.infer<typeof settingsSchema>;

export const SETTINGS_FILE = path.resolve(process.cwd(), 'config', 'settings.yaml');

function loadSettings(): Settings {
  const raw = fs.existsSync(SETTINGS_FILE) ? yaml.load(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
  return settingsSchema.parse(raw ?? {});
}

export const env = envSchema.parse(process.env);
export const settings = loadSettings();

const root = process.cwd();
export const paths = {
  root,
  logs: path.resolve(root, 'logs'),
  cache: path.resolve(root, 'logs', '.cache'),
  history: path.resolve(root, 'logs', '.history'),
  jevDecisionsJsonl: path.resolve(root, 'logs', 'jev-decisions.jsonl'),
  data: path.resolve(root, 'data'),            // server state: users, generations (never in the app)
  client: path.resolve(root, 'client'),
};

for (const dir of [paths.logs, paths.cache, paths.history, paths.data]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
