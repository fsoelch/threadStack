/*
 * ThreadStack — DB-Backup & Wiederherstellung (Arbeitspaket B3, Admin, Web-only)
 *
 * Exponiert ausschließlich window.TSBackup = { mount(el) }.
 * Konsumiert window.TSHost (api, toast, escHtml, confirm, uploadRaw,
 * forceLogout) - siehe public/momentum.js für das identische
 * Integrationsmuster. Rendert eine komplette Ansicht innerhalb des
 * bestehenden #backup-modal-Rahmens (index.html): Zeitplan, Backup-Liste,
 * Datei-Upload-Restore, inkl. Leer-/Lade-/Fehlerzustand.
 *
 * Nutzt bewusst bestehende, projektweite CSS-Klassen (.form-group,
 * .form-control, .form-row, .btn*, .form-error) statt eines eigenen
 * Formular-Stils - siehe public/backup.css für die wenigen wirklich neuen
 * Klassen (Liste, Typ-Badge, Zustände).
 *
 * Keine Fremdbibliothek, kein Build-Step.
 */
(function (root) {
  'use strict';

  function host() {
    if (!root.TSHost) throw new Error('TSBackup: TSHost ist nicht verfügbar');
    return root.TSHost;
  }

  function esc(s) {
    return host().escHtml(s == null ? '' : String(s));
  }

  function formatBytes(n) {
    const num = Number(n) || 0;
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTimestamp(iso) {
    if (!iso) return '';
    const [datePart, timePart] = String(iso).split('T');
    const [y, m, d] = (datePart || '').split('-');
    const time = (timePart || '').slice(0, 5);
    if (!y || !m || !d) return iso;
    return `${d}.${m}.${y} ${time} Uhr`;
  }

  const TYPE_LABELS = { manual: 'manuell', auto: 'automatisch', prerestore: 'vor Restore' };
  function typeLabel(type) { return TYPE_LABELS[type] || type; }

  // ── Datenzugriff ─────────────────────────────────────────────
  function fetchSettings() { return host().api('GET', '/backup/settings'); }
  function saveSettings(patch) { return host().api('PUT', '/backup/settings', patch); }
  function fetchBackups() { return host().api('GET', '/backup/'); }
  function createBackup() { return host().api('POST', '/backup/'); }
  function deleteBackup(filename) { return host().api('DELETE', `/backup/${encodeURIComponent(filename)}`); }
  function restoreBackup(filename) { return host().api('POST', `/backup/${encodeURIComponent(filename)}/restore`); }
  function restoreUpload(file) { return host().uploadRaw('/backup/restore-upload', file); }

  // Nächster geplanter Lauf, rein clientseitig aus der Server-Stunde
  // berechnet (informativ - die verbindliche Ausführung liegt serverseitig
  // im Backup-Scheduler).
  function describeNextRun(settings) {
    if (!settings.enabled) return null;
    const now = new Date();
    const next = new Date(now);
    next.setHours(settings.hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const isToday = next.toDateString() === now.toDateString();
    const hh = String(settings.hour).padStart(2, '0');
    return `${isToday ? 'heute' : 'morgen'}, ${hh}:00 Uhr`;
  }

  function renderSettingsForm(settings) {
    const nextRun = describeNextRun(settings);
    const hourOptions = Array.from({ length: 24 }, (_, h) =>
      `<option value="${h}" ${h === settings.hour ? 'selected' : ''}>${String(h).padStart(2, '0')} Uhr</option>`
    ).join('');
    return `
      <div class="backup-section">
        <h3>Automatisches Backup</h3>
        <form data-backup-settings-form>
          <label class="backup-toggle-row">
            <input type="checkbox" data-backup-field="enabled" ${settings.enabled ? 'checked' : ''}>
            Aktiviert
          </label>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="backup-hour">Uhrzeit</label>
              <select class="form-control" id="backup-hour" data-backup-field="hour" ${settings.enabled ? '' : 'disabled'}>${hourOptions}</select>
            </div>
            <div class="form-group">
              <label class="form-label" for="backup-retention">Aufbewahrung <span class="opt">(automatische Backups)</span></label>
              <input class="form-control" type="number" id="backup-retention" data-backup-field="retentionCount" min="1" max="100" value="${settings.retentionCount}" ${settings.enabled ? '' : 'disabled'}>
            </div>
          </div>
          <div class="backup-next-run">${nextRun ? `Nächster Lauf: ${esc(nextRun)}` : 'Automatisches Backup ist deaktiviert.'}</div>
          <div class="backup-settings-error form-error" style="display:none" data-backup-settings-error></div>
          <button type="submit" class="btn btn-primary btn-sm" data-backup-settings-save>Speichern</button>
        </form>
      </div>`;
  }

  function renderBackupRow(b) {
    const label = `Backup vom ${formatTimestamp(b.createdAt)}`;
    return `
      <li class="backup-item">
        <div class="backup-item-main">
          <span class="backup-type-badge backup-type-${esc(b.type)}">${esc(typeLabel(b.type))}</span>
          <span class="backup-timestamp">${esc(formatTimestamp(b.createdAt))}</span>
          <span class="backup-size">${esc(formatBytes(b.sizeBytes))}</span>
        </div>
        <div class="backup-item-actions">
          <a class="backup-icon-btn" href="${esc(downloadUrl(b.filename))}" download="${esc(b.filename)}" aria-label="${esc(label)} herunterladen" title="Herunterladen">⬇</a>
          <button type="button" class="backup-icon-btn" data-backup-restore="${esc(b.filename)}" aria-label="${esc(label)} wiederherstellen" title="Wiederherstellen">↺</button>
          <button type="button" class="backup-icon-btn backup-icon-btn-danger" data-backup-delete="${esc(b.filename)}" aria-label="${esc(label)} löschen" title="Löschen">🗑</button>
        </div>
      </li>`;
  }

  function downloadUrl(filename) {
    const base = root.__TS_BASE__ || '';
    return `${base}/api/backup/${encodeURIComponent(filename)}/download`;
  }

  function renderBackupList(backups) {
    if (!backups.length) {
      return `<p class="backup-empty">Noch keine Backups vorhanden. Erstelle jetzt dein erstes Backup.</p>`;
    }
    return `<ul class="backup-list">${backups.map(renderBackupRow).join('')}</ul>`;
  }

  function renderUploadSection() {
    return `
      <div class="backup-section">
        <h3>Aus Datei wiederherstellen</h3>
        <label class="form-label" for="backup-upload-input">Backup-Datei auswählen</label>
        <input type="file" id="backup-upload-input" data-backup-upload-input accept=".sqlite">
        <div class="backup-upload-error form-error" style="display:none" data-backup-upload-error></div>
        <button type="button" class="btn btn-secondary btn-sm" data-backup-upload-restore disabled>Hochladen &amp; Wiederherstellen</button>
      </div>`;
  }

  function mount(el) {
    if (!el) throw new Error('TSBackup.mount: Zielelement erforderlich');
    let destroyed = false;
    let state = { settings: null, backups: [] };

    function renderError(err) {
      el.innerHTML = `
        <div class="backup-view">
          <div class="backup-error">
            <p>⚠ Backups konnten nicht geladen werden.</p>
            <button type="button" class="btn btn-secondary" data-backup-retry>Erneut versuchen</button>
          </div>
        </div>`;
      el.querySelector('[data-backup-retry]')?.addEventListener('click', () => reload());
      if (err) console.error('[backup]', err);
    }

    function renderView() {
      const { settings, backups } = state;
      el.innerHTML = `
        <div class="backup-view">
          ${renderSettingsForm(settings)}
          <div class="backup-section">
            <div class="backup-list-header">
              <h3>Backups</h3>
              <button type="button" class="btn btn-primary btn-sm" data-backup-create>Backup jetzt erstellen</button>
            </div>
            ${renderBackupList(backups)}
          </div>
          ${renderUploadSection()}
        </div>`;
      wireEvents();
    }

    async function reload() {
      if (destroyed) return;
      el.innerHTML = `<div class="backup-view"><p class="backup-loading">Lädt …</p></div>`;
      try {
        const [settings, backupsRes] = await Promise.all([fetchSettings(), fetchBackups()]);
        if (destroyed) return;
        state = { settings, backups: backupsRes.backups || [] };
        renderView();
      } catch (e) {
        if (!destroyed) renderError(e);
      }
    }

    function setBusyAttr(elm, busy) {
      if (!elm) return;
      elm.disabled = busy;
      elm.dataset.busyLabel = elm.dataset.busyLabel || elm.textContent;
      elm.textContent = busy ? '…' : elm.dataset.busyLabel;
    }

    // Server-Fehler-Envelope liefert {error, code, ...} - eine laufende
    // Backup-Operation eines anderen Admins (BACKUP_IN_PROGRESS) bzw. das
    // Rate-Limit (RATE_LIMITED) sind erwartbare, nutzerverständliche Fälle,
    // kein technischer Fehler.
    function friendlyMessage(e) {
      return (e && e.message) || 'Unbekannter Fehler.';
    }

    async function handleRestoreSuccess() {
      host().toast('Wiederherstellung abgeschlossen. Du wirst jetzt abgemeldet.', 'success');
      setTimeout(() => host().forceLogout(), 1200);
    }

    function wireEvents() {
      const form = el.querySelector('[data-backup-settings-form]');
      const enabledInput = form?.querySelector('[data-backup-field="enabled"]');
      if (enabledInput) {
        enabledInput.addEventListener('change', () => {
          const disabled = !enabledInput.checked;
          form.querySelectorAll('[data-backup-field="hour"], [data-backup-field="retentionCount"]')
            .forEach((f) => { f.disabled = disabled; });
        });
      }
      if (form) {
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const errEl = form.querySelector('[data-backup-settings-error]');
          errEl.style.display = 'none';
          const patch = {
            enabled: enabledInput.checked,
            hour: Number(form.querySelector('[data-backup-field="hour"]').value),
            retentionCount: Number(form.querySelector('[data-backup-field="retentionCount"]').value),
          };
          const saveBtn = form.querySelector('[data-backup-settings-save]');
          setBusyAttr(saveBtn, true);
          try {
            state.settings = await saveSettings(patch);
            host().toast('Zeitplan gespeichert');
            renderView();
          } catch (e) {
            errEl.textContent = friendlyMessage(e);
            errEl.style.display = '';
          } finally {
            setBusyAttr(saveBtn, false);
          }
        });
      }

      const createBtn = el.querySelector('[data-backup-create]');
      if (createBtn) {
        createBtn.addEventListener('click', async () => {
          setBusyAttr(createBtn, true);
          try {
            await createBackup();
            host().toast('Backup erstellt');
            await reload();
          } catch (e) {
            host().toast(friendlyMessage(e), 'error');
          } finally {
            setBusyAttr(createBtn, false);
          }
        });
      }

      el.querySelectorAll('[data-backup-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const filename = btn.getAttribute('data-backup-delete');
          const ok = await host().confirm({
            title: 'Backup löschen?',
            message: `Das Backup vom ${formatTimestamp(state.backups.find((b) => b.filename === filename)?.createdAt)} wird endgültig gelöscht.`,
            confirmLabel: 'Löschen',
            cancelLabel: 'Abbrechen',
            danger: true,
          });
          if (!ok) return;
          try {
            await deleteBackup(filename);
            host().toast('Backup gelöscht');
            await reload();
          } catch (e) {
            host().toast(friendlyMessage(e), 'error');
          }
        });
      });

      el.querySelectorAll('[data-backup-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const filename = btn.getAttribute('data-backup-restore');
          const createdAt = state.backups.find((b) => b.filename === filename)?.createdAt;
          const ok = await host().confirm({
            title: 'Datenbank wiederherstellen?',
            message: `Die aktuelle Datenbank wird durch den Stand vom ${formatTimestamp(createdAt)} ersetzt. Alle Nutzer (auch du) werden dabei abgemeldet und müssen sich neu anmelden. Ein Sicherheits-Backup des aktuellen Stands wird automatisch vorher erstellt.`,
            confirmLabel: 'Wiederherstellen',
            cancelLabel: 'Abbrechen',
            danger: true,
            focus: 'cancel',
          });
          if (!ok) return;
          try {
            await restoreBackup(filename);
            await handleRestoreSuccess();
          } catch (e) {
            host().toast(friendlyMessage(e), 'error');
          }
        });
      });

      const uploadInput = el.querySelector('[data-backup-upload-input]');
      const uploadBtn = el.querySelector('[data-backup-upload-restore]');
      if (uploadInput && uploadBtn) {
        uploadInput.addEventListener('change', () => {
          uploadBtn.disabled = !uploadInput.files || uploadInput.files.length === 0;
        });
        uploadBtn.addEventListener('click', async () => {
          const file = uploadInput.files && uploadInput.files[0];
          if (!file) return;
          const errEl = el.querySelector('[data-backup-upload-error]');
          errEl.style.display = 'none';
          const ok = await host().confirm({
            title: 'Datenbank wiederherstellen?',
            message: `Die aktuelle Datenbank wird durch den Inhalt der hochgeladenen Datei "${file.name}" ersetzt. Alle Nutzer (auch du) werden dabei abgemeldet und müssen sich neu anmelden. Ein Sicherheits-Backup des aktuellen Stands wird automatisch vorher erstellt.`,
            confirmLabel: 'Hochladen & Wiederherstellen',
            cancelLabel: 'Abbrechen',
            danger: true,
            focus: 'cancel',
          });
          if (!ok) return;
          setBusyAttr(uploadBtn, true);
          try {
            await restoreUpload(file);
            await handleRestoreSuccess();
          } catch (e) {
            errEl.textContent = friendlyMessage(e);
            errEl.style.display = '';
            setBusyAttr(uploadBtn, false);
          }
        });
      }
    }

    reload();
    return { reload, destroy: () => { destroyed = true; } };
  }

  root.TSBackup = { mount };

  // Reine, DOM-freie Hilfsfunktionen für node-basierte Unit-Tests - Muster
  // identisch zu public/momentum.js.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      formatBytes,
      formatTimestamp,
      typeLabel,
      describeNextRun,
      downloadUrl,
      renderBackupList,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
