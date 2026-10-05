'use client'
/**
 * SeaBackground — морской фон позади интерфейса (fixed, z-0).
 *
 * УРОК РЕЛИЗА 1.0.11 («лагающее говно»): предыдущая аквариумная тема
 * анимировала 4 слоя blur(70px) + mix-blend-mode: screen, световые лучи,
 * SVG-волны и пузырьки, а панели размывала backdrop-filter'ом. На слабых
 * GPU рендерер захлёбывался: в браузерном превью — слайдшоу, в EXE —
 * растянутая на десятки секунд первая отрисовка окна.
 *
 * НОВАЯ ТЕМА — СТАТИЧНАЯ: один div с многослойным CSS-градиентом
 * (глубина + свет у поверхности + teal/cyan-свечения + виньетка).
 * Рисуется один раз, ноль анимаций, ноль filter/mix-blend/backdrop-filter —
 * нулевая постоянная нагрузка на GPU, вид остаётся «морским с градиентами».
 * pointer-events-none + aria-hidden: фон не мешает interaction/скринридерам.
 */
export function SeaBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {/* Морская глубина: свет у поверхности → бездна внизу + мягкие свечения */}
      <div className="sea-bg absolute inset-0" />
      {/* Виньетка: края темнее, контент читается (статично) */}
      <div className="sea-vignette absolute inset-0" />
    </div>
  )
}
