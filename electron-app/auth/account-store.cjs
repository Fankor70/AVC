/**
 * AccountStore — персист НЕ-секретного снимка аккаунта YummyAnime.
 *
 * Хранит ТОЛЬКО: состояние, userId/username/avatar (публичные данные профиля),
 * время последней проверки. Cookie/пароли/токены сюда НЕ попадают никогда
 * (спецификация, секции 6/15). Атомарная запись, права 0600.
 *
 * Расположение: <userData>/yummy-account.json — переживает перезапуски
 * приложения и ПК (секция 3).
 */
const fs = require('fs')
const path = require('path')

class AccountStore {
  constructor(userDataDir, log = () => {}) {
    this.file = path.join(userDataDir, 'yummy-account.json')
    this.log = log
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return null
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      // Защита от мусора: допускаем только безопасные поля
      const u = parsed.user && typeof parsed.user === 'object' ? parsed.user : null
      return {
        state: typeof parsed.state === 'string' ? parsed.state : 'unknown',
        user: u
          ? {
              userId: u.userId ?? null,
              username: u.username ?? null,
              displayName: u.displayName ?? null,
              avatarUrl: u.avatarUrl ?? null,
            }
          : null,
        lastSync: typeof parsed.lastSync === 'string' ? parsed.lastSync : null,
        source: typeof parsed.source === 'string' ? parsed.source : 'cache',
        message: typeof parsed.message === 'string' ? parsed.message : null,
      }
    } catch (e) {
      this.log(`[Auth] Account snapshot unreadable (will re-verify): ${e.message}`)
      return null
    }
  }

  save(snapshot) {
    try {
      const dir = path.dirname(this.file)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      try {
        fs.chmodSync(this.file, 0o600)
      } catch {
        /* Windows: права выставляются при создании файла */
      }
    } catch (e) {
      this.log(`[Auth] Failed to persist account snapshot: ${e.message}`)
    }
  }

  clear() {
    try {
      if (fs.existsSync(this.file)) fs.rmSync(this.file, { force: true })
    } catch (e) {
      this.log(`[Auth] Failed to clear account snapshot: ${e.message}`)
    }
  }
}

module.exports = { AccountStore }
