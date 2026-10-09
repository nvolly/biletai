# CLAUDE.md — BiletAI

Working guide for this repo. Technical details are in [README.md](README.md). This file
records **what was decided and why**. Read it before changing anything.

## What BiletAI is

The name is **BiletAI**, final (owner, 2026-10-09; "BiletIA" was considered and rejected).

An app for the **Romanian public** that generates football tickets with AI. Each match on a
ticket gets a combination of 2–4 selections (a "builder"), with its **probability** and
**cotă corectă** (fair odds = 1 / model probability), plus a short explanation in Romanian.

- **Platforms:** desktop (Windows first), **Android** and **iOS**, and a website that presents
  the app and links to Google Play, the App Store and the desktop download.
- **Language: Romanian (default) and English**, switched with the RO/EN button in the app
  (owner, 2026-10-09). **When RO is chosen, everything the user sees is Romanian with
  diacritics:**
  - the UI and country names;
  - market names (`engine/catalogue.ts` via `src/i18n.ts`);
  - progress lines and Jev's drop reasons (`reason()` in `src/i18n.ts`);
  - server errors (`X-Lang` header);
  - **DeepSeek's explanations** (`explainBuilder({ lang })`).

  Add any new user-facing string to `src/i18n.ts` (server) or the `T` dictionary in
  `client/index.html` (app), in both languages. Team names stay as the data source writes
  them. Code, comments and this file stay in English.
- **Look: the original BiletAI design** (owner, 2026-10-09, after trying black-and-white and
  rejecting it): indigo accent `#5b5bf7` with a green highlight `#34d399`.
  - **Dark theme:** the original deep navy (`#0e1020`).
  - **Light theme:** the same design on **white**.
  - It follows the system; the ◐ button toggles it and is remembered.
  - Keep new UI in this style; don't switch to monochrome again.
- **Money:** free generations first (`server.freeGenerations`, 3), then paid plans
  (`plans` in `config/settings.yaml`, placeholders: 10 generări = 29 lei, 50 = 99 lei).
- **Owner:** Vali. Prefers Romanian in conversation, fast runs and low API costs.

It grew out of the owner's separate private tool. **That tool is not the product: BiletAI has
no link to it and nothing that touches a bookmaker may come here.** BiletAI took only the
statistical engine and the AI stages.

## Legal position (decided 2026-10-08/09; not legal advice, pending confirmation)

The product is designed to be a **prediction / statistics service, not gambling promotion**:

1. **No bookmaker anywhere:** no names, links, logos, odds feeds, bonus codes, "joacă la X",
   affiliate deals or agency ticket codes. Anything that promotes a bookmaker needs an
   **ONJN Class II licence** (affiliate). Per 2026 sources that's ~€10,500 issuance +
   €20,000/year + €15,000/year responsible-gambling contribution; older sources say
   €6,000 + €1,000/year, so confirm the current figures.
2. **No bet placing and no handling of customers' betting money.** That would be operating or
   intermediating gambling (Class I or illegal).
3. **No promises of winnings.** Show honest probabilities and "fără garanții". Never market it
   as a "winning generator".
4. **18+ only**, with responsible-gambling messages (footer in `client/index.html`).

Status:
- **ONJN petition sent 2026-10-09** by the owner as a private person (online petition portal;
  `office@onjn.gov.ro` only takes mail from legal entities). The question: does this
  activity need a licence? Answer expected within ~30 days of registration.
- **The owner will consult a lawyer** (Class II applicability, T&C, liability limits, GDPR,
  refunds, ANPC/SOL).
- **Company:** an **SRL** is planned (limited liability; better for store and payment
  contracts) and doesn't exist yet. No special certification is required to sell software in
  Romania; insurance isn't mandatory (professional liability and cyber are optional).
- **Do not take payments or publish to the stores** before the ONJN answer and the lawyer's
  review. Building and testing is fine.

## Architecture (the rule: no key ever ships in an app)

```
 apps (desktop / Android / iOS / web)  ──HTTPS──►  BiletAI server (EU VPS)
   UI only: sign in, settings, tickets               AI keys in the server environment only
   (client/index.html today)                          accounts + credits (data/users.json)
                                                      engine: models -> simulation -> builders
                                                      AI: DeepSeek news, TypeSafe Jev
```

- **Server:** `src/server/server.ts`. `/v1/*` uses `Authorization: Bearer <access key>`.
  Access keys look like `bai_...`; only their SHA-256 hashes are stored. A generation is
  charged only on success, free ones first. One job runs at a time server-wide, one per user.
- **Engine:** `src/engine/generate.ts`.
  - **Fixtures:** football-data.co.uk fixture feeds, the same source as the training history,
    so team names match.
  - **Models:** Dixon-Coles goals, plus count models for corners, cards, shots and shots on
    target. Goals are blended 25% model / 75% market average (`model.modelWeight`, from the
    backtest).
  - **Simulation:** 20,000 runs with a copula, so joint probabilities come from the
    simulation and selections are **never multiplied** within a match.
  - **Builders:** best builder per match in three odds bands spread over the requested range.
  - **AI on the matches about to be used:** news → Jev filter → Jev consistency check →
    Romanian explanation.
