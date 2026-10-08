// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, afterAll } from 'vitest';
import { openStore, RevisionConflictError } from '../../services/personalization/db';
import { emptyPreferences } from '../../services/personalization/preferences';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashy-db-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const prefs = (hidden) => ({ ...emptyPreferences(), hiddenGlobalLinkIds: hidden });

describe('SQLite preference store', () => {
  it('runs migrations, enables WAL, and records the schema version', () => {
    const file = path.join(tmp, 'a', 'tools.sqlite');
    const store = openStore(file);
    expect(store.schemaVersion()).toBe(1);
    store.close();
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(raw.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('user_preferences')).toBeTruthy();
    raw.close();
    // Re-opening doesn't re-apply migrations
    const again = openStore(file);
    expect(again.schemaVersion()).toBe(1);
    again.close();
  });

  it('isolates records by identity key', () => {
    const store = openStore(path.join(tmp, 'iso.sqlite'));
    store.save('iss\u0000alice', prefs(['x']), 0);
    expect(store.get('iss\u0000bob')).toBeNull();
    expect(store.get('other-iss\u0000alice')).toBeNull();
    expect(store.get('iss\u0000alice').preferences.hiddenGlobalLinkIds).toEqual(['x']);
    store.close();
  });

  it('enforces optimistic revisions on save and delete', () => {
    const store = openStore(path.join(tmp, 'rev.sqlite'));
    expect(store.save('k', prefs(['a']), 0).revision).toBe(1);
    expect(store.save('k', prefs(['b']), 1).revision).toBe(2);
    expect(() => store.save('k', prefs(['c']), 1)).toThrow(RevisionConflictError);
    try { store.save('k', prefs(['c']), 1); } catch (e) { expect(e.currentRevision).toBe(2); }
    expect(() => store.save('new', prefs([]), 5)).toThrow(RevisionConflictError);
    expect(() => store.remove('k', 1)).toThrow(RevisionConflictError);
    expect(store.get('k').preferences.hiddenGlobalLinkIds).toEqual(['b']);
    store.remove('k', 2);
    expect(store.get('k')).toBeNull();
    store.close();
  });

  it('survives process restarts (close + reopen of the same file)', () => {
    const file = path.join(tmp, 'restart.sqlite');
    const s1 = openStore(file);
    s1.save('k', prefs(['keep']), 0);
    s1.close();
    const s2 = openStore(file);
    expect(s2.get('k')).toMatchObject({ revision: 1, preferences: { hiddenGlobalLinkIds: ['keep'] } });
    s2.close();
  });

  it('backs up with VACUUM INTO and restores from the snapshot', () => {
    const file = path.join(tmp, 'live.sqlite');
    const backupFile = path.join(tmp, 'backups', 'snap.sqlite');
    const store = openStore(file);
    store.save('k', prefs(['before-backup']), 0);
    store.backup(backupFile);
    store.save('k', prefs(['after-backup']), 1);
    expect(() => store.backup(backupFile)).toThrow(/already exists/);
    store.close();
    // Restore = stop app, replace the DB file with the snapshot, start app
    const restoredFile = path.join(tmp, 'restored.sqlite');
    fs.copyFileSync(backupFile, restoredFile);
    const restored = openStore(restoredFile);
    expect(restored.get('k').preferences.hiddenGlobalLinkIds).toEqual(['before-backup']);
    restored.close();
  });

  it('refuses to start against a database from a newer app version', () => {
    const file = path.join(tmp, 'future.sqlite');
    openStore(file).close();
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO schema_migrations (version, name) VALUES (99, ?)').run('future');
    raw.close();
    expect(() => openStore(file)).toThrow(/newer than this app supports/);
  });

  it('serves defaults instead of crashing on a corrupt stored document', () => {
    const file = path.join(tmp, 'corrupt.sqlite');
    const store = openStore(file);
    store.save('k', prefs([]), 0);
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE user_preferences SET preferences_json = ?').run('{not json');
    raw.close();
    expect(store.get('k')).toMatchObject({ revision: 1, preferences: null });
    store.close();
  });

  it('treats identity keys as data, never as SQL', () => {
    const store = openStore(path.join(tmp, 'sqli.sqlite'));
    const evil = "x'; DROP TABLE user_preferences; --";
    store.save(evil, prefs([]), 0);
    expect(store.get(evil).revision).toBe(1);
    expect(store.isHealthy()).toBe(true);
    store.close();
  });
});
