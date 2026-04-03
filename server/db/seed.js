function seedDb({ db, uuidv4, log }) {
  try {
    const adminPerm = JSON.stringify({ full: true });
    const userPerm = JSON.stringify({
      servers: 'all', playbooks: 'all', plugins: 'all',
      canViewServers: true, canAddServers: true, canEditServers: true, canDeleteServers: true,
      canViewPlaybooks: true, canEditPlaybooks: true, canDeletePlaybooks: true, canRunPlaybooks: true,
      canViewSchedules: true, canAddSchedules: true, canEditSchedules: true, canDeleteSchedules: true, canToggleSchedules: true,
      canViewVars: true, canAddVars: true, canEditVars: true, canDeleteVars: true,
      canViewAudit: true,
    });
    db.prepare(`INSERT OR IGNORE INTO roles (id, name, is_system, permissions) VALUES ('admin', 'Admin', 1, ?)`).run(adminPerm);
    db.prepare(`INSERT OR IGNORE INTO roles (id, name, is_system, permissions) VALUES ('user', 'User', 1, ?)`).run(userPerm);
  } catch (e) {
    log.error({ err: e }, 'Role seed error');
  }

  try {
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (userCount > 0) return;
    const hash = db.prepare("SELECT value FROM app_settings WHERE key = 'auth_password_hash'").get();
    if (!hash || !String(hash.value || '').trim()) return;
    const usernameRow = db.prepare("SELECT value FROM app_settings WHERE key = 'auth_username'").get();
    const emailRow = db.prepare("SELECT value FROM app_settings WHERE key = 'auth_email'").get();
    const totpSecretRow = db.prepare("SELECT value FROM app_settings WHERE key = 'totp_secret'").get();
    const totpEnabledRow = db.prepare("SELECT value FROM app_settings WHERE key = 'totp_enabled'").get();
    const id = uuidv4();
    const username = (usernameRow && usernameRow.value) ? usernameRow.value : 'admin';
    const email = (emailRow && emailRow.value) ? emailRow.value : '';
    const totpSecret = (totpSecretRow && totpSecretRow.value) ? totpSecretRow.value : '';
    const totpEnabled = (totpEnabledRow && totpEnabledRow.value === '1') ? 1 : 0;
    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, totp_secret, totp_enabled)
      VALUES (?, ?, ?, ?, 'admin', ?, ?)
    `).run(id, username, email, hash.value, totpSecret, totpEnabled);
    log.info('Migrated admin user from settings to users table');
  } catch (e) {
    log.error({ err: e }, 'Admin migration error');
  }
}

module.exports = { seedDb };
