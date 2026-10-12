# Deploying the desktop app

`npm run desktop:dist` builds the Windows installer into `desktop/dist/`. The installer
embeds `desktop/config.json`, whose `serverUrl` is where the app talks to the BiletAI
server. The default is `http://127.0.0.1:8787` (a local server, for development).

## Pointing an installer at the real server

Set the `BILETAI_SERVER_URL` environment variable before building; it overrides
`config.json`'s `serverUrl` for that build only (the file on disk is written with the
override, so build on a clean checkout or restore it afterwards):

```
BILETAI_SERVER_URL=https://biletai.example.com npm run desktop:dist
```

Without the variable, the build uses whatever `desktop/config.json` says, unchanged.

Remember to set up the server first (EU VPS, HTTPS) before shipping the installer.
