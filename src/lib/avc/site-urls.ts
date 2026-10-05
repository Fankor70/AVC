/**
 * URL-хелперы реального сайта YummyAnime (проверены живыми запросами, 2025).
 *
 * ФАКТЫ О САЙТЕ (важно — не «придуманные» пути):
 *   - GET /login           → 404 (отдельной страницы входа НЕТ);
 *   - форма «Вход» ВСТРОЕНА в главную страницу (form action="/login/" method=post,
 *     плюс вход через Telegram / VK / Shikimori) → для входа открываем ГЛАВНУЮ;
 *   - /register            → 200 (страница регистрации существует);
 *   - профиль пользователя → /users/id{N} (ссылки вида /users/id{N} на сайте);
 *   - /profile             → 404 (такой страницы нет — только JSON /api/profile).
 */

/** Нормализованный базовый URL сайта (без хвостового слэша) */
export function siteBase(baseUrl: string): string {
  return (baseUrl || 'https://old.yummyani.me').replace(/\/+$/, '')
}

/**
 * Страница профиля на сайте: /users/id{N}.
 * Если id неизвестен — главная страница (там же блок «Вход»), а НЕ /profile (404).
 */
export function siteProfileUrl(baseUrl: string, userId: string | null): string {
  const base = siteBase(baseUrl)
  return userId ? `${base}/users/id${userId}` : `${base}/`
}

/** Главная страница сайта (единственное место с формой «Вход») */
export function siteLoginUrl(baseUrl: string): string {
  return siteBase(baseUrl)
}
