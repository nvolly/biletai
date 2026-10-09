# BiletAI

AI football ticket generator. Statistical models plus AI news analysis build tickets of
per-match combinations ("builders"). Each comes with its **probability** and **fair odds**.
BiletAI is not connected to any bookmaker: it never shows, links or prices one.

## How it works

```
 Apps (desktop now; mobile later)          BiletAI server (EU VPS, ~5-10 EUR/month)
  - sign in with an access key      ──►     - AI keys live ONLY here (environment)
  - choose tickets, matches, odds           - accounts, free + paid generations
  - see tickets, copy them           ◄──    - the engine below
```

The engine (`src/`):

| Step | What | Where |
|---|---|---|
| Fixtures | Upcoming matches with average market prices (football-data.co.uk feeds) | `engine/fixtures.ts` |
| Models | Dixon-Coles goals + corner, card, shot and shots-on-target count models, trained on 3 seasons per league, time-decayed | `stages/poisson/` |
| Market blend | Expected goals mixed 25% model / 75% the market average (from the backtest) | `engine/generate.ts` |
| Simulation | 20,000 simulated matches with a Gaussian copula, so combinations get a **joint** probability | `stages/poisson/simulate.ts` |
| Selections | Per match, by bet type: **Simplu** = the best single selection, **Combinat** = the best combination of 2-4 selections; either in an odds band, fair odds = 1 / probability | `engine/catalogue.ts`, `engine/builder.ts` |
| AI | DeepSeek web-searched team news; TypeSafe Jev drops risky matches and checks each builder against the news; a short explanation | `stages/news/`, `stages/jev/` |
| Tickets | Matches dealt round-robin over the tickets; ticket probability and fair odds are cumulated (multiplied) over its independent matches | `engine/generate.ts` |
| Results | Every stored pick settled against the real result; track record per probability range | `engine/settle.ts` |
| Assistant | Request box (text → settings) and a chat about one generation, both with guardrails and limits | `stages/news/assistant.ts` |

## Run it locally

```bash
npm install
cp .env.example .env               # put DEEPSEEK_API_KEY and TYPESAFE_API_KEY in it (server only)
npm run user -- add you@example.com 20   # prints an access key ONCE
npm run app                        # starts the server and opens the desktop UI
```

Other commands:
- `npm run server`: the API server only (port 8787).
- `npm run generate -- 2 5 [--simple] [--no-ai]`: generate from the terminal.
- `npm run user -- list | credit <email> <n> | plan <email> <id> [months] | key <email>`: user admin on the server.
- `npm run user -- costs`: what generations, questions and requests really cost, and each plan's margin.
- `npm test`: runs the tests.

## Desktop app (Windows)

`desktop/` wraps `client/index.html` in an Electron window. It talks only to the server set in
`desktop/config.json` (`serverUrl`) and holds no keys.

```bash
cd desktop && npm install          # once
npm run desktop                    # run it (start the server first)
npm run desktop:dist               # build desktop/dist/BiletAI Setup <version>.exe
```

Before releasing: point `serverUrl` at the HTTPS server, sign the installer with a
code-signing certificate, and add auto-update.

## API

All `/v1` calls need `Authorization: Bearer <access key>`.

| Call | What |
|---|---|
| `GET /demo` | Public: a real BiletAI ticket (with results once played) and the plans |
| `GET /v1/health` | Status, number of leagues ready |
| `GET /v1/me` | Free and paid generations left, plans |
| `GET /v1/leagues` | Leagues the models cover |
| `POST /v1/generate` | `{tickets, matches, betType: "simple" \| "combo", minOdds, maxOdds, maxLegs, windowHours, leagues}` → `{jobId}` |
| `GET /v1/jobs/:id` | Progress log; when done, the tickets |
| `GET /v1/history` | The caller's recent generations (settled matches carry their result) |
| `GET /v1/track-record` | How every settled pick did against the probability shown |
| `POST /v1/parse` | `{text}` → settings for the form (the one-line request box) |
| `POST /v1/ask` | `{generationId, question}` → `{answer, left}`: questions about one generation's tickets |
| `POST /admin/users` | Header `X-Admin-Token`; creates a user and returns its access key |

A generation is charged only when it succeeds, free generations first. One generation runs
at a time server-wide, and each user can have only one running.

## Before charging money

- [ ] Written answer from ONJN (petition sent) and the lawyer's review.
- [ ] A licensed or commercially permitted fixtures/odds data source (or confirmed terms for
      football-data.co.uk).
- [ ] DeepSeek and TypeSafe terms allow commercial use of the outputs.
- [ ] SRL, payment provider (Stripe on the web; in-app purchases on mobile), terms,
      privacy policy, refund policy, ANPC/SOL links, 18+.
- [ ] Hosting: a small EU VPS (e.g. Hetzner), HTTPS, backups of `data/`.

## Not included on purpose

No bookmaker data, names, links or automation. No bet placing. No player markets, since
there's no player data source.
