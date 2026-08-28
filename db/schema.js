'use strict';
// Kern-Datenbankschema + additive Migrationen (users/meetings/topics/todos/
// themes/theme_links, AI-Tabellen, Attachments, Stack-Layer, Contacts,
// Topic-Hierarchie, Wissensseiten, FTS5-Volltextindex, Wissensseiten-
// Verknuepfungen, Graph-Knoten-Positionen, content_text-Spalte).
//
// Aus server.js extrahiert (Arbeit zur Lesbarkeit/Wartbarkeit) - Verhalten
// unveraendert, reine Verschiebung. Laeuft VOR den bereits eigenstaendig
// modularisierten Migrationen von lib/progress, lib/archive, lib/summaries
// (die weiterhin in server.js orchestriert werden, da sie users/meetings/
// topics/todos aus DIESEM Schema voraussetzen).
//
// Ausschliesslich additiv: CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ADD
// COLUMN nach PRAGMA-table_info-Existenzcheck. Kein DROP/Datenverlust-Pfad.
function runCoreMigrations(db, { htmlToText }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'user',
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title              TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      participants       TEXT NOT NULL DEFAULT '[]',
      is_recurring       INTEGER NOT NULL DEFAULT 0,
      recurrence_pattern TEXT NOT NULL DEFAULT '',
      next_date          TEXT NOT NULL DEFAULT '',
      color              TEXT NOT NULL DEFAULT '#4f46e5',
      created_at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topics (
      id          TEXT PRIMARY KEY,
      meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      done        INTEGER NOT NULL DEFAULT 0,
      result      TEXT NOT NULL DEFAULT '',
      result_date TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS todos (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      done        INTEGER NOT NULL DEFAULT 0,
      result      TEXT NOT NULL DEFAULT '',
      result_date TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS themes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS theme_links (
      id         TEXT PRIMARY KEY,
      theme_id   TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
      ref_type   TEXT NOT NULL,
      ref_id     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(theme_id, ref_id)
    );
  `);
  
  // Migration: add sort_order to meetings if missing
  {
    const cols = db.prepare('PRAGMA table_info(meetings)').all();
    if (!cols.find(c => c.name === 'sort_order')) {
      db.exec('ALTER TABLE meetings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      const users = db.prepare('SELECT id FROM users').all();
      db.transaction(() => {
        for (const u of users) {
          const ms = db.prepare('SELECT id FROM meetings WHERE user_id=? ORDER BY next_date,created_at').all(u.id);
          ms.forEach((m, i) => db.prepare('UPDATE meetings SET sort_order=? WHERE id=?').run(i, m.id));
        }
      })();
    }
  }
  
  // Migration: add result/result_date to todos if missing
  {
    const cols = db.prepare('PRAGMA table_info(todos)').all();
    if (!cols.find(c => c.name === 'result')) {
      db.exec("ALTER TABLE todos ADD COLUMN result TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE todos ADD COLUMN result_date TEXT NOT NULL DEFAULT ''");
    }
  }
  
  // Migration: add group_id to topics if missing
  {
    const cols = db.prepare('PRAGMA table_info(topics)').all();
    if (!cols.find(c => c.name === 'group_id')) {
      db.exec('ALTER TABLE topics ADD COLUMN group_id TEXT');
    }
  }
  
  // Migration: add is_todo to topics if missing
  {
    const cols = db.prepare('PRAGMA table_info(topics)').all();
    if (!cols.find(c => c.name === 'is_todo')) {
      db.exec('ALTER TABLE topics ADD COLUMN is_todo INTEGER NOT NULL DEFAULT 0');
    }
  }
  
  // Migration: add snoozed_until to topics if missing
  {
    const cols = db.prepare('PRAGMA table_info(topics)').all();
    if (!cols.find(c => c.name === 'snoozed_until')) {
      db.exec("ALTER TABLE topics ADD COLUMN snoozed_until TEXT NOT NULL DEFAULT ''");
    }
  }
  
  // Migration: add snoozed_until to todos if missing
  {
    const cols = db.prepare('PRAGMA table_info(todos)').all();
    if (!cols.find(c => c.name === 'snoozed_until')) {
      db.exec("ALTER TABLE todos ADD COLUMN snoozed_until TEXT NOT NULL DEFAULT ''");
    }
  }
  
  // Migration: add due_date to todos if missing
  {
    const cols = db.prepare('PRAGMA table_info(todos)').all();
    if (!cols.find(c => c.name === 'due_date')) {
      db.exec("ALTER TABLE todos ADD COLUMN due_date TEXT NOT NULL DEFAULT ''");
    }
  }
  
  // Migration: add sort_order column if missing
  {
    const cols = db.prepare('PRAGMA table_info(topics)').all();
    if (!cols.find(c => c.name === 'sort_order')) {
      db.exec('ALTER TABLE topics ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      const allMeetings = db.prepare('SELECT id FROM meetings').all();
      const initOrder = db.transaction(() => {
        for (const m of allMeetings) {
          const ts = db.prepare('SELECT id FROM topics WHERE meeting_id=? ORDER BY created_at').all(m.id);
          ts.forEach((t, i) => db.prepare('UPDATE topics SET sort_order=? WHERE id=?').run(i, t.id));
        }
      });
      initOrder();
    }
  }
  
  // ── Migration: AI tables (Erweiterung v1.1, Phase 1) ─────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      id                       TEXT PRIMARY KEY,
      user_id                  TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      provider                 TEXT NOT NULL DEFAULT '',
      model                    TEXT NOT NULL DEFAULT '',
      api_key_encrypted        TEXT NOT NULL DEFAULT '',
      api_key_last4            TEXT NOT NULL DEFAULT '',
      azure_endpoint           TEXT NOT NULL DEFAULT '',
      azure_api_version        TEXT NOT NULL DEFAULT '',
      features_enabled         TEXT NOT NULL DEFAULT '{}',
      max_monthly_cost_cents   INTEGER NOT NULL DEFAULT 0,
      confirm_threshold_cents  INTEGER NOT NULL DEFAULT 10,
      globally_disabled        INTEGER NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      feature              TEXT NOT NULL,
      provider             TEXT NOT NULL,
      model                TEXT NOT NULL,
      input_tokens         INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cost_estimate_cents  INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON ai_usage(user_id, created_at);
    CREATE TABLE IF NOT EXISTS ai_artifacts (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref_type    TEXT NOT NULL,
      ref_id      TEXT NOT NULL,
      feature     TEXT NOT NULL,
      content     TEXT NOT NULL,
      model       TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_artifacts_ref ON ai_artifacts(ref_type, ref_id);
  `);
  
  // ── Migration: updated_at + AI settings extensions (v1.1, Phase 3) ──
  (function migratePhase3() {
    function hasCol(table, name) {
      return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name);
    }
    if (!hasCol('topics', 'updated_at')) {
      db.exec(`ALTER TABLE topics ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
      db.exec(`UPDATE topics SET updated_at = created_at WHERE updated_at = ''`);
    }
    if (!hasCol('todos', 'updated_at')) {
      db.exec(`ALTER TABLE todos ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
      db.exec(`UPDATE todos SET updated_at = created_at WHERE updated_at = ''`);
    }
    if (!hasCol('todos', 'is_private')) {
      db.exec(`ALTER TABLE todos ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`);
    }
    const aiCols = db.prepare(`PRAGMA table_info(ai_settings)`).all().map(c => c.name);
    const add = (name, sql) => { if (!aiCols.includes(name)) db.exec(`ALTER TABLE ai_settings ADD COLUMN ${sql}`); };
    add('drift_days',            'drift_days INTEGER NOT NULL DEFAULT 21');
    add('theme_tag_threshold',   'theme_tag_threshold REAL NOT NULL DEFAULT 0.7');
    add('weekly_digest_enabled', 'weekly_digest_enabled INTEGER NOT NULL DEFAULT 0');
    add('weekly_digest_dow',     'weekly_digest_dow INTEGER NOT NULL DEFAULT 0');
    add('weekly_digest_hour',    'weekly_digest_hour INTEGER NOT NULL DEFAULT 18');
  })();
  
  // ── Attachments ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref_type   TEXT NOT NULL,
      ref_id     TEXT NOT NULL,
      filename   TEXT NOT NULL,
      stored_as  TEXT NOT NULL,
      mime_type  TEXT NOT NULL DEFAULT '',
      size       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_ref ON attachments(ref_type, ref_id);
  `);
  
  // ── Migration: last_active_at für Users ──────────────────────
  {
    const cols = db.prepare('PRAGMA table_info(users)').all();
    if (!cols.find(c => c.name === 'last_active_at')) {
      db.exec("ALTER TABLE users ADD COLUMN last_active_at TEXT NOT NULL DEFAULT ''");
    }
  }
  
  // ── Migration: Stack-Layer (Erweiterung v1.1, Phase 2) ───────
  db.exec(`
    CREATE TABLE IF NOT EXISTS stack_frames (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ref_type        TEXT NOT NULL,
      ref_id          TEXT NOT NULL,
      next_step_note  TEXT NOT NULL,
      pushed_at       TEXT NOT NULL,
      popped_at       TEXT,
      parent_frame_id TEXT,
      pop_resolution  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stack_user_open ON stack_frames(user_id, popped_at);
    CREATE INDEX IF NOT EXISTS idx_stack_ref       ON stack_frames(ref_type, ref_id);
  `);
  
  // ── Migration: Contacts (Ansprechpartner) ────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT '',
      email       TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, sort_order, created_at);
  `);
  
  // ── Migration: Topic-Hierarchie (Wissensmanagement v2) ───────
  {
    const cols = db.prepare('PRAGMA table_info(themes)').all();
    if (!cols.find(c => c.name === 'parent_id')) {
      db.exec('ALTER TABLE themes ADD COLUMN parent_id TEXT REFERENCES themes(id) ON DELETE SET NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_themes_parent ON themes(parent_id)');
    }
  }
  
  // ── Migration: Wissensseiten (Wissensmanagement v2) ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_pages (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_pages_user ON knowledge_pages(user_id);
    CREATE TABLE IF NOT EXISTS knowledge_topic_links (
      id                 TEXT PRIMARY KEY,
      knowledge_page_id  TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      theme_id           TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
      created_at         TEXT NOT NULL,
      UNIQUE(knowledge_page_id, theme_id)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_links_page  ON knowledge_topic_links(knowledge_page_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_links_theme ON knowledge_topic_links(theme_id);
  `);
  
  // ── Migration: FTS5-Volltextindex (Wissensmanagement v2, Phase 4) ──
  // Ersetzt die frühere client-seitige LIKE-Suche durch einen echten Volltextindex
  // mit Relevanz-Ranking (bm25), der auch Wissensseiten mit abdeckt.
  {
    const ftsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='search_index'"
    ).get();
    if (!ftsExists) {
      db.transaction(() => {
        db.exec(`
          CREATE VIRTUAL TABLE search_index USING fts5(
            ref_type UNINDEXED, ref_id UNINDEXED, user_id UNINDEXED, title, body
          );
        `);
        db.exec(`
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'meeting', id, user_id, title, description FROM meetings;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'theme', id, user_id, title, description FROM themes;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'topic', t.id, m.user_id, t.title, t.description || ' ' || t.result
            FROM topics t JOIN meetings m ON m.id = t.meeting_id;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'todo', id, user_id, title, description || ' ' || result FROM todos;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'contact', id, user_id, name,
              COALESCE(role,'') || ' ' || COALESCE(email,'') || ' ' || COALESCE(description,'') FROM contacts;
          INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
            SELECT 'knowledge', id, user_id, title, content FROM knowledge_pages;
        `);
        db.exec(`
          CREATE TRIGGER trg_search_meetings_ai AFTER INSERT ON meetings BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('meeting', new.id, new.user_id, new.title, new.description);
          END;
          CREATE TRIGGER trg_search_meetings_au AFTER UPDATE ON meetings BEGIN
            DELETE FROM search_index WHERE ref_type='meeting' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('meeting', new.id, new.user_id, new.title, new.description);
          END;
          CREATE TRIGGER trg_search_meetings_ad AFTER DELETE ON meetings BEGIN
            DELETE FROM search_index WHERE ref_type='meeting' AND ref_id=old.id;
          END;
  
          CREATE TRIGGER trg_search_themes_ai AFTER INSERT ON themes BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('theme', new.id, new.user_id, new.title, new.description);
          END;
          CREATE TRIGGER trg_search_themes_au AFTER UPDATE ON themes BEGIN
            DELETE FROM search_index WHERE ref_type='theme' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('theme', new.id, new.user_id, new.title, new.description);
          END;
          CREATE TRIGGER trg_search_themes_ad AFTER DELETE ON themes BEGIN
            DELETE FROM search_index WHERE ref_type='theme' AND ref_id=old.id;
          END;
  
          CREATE TRIGGER trg_search_topics_ai AFTER INSERT ON topics BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
              SELECT 'topic', new.id, m.user_id, new.title, new.description || ' ' || new.result FROM meetings m WHERE m.id = new.meeting_id;
          END;
          CREATE TRIGGER trg_search_topics_au AFTER UPDATE ON topics BEGIN
            DELETE FROM search_index WHERE ref_type='topic' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body)
              SELECT 'topic', new.id, m.user_id, new.title, new.description || ' ' || new.result FROM meetings m WHERE m.id = new.meeting_id;
          END;
          CREATE TRIGGER trg_search_topics_ad AFTER DELETE ON topics BEGIN
            DELETE FROM search_index WHERE ref_type='topic' AND ref_id=old.id;
          END;
  
          CREATE TRIGGER trg_search_todos_ai AFTER INSERT ON todos BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('todo', new.id, new.user_id, new.title, new.description || ' ' || new.result);
          END;
          CREATE TRIGGER trg_search_todos_au AFTER UPDATE ON todos BEGIN
            DELETE FROM search_index WHERE ref_type='todo' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('todo', new.id, new.user_id, new.title, new.description || ' ' || new.result);
          END;
          CREATE TRIGGER trg_search_todos_ad AFTER DELETE ON todos BEGIN
            DELETE FROM search_index WHERE ref_type='todo' AND ref_id=old.id;
          END;
  
          CREATE TRIGGER trg_search_contacts_ai AFTER INSERT ON contacts BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
              COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
          END;
          CREATE TRIGGER trg_search_contacts_au AFTER UPDATE ON contacts BEGIN
            DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('contact', new.id, new.user_id, new.name,
              COALESCE(new.role,'') || ' ' || COALESCE(new.email,'') || ' ' || COALESCE(new.description,''));
          END;
          CREATE TRIGGER trg_search_contacts_ad AFTER DELETE ON contacts BEGIN
            DELETE FROM search_index WHERE ref_type='contact' AND ref_id=old.id;
          END;
  
          CREATE TRIGGER trg_search_knowledge_ai AFTER INSERT ON knowledge_pages BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content);
          END;
          CREATE TRIGGER trg_search_knowledge_au AFTER UPDATE ON knowledge_pages BEGIN
            DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content);
          END;
          CREATE TRIGGER trg_search_knowledge_ad AFTER DELETE ON knowledge_pages BEGIN
            DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
          END;
        `);
      })();
    }
  }
  
  // ── Migration: Wissensseiten-Verknüpfungen (Wissensmanagement v2.1, Block A) ──
  // Ungerichtete Verknüpfung zwischen zwei Wissensseiten. Ungerichtetheit wird
  // strukturell erzwungen: vor jedem Insert werden die beiden IDs lexikografisch
  // sortiert (a < b), das CHECK verhindert Selbstverweise, UNIQUE liefert Idempotenz.
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_links (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id)            ON DELETE CASCADE,
      page_a_id  TEXT NOT NULL REFERENCES knowledge_pages(id)  ON DELETE CASCADE,
      page_b_id  TEXT NOT NULL REFERENCES knowledge_pages(id)  ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      UNIQUE(page_a_id, page_b_id),
      CHECK(page_a_id < page_b_id)
    );
    CREATE INDEX IF NOT EXISTS idx_klinks_a ON knowledge_links(page_a_id);
    CREATE INDEX IF NOT EXISTS idx_klinks_b ON knowledge_links(page_b_id);
  `);
  
  // ── Migration: Graph-Knoten-Positionen (Wissensmanagement v2.1, Paket 1b) ──
  // Nur das Schema wird hier angelegt; Routen dafür gehören zu einem separaten
  // Arbeitspaket (Graph-Modul).
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_node_positions (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      node_type  TEXT NOT NULL,
      node_id    TEXT NOT NULL,
      x          REAL NOT NULL,
      y          REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, node_type, node_id)
    ) WITHOUT ROWID;
  `);
  
  // ── Migration: knowledge_pages.content_text + FTS-Neuaufbau (Wissensmanagement v2.1, Block A) ──
  // content_text hält den auf reinen Text reduzierten Inhalt (via htmlToText) für
  // FTS/Snippets; content bleibt das sanitized HTML für die Anzeige.
  {
    const hasContentText = db.prepare('PRAGMA table_info(knowledge_pages)').all().some(c => c.name === 'content_text');
    if (!hasContentText) {
      db.transaction(() => {
        db.exec(`ALTER TABLE knowledge_pages ADD COLUMN content_text TEXT NOT NULL DEFAULT ''`);
  
        const pages = db.prepare('SELECT id, content FROM knowledge_pages').all();
        const updText = db.prepare('UPDATE knowledge_pages SET content_text=? WHERE id=?');
        for (const p of pages) updText.run(htmlToText(p.content || ''), p.id);
  
        // Drop + recreate the three FTS triggers so they index content_text instead of raw content.
        db.exec(`
          DROP TRIGGER IF EXISTS trg_search_knowledge_ai;
          DROP TRIGGER IF EXISTS trg_search_knowledge_au;
          DROP TRIGGER IF EXISTS trg_search_knowledge_ad;
  
          CREATE TRIGGER trg_search_knowledge_ai AFTER INSERT ON knowledge_pages BEGIN
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content_text);
          END;
          CREATE TRIGGER trg_search_knowledge_au AFTER UPDATE ON knowledge_pages BEGIN
            DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
            INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', new.id, new.user_id, new.title, new.content_text);
          END;
          CREATE TRIGGER trg_search_knowledge_ad AFTER DELETE ON knowledge_pages BEGIN
            DELETE FROM search_index WHERE ref_type='knowledge' AND ref_id=old.id;
          END;
        `);
  
        // Reindex all existing knowledge rows in search_index with the new body.
        db.exec(`DELETE FROM search_index WHERE ref_type='knowledge'`);
        const reindex = db.prepare(
          `INSERT INTO search_index(ref_type, ref_id, user_id, title, body) VALUES ('knowledge', ?, ?, ?, ?)`
        );
        for (const p of db.prepare('SELECT id, user_id, title, content_text FROM knowledge_pages').all()) {
          reindex.run(p.id, p.user_id, p.title, p.content_text);
        }
      })();
    }
  }
}

module.exports = { runCoreMigrations };
