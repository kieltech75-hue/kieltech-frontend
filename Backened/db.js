const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || '';
const usePostgres = DATABASE_URL.startsWith('postgres');

let db = null;
let pgClient = null;
let connectionReady = false;
let dbType = usePostgres ? 'postgres' : 'sqlite';

async function ensureDatabaseReady() {
  if (connectionReady) {
    return;
  }

  if (usePostgres) {
    pgClient = new Client({ connectionString: DATABASE_URL });
    await pgClient.connect();
  } else {
    const dbPath = path.join(__dirname, 'kieltech.db');
    db = new sqlite3.Database(dbPath);
  }

  connectionReady = true;
}

async function run(sql, params = []) {
  await ensureDatabaseReady();

  if (usePostgres) {
    const insert = sql.trim().toUpperCase().startsWith('INSERT');
    const querySql = insert ? `${sql} RETURNING id` : sql;
    const result = await pgClient.query(querySql, params);
    return { id: result.rows[0]?.id || null, changes: result.rowCount || 0 };
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

async function get(sql, params = []) {
  await ensureDatabaseReady();

  if (usePostgres) {
    const result = await pgClient.query(sql, params);
    return result.rows[0] || null;
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function all(sql, params = []) {
  await ensureDatabaseReady();

  if (usePostgres) {
    const result = await pgClient.query(sql, params);
    return result.rows;
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function getTableColumns(tableName) {
  await ensureDatabaseReady();

  if (usePostgres) {
    const result = await pgClient.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [tableName]
    );
    return result.rows.map((row) => row.column_name);
  }

  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows.map((row) => row.name));
    });
  });
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await getTableColumns(tableName);
  if (!columns.includes(columnName)) {
    if (usePostgres) {
      await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      return;
    }

    let sqliteDefinition = definition;
    if (definition.includes('DEFAULT CURRENT_TIMESTAMP')) {
      sqliteDefinition = definition.replace(/DEFAULT CURRENT_TIMESTAMP/i, '');
    }
    if (definition.includes('BOOLEAN DEFAULT FALSE')) {
      sqliteDefinition = 'BOOLEAN';
    }
    if (definition.includes("TEXT DEFAULT 'approved'") || definition.includes("TEXT DEFAULT 'pending'")) {
      sqliteDefinition = 'TEXT';
    }
    if (definition.includes('DATETIME DEFAULT CURRENT_TIMESTAMP')) {
      sqliteDefinition = 'DATETIME';
    }

    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqliteDefinition}`);
  }
}

async function init() {
  await ensureDatabaseReady();

  if (usePostgres) {
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS downloads (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        file_url TEXT NOT NULL,
        downloads_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS ratings (
        id SERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_id, user_id)
      )
    `);

    await ensureColumn('users', 'is_admin', 'BOOLEAN DEFAULT FALSE');
    await ensureColumn('downloads', 'status', "TEXT DEFAULT 'approved'");
    await ensureColumn('downloads', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('ratings', 'status', "TEXT DEFAULT 'pending'");
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        file_url TEXT NOT NULL,
        downloads_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'approved',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_id, user_id)
      )
    `);

    await ensureColumn('users', 'is_admin', 'BOOLEAN DEFAULT FALSE');
    await ensureColumn('downloads', 'status', "TEXT DEFAULT 'approved'");
    await ensureColumn('downloads', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('ratings', 'status', "TEXT DEFAULT 'pending'");
  }

  const existingDownloads = await all('SELECT id FROM downloads');
  if (existingDownloads.length === 0) {
    await run(`
      INSERT INTO downloads (title, description, file_url, downloads_count, status) VALUES
      ('Starter Pack', 'A practical launch kit for new projects.', '/downloads/starter-pack.pdf', 0, 'approved'),
      ('AI Toolkit', 'Prompt ideas and workflow templates for smart automation.', '/downloads/ai-toolkit.pdf', 0, 'approved'),
      ('Product Brief', 'A concise roadmap template for digital launches.', '/downloads/product-brief.pdf', 0, 'approved')
    `);
  }

  await run("UPDATE users SET is_admin = 1 WHERE email = 'demo@kieltech.com'");
}

async function closeDatabase() {
  if (pgClient) {
    await pgClient.end();
  }
}

function isPostgres() {
  return dbType === 'postgres';
}

module.exports = { db, pgClient, init, run, get, all, closeDatabase, isPostgres };
