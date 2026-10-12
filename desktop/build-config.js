const fs = require('fs');
const path = require('path');

/**
 * Before electron-builder packages the installer, let BILETAI_SERVER_URL override
 * config.json's serverUrl. config.json keeps the default (http://127.0.0.1:8787);
 * the override only affects the installers built from it.
 */
const file = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const url = process.env.BILETAI_SERVER_URL;
if (url) config.serverUrl = url;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
