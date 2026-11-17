// Tiny JSON-file storage: no database or npm packages needed.
// Every file lives in DATA_DIR and is written atomically (temp file + rename).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) { return path.join(DATA_DIR, name + '.json'); }

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function write(name, value) {
  const f = file(name), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

module.exports = { read, write, DATA_DIR };
