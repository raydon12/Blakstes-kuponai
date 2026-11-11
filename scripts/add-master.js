// Adds or updates a master (staff) account: node scripts/add-master.js <name> <password>
'use strict';
const { hashPassword, MASTERS, readJson, writeJson } = require('../server');
const [name, password] = process.argv.slice(2);
if (!name || !password || password.length < 6) {
  console.error('Usage: node scripts/add-master.js <name> <password>  (password: 6+ characters)');
  process.exit(1);
}
const masters = readJson(MASTERS, []).filter(m => m.name.toLowerCase() !== name.toLowerCase());
masters.push({ name, ...hashPassword(password), createdAt: new Date().toISOString() });
writeJson(MASTERS, masters);
console.log(`Master "${name}" saved (${masters.length} total).`);
