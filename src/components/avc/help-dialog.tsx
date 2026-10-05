'use client'
/**
 * HelpDialog — справка по голосовым командам, сгруппированная по категориям.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAvcStore } from '@/lib/avc/store'

interface CommandGroup {
  title: string
  items: string[]
}

const GROUPS: CommandGroup[] = [
  {
    title: 'Навигация',
    items: [
      'открой главную',
      'открой каталог',
      'открой топ сто',
      'покажи онгоинги',
      'покажи анонсы',
      'открой расписание',
      'открой случайное',
      'прокрути вниз / вверх',
      'обнови',
      'назад',
    ],
  },
  {
    title: 'Поиск и аниме',
    items: [
      'найди берсерк',
      'найди стальной алхимик',
      'открой берсерк',
      'открой клейм в новой вкладке',
      'первый вариант',
      'второй вариант',
      'покажи серии',
    ],
  },
  {
    title: 'Серии',
    items: [
      'включи пятую серию',
      'серия 12',
      'двадцать первая',
      'следующая серия',
      'предыдущая серия',
      'включи следующую',
    ],
  },
  {
    title: 'Плеер',
    items: [
      'запусти — старт серии голосом, без клика',
      'включи / пауза / стоп',
      'вперед на десять секунд',
      'назад на тридцать секунд',
      'громче',
      'тише',
      'громкость 50',
      'полный экран',
      'выйти из полного экрана',
    ],
  },
  {
    title: 'Звук',
    items: ['выключи звук', 'включи звук — снимет mute даже плеера', 'убери звук', 'верни звук'],
  },
  {
    title: 'Перемотка',
    items: [
      'перемотай на 20 секунд',
      'на 2 минуты назад',
      'вперёд на полминуты',
      'секунд 30 назад',
      'сто двадцать секунд вперёд',
    ],
  },
  {
    title: 'Библиотека и прогресс (аккаунт сайта + трекинг приложения)',
    items: [
      'добавь в смотрю',
      'добавь в планы',
      'просмотрено',
      'брошено',
      'отложи на потом',
      'добавь в избранное / убери из избранного',
      'оцени на 8 — оценка от 1 до 10',
      'поставь оценку десять',
      'убери оценку',
      'что я смотрю — ответ: тайтл, серия, озвучка',
      'на какой серии я',
      'мой прогресс',
      'продолжить просмотр',
      'открой библиотеку — списки аккаунта с сайта',
    ],
  },
  {
    title: 'Озвучки',
    items: [
      'переключи на анилибрию',
      'следующая озвучка',
      'вторая озвучка',
      'добавь X как команду для Y',
    ],
  },
  {
    title: 'Вкладки',
    items: [
      'новая вкладка',
      'закрой вкладку',
      'следующая вкладка',
      'предыдущая вкладка',
      'вкладка три',
      'вперед',
    ],
  },
]

const HOTKEYS: { keys: string; action: string }[] = [
  { keys: 'Ctrl + Space', action: 'Диктовка (удерживать)' },
  { keys: 'Space', action: 'Пауза / воспроизведение' },
  { keys: '← / →', action: 'Перемотка на 10 секунд' },
  { keys: 'Shift + ← / →', action: 'Перемотка на 30 секунд' },
  { keys: '↑ / ↓', action: 'Громкость' },
  { keys: 'N / P', action: 'Следующая / предыдущая серия' },
  { keys: 'F', action: 'Полный экран' },
  { keys: 'M', action: 'Выключить / включить звук' },
]

export function HelpDialog() {
  const open = useAvcStore((s) => s.helpOpen)
  const setOpen = useAvcStore((s) => s.setHelpOpen)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto avc-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Голосовые команды</DialogTitle>
          <DialogDescription>
            Говорите естественным языком. Контекст учитывается: «двадцать» при открытом
            аниме — это серия, «назад» во время видео — предыдущая серия.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-sky-400/40">
                {group.title}
              </h3>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-foreground">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400/40" aria-hidden />
                    <span>«{item}»</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-sky-400/40">
            Горячие клавиши
          </h3>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {HOTKEYS.map((hk) => (
              <li
                key={hk.keys}
                className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs"
              >
                <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-sky-300">
                  {hk.keys}
                </kbd>
                <span className="text-muted-foreground">{hk.action}</span>
              </li>
            ))}
          </ul>
        </section>

        <p className="mt-2 rounded-lg border border-border bg-card/60 p-3 text-xs leading-relaxed text-muted-foreground">
          Если локальный парсер не уверен во фразе, включается LLM-fallback — команда будет
          понята гибче (отключается в Настройках → Приватность). Wake word: включите в
          настройках, чтобы команды срабатывали только после слова-активатора. При неуверенном
          названии озвучки приложение переспросит перед переключением.
        </p>
      </DialogContent>
    </Dialog>
  )
}
