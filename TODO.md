## To do later (owner, 2026-10-09)

- [ ] **Server online:** rent the EU VPS and point a domain at it; then deploy the server and
      set `desktop/config.json` → `serverUrl` to its HTTPS address.
- [ ] **Code-signing certificate** for the Windows installer (~€100–300/year), so
      SmartScreen doesn't warn on install.
- [ ] **Owner access key:** it still starts with `tm_` (TicketMind era). Works fine; reissue a
      `bai_` key with `npm run user -- key owner@ticketmind.local` when convenient.
- [ ] **Ask the lawyer about "Compară cota"** (fill-in mode): the user types the odds they were
      offered and the app compares them with the cotă corectă. No bookmaker is named or linked,
      but it touches odds.
- [ ] **Licensed data feed** (also needed for commercial use). Choose it for: European cups and
      national teams (missing today), Liga 1 statistics (goals-only today), fresh results
      (today ~2 weeks late), confirmed lineups (re-check tickets ~1h before kickoff), xG.
- [ ] **Accounts in a real database** (SQLite is enough) instead of `data/users.json`, before
      launch.
- [ ] **Payments for the plans** (after ONJN + lawyer): Stripe on web/desktop, Google/Apple
      in-app purchases on mobile. The popup's buttons say "În curând" until then.
- [ ] **Run generations on a worker thread.** One generation blocks the server for ~15 s of
      simulation, so other users wait; fine for now, not with many users.
- [ ] **News research overshoots its search limit:** 49 web searches for 11 matches although
      `news.maxSearches` is 2 per call. It's most of the cost. Find out why (DeepSeek may not
      enforce `max_uses`) before trimming.
- [ ] **Test user** `test@biletai.local` (Pro plan) exists on the dev machine; its tickets
      feed the demo. Remove it before going live.
- [ ] **Rebuild the installer** (`npm run desktop:dist`) before sharing it: the copy in
      `desktop/dist/` predates the bet types and the new features.