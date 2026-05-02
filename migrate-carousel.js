// migrate-carousel.js
// One-shot migration: adds public_ids and urls columns to queue + pending_review.
// Existing rows keep using public_id/url; new carousel rows use public_ids/urls.
// Safe to run multiple times.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'framepost.db'));

function tryAdd(table, col, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    console.log(`  added ${table}.${col}`);
  } catch (err) {
    if (/duplicate column/i.test(err.message)) {
      console.log(`  ${table}.${col} already exists, skipping`);
    } else {
      throw err;
    }
  }
}

console.log('Migrating for carousel support...');
tryAdd('queue', 'public_ids', 'TEXT');           // JSON array of public_ids when carousel
tryAdd('queue', 'urls', 'TEXT');                 // JSON array of URLs when carousel
tryAdd('pending_review', 'public_ids', 'TEXT');
tryAdd('pending_review', 'urls', 'TEXT');
console.log('Done.');