- **Secrets:** `.env` on the server (`DEEPSEEK_API_KEY`, `TYPESAFE_API_KEY`, `ADMIN_TOKEN`).
  Never commit it; never put a key in `client/`.

## Roadmap (agreed direction)

1. **Server online:** an EU VPS (e.g. Hetzner, ~€5–8/month), HTTPS (Caddy or nginx), process
   manager, daily backup of `data/`. Then the apps point at it.
2. **Apps from one codebase:** turn `client/` into a small web app, then wrap it:
   - **Android + iOS:** Capacitor (same HTML/JS). iOS builds need a Mac or a cloud build
     (e.g. Codemagic).
   - **Desktop:** **Electron, in `desktop/`** (decided 2026-10-09: Tauri needs Rust plus ~6 GB
     of Visual Studio build tools, Electron runs on the Node already installed). It loads
     `client/index.html` in a sandboxed window (no Node in the page) and points it at
     `desktop/config.json` → `serverUrl`. `npm run desktop:dist` builds the Windows installer.
     **Before release:** set `serverUrl` to the HTTPS server, buy a code-signing certificate
     (otherwise SmartScreen warns), add auto-update.
3. **Accounts:** email sign-up/login in the app, replacing admin-issued access keys.
4. **Payments:** Stripe (or a Romanian processor) for web/desktop. **Mobile subscriptions must
   use Apple/Google in-app purchases** (15–30% fee).
5. **Store accounts:** Apple Developer ~$99/year, Google Play $25 once. Company accounts need
   a **D-U-N-S** number (free).
6. **Website:** Romanian landing page, store links, T&C, privacy policy, refunds, ANPC/SOL,
   18+.
7. **Data licence:** confirm football-data.co.uk's commercial terms or switch to a licensed
   feed behind `FixtureSource` (`engine/fixtures.ts`).

## To do later (owner, 2026-10-09)

- [ ] **Server online:** rent the EU VPS and point a domain at it; then deploy the server and
      set `desktop/config.json` → `serverUrl` to its HTTPS address.
- [ ] **Code-signing certificate** for the Windows installer (~€100–300/year), so
      SmartScreen doesn't warn on install.
- [ ] **Owner access key:** it still starts with `tm_` (TicketMind era). Works fine; reissue a
      `bai_` key with `npm run user -- key owner@ticketmind.local` when convenient.

## Costs (measured on the private tool, 2026-10-07)

- DeepSeek news ≈ **$0.003 per match researched**, after the cost cuts: 2 web searches,
  thinking off, 36h cache. Jev keeps about 1 match in 3, so a ticket of N matches costs
  about 3N lookups.
- Generation time: about **35 s without AI** for 2×5; **~53 s with AI** for 1×3.

## Rules for working here

- **Never add bookmaker code, names, links or prices**, and no browser automation of any
  betting site.
- **Never put API keys in `client/`** or anything a customer downloads.
- Keep user-facing text in **Romanian with diacritics**. Use "cotă corectă" for fair odds,
  "șansă" or "probabilitate" for probability.
- Don't overstate: explanations and marketing must not promise results.
- Don't loosen `builder.legMinOdds` or the padding rule in `engine/builder.ts` (a selection
  must lower the joint probability by ≥ 2%) just to make tickets look longer.
- Edit files with UTF-8-safe tools. PowerShell 5.1 `Get-Content`/`Set-Content` garbles
  diacritics (it happened twice on 2026-10-09); use the editor tools or small Node scripts.
- Launching Electron from a shell inside VS Code: clear `ELECTRON_RUN_AS_NODE` first (VS Code
  sets it to 1, which makes Electron run as plain Node with no window).

## Commands

| Command | What it does |
|---|---|
| `npm run app` | Server + desktop UI in a Chrome app window (development) |
| `npm run server` | API server only (port 8787) |
| `npm run desktop` | The Electron desktop app (start the server first) |
| `npm run desktop:dist` | Build the Windows installer into `desktop/dist/` |
| `npm run generate -- 2 5 [--no-ai]` | Generate from the terminal |
| `npm run user -- add <email> [credits]` | Create a user and print the access key once (`credit`, `key`, `list` also exist) |
| `npm test` | Unit tests (models, simulation, builder) |

The owner's test account is `owner@ticketmind.local`, created before the rename and
still working. Its access key is in `data/owner-access-key.txt`, which is server-side and
git-ignored.

## Known limits

- football-data.co.uk results lag ~2 weeks, so ratings miss the latest form.
- "Extra" leagues (Romania, Brazil, MLS…) have goals models only: no corner, card or shot
  markets there.
- No player markets (there's no player data source).
- Team names are shown as football-data.co.uk writes them (English).
