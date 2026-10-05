/**
 * Сервис демо-данных (fallback): если YummyAnime недоступен из окружения,
 * приложение остаётся полностью работоспособным (мастер-промпт #103).
 * Данные помечаются source: 'demo', UI показывает предупреждение.
 */
import { AnimeCard, AnimeDetails, SectionPage, SiteSectionId, VideoEntry } from '@/lib/avc/types'

function p(title: string) {
  return `https://placehold.co/300x420/16161e/c9a86a/png?text=${encodeURIComponent(title)}`
}

interface DemoAnime {
  id: number
  slug: string
  title: string
  year: number
  rating: number
  status: string
  type: string
  aired: number
  total: number | null
  dubs: string[]
  desc: string
}

const DEMO: DemoAnime[] = [
  { id: 70, slug: 'berserk', title: 'Берсерк', year: 1997, rating: 9.08, status: 'вышел', type: 'ТВ', aired: 25, total: 25, dubs: ['Озвучка MC Entertainment', 'Субтитры AniLibria'], desc: 'Таинственный воин, называющий себя Чёрным мечником, жаждет заполучить голову короля страны Midland.' },
  { id: 1512, slug: 'van-pis-tv', title: 'Ван-Пис', year: 1999, rating: 9.13, status: 'онгоинг', type: 'ТВ', aired: 1122, total: null, dubs: ['Озвучка AniDUB', 'Озвучка Anilibria', 'Субтитры Shimizu'], desc: 'Гол Д. Роджер — король пиратов, добившийся богатства, славы и власти.' },
  { id: 1513, slug: 'izgnannyy-reinkarnirovannyy-tyazhelyy-rycar', title: 'Изгнанный реинкарнированный тяжёлый рыцарь не имеет себе равных в знаниях игры', year: 2026, rating: 8.4, status: 'онгоинг', type: 'ТВ', aired: 12, total: 26, dubs: ['Озвучка Studio Band', 'Озвучка AniStar', 'Субтитры Crunchyroll'], desc: 'Рыцарь изгнан и реинкарнирован; его знания игры не имеют себе равных. Пример тайтла со страницей «12 из 26».' },
  { id: 1001, slug: 'naruto', title: 'Наруто', year: 2002, rating: 8.7, status: 'вышел', type: 'ТВ', aired: 220, total: 220, dubs: ['Озвучка 2x2', 'Озвучка AniDUB'], desc: 'Наруто Узумаки — шумный юный ниндзя, мечтающий стать Хокаге.' },
  { id: 1002, slug: 'kod-giass', title: 'Код Гиасс: Восставший Лелуш', year: 2006, rating: 9.02, status: 'вышел', type: 'ТВ', aired: 25, total: 25, dubs: ['Озвучка AniLibria', 'СубтитрыLE'], desc: 'Лелуш получает силу Гиасса и начинает войну против Британской империи.' },
  { id: 1003, slug: 'stalen-alhimik-bratstvo', title: 'Стальной алхимик: Братство', year: 2009, rating: 9.24, status: 'вышел', type: 'ТВ', aired: 64, total: 64, dubs: ['Озвучка AniDUB', 'Озвучка Anilibria'], desc: 'Двое братьев-алхимиков ищут философский камень, чтобы вернуть телам утраченное.' },
  { id: 1004, slug: 'ataki-titanov', title: 'Атака титанов', year: 2013, rating: 9.1, status: 'вышел', type: 'ТВ', aired: 87, total: 87, dubs: ['Озвучка AniStar', 'СубтитрыDream'], desc: 'Человечество живёт за стенами от гигантских титанов.' },
  { id: 1005, slug: 'kimetsu-no-yaiba', title: 'Клинок, рассекающий демонов', year: 2019, rating: 8.9, status: 'вышел', type: 'ТВ', aired: 55, total: 55, dubs: ['Озвучка AniDUB', 'Озвучка Studio Band'], desc: 'Танджиро становится охотником на демонов, чтобы спасти сестру.' },
  { id: 1006, slug: 're-zero', title: 'Re:Zero. Жизнь с нуля в альтернативном мире', year: 2016, rating: 8.6, status: 'онгоинг', type: 'ТВ', aired: 13, total: 16, dubs: ['Озвучка Anilibria', 'СубтитрыKashi'], desc: 'Субару попадает в фэнтезийный мир и получает способность «Возврат к смерти».' },
  { id: 1007, slug: 'one-punch-man', title: 'Ванпанчмен', year: 2015, rating: 8.8, status: 'вышел', type: 'ТВ', aired: 24, total: 24, dubs: ['Озвучка AniStar', 'Озвучка AniDUB'], desc: 'Сайтама — герой, побеждающий любого врага одним ударом.' },
  { id: 1008, slug: 'vinland-saga', title: 'Сага о Винланде', year: 2019, rating: 9.0, status: 'вышел', type: 'ТВ', aired: 48, total: 48, dubs: ['Озвучка Anilibria', 'СубтитрыLE'], desc: 'Торфинн, юный викинг, клянётся отомстить за убийство отца.' },
  { id: 1009, slug: 'spy-x-family', title: 'Семья шпиона', year: 2022, rating: 8.7, status: 'онгоинг', type: 'ТВ', aired: 8, total: 12, dubs: ['Озвучка Studio Band', 'СубтитрыCrunchyroll'], desc: 'Шпион собирает фальшивую семью для задания.' },
]

function toCard(d: DemoAnime): AnimeCard {
  return {
    animeId: d.id,
    slug: d.slug,
    title: d.title,
    poster: p(d.title.slice(0, 18)),
    year: d.year,
    rating: d.rating,
    status: d.status,
    type: d.type,
  }
}

function toDetails(d: DemoAnime): AnimeDetails {
  const dubs = d.dubs.map((name) => ({
    name,
    shortName: name.replace(/^(Озвучка|Субтитры)\s*/, ''),
    episodes: Array.from({ length: d.aired }, (_, i) => i + 1),
  }))
  const videos: VideoEntry[] = []
  for (const dub of d.dubs) {
    for (let ep = 1; ep <= d.aired; ep++) {
      videos.push({
        videoId: d.id * 10000 + ep * 100 + d.dubs.indexOf(dub),
        episode: ep,
        dubName: dub,
        playerName: 'Демо-плеер',
        iframeUrl: '',
        duration: 1420,
      })
    }
  }
  return {
    ...toCard(d),
    description: d.desc,
    genres: ['Экшен', 'Драма'],
    studios: ['Demo Studio'],
    episodesAired: d.aired,
    episodesTotal: d.total,
    dubs,
    videos,
  }
}

export function demoSection(section: SiteSectionId, page = 1): SectionPage {
  let items: AnimeCard[]
  switch (section) {
    case 'ongoing':
      items = DEMO.filter((d) => d.status === 'онгоинг').map(toCard)
      break
    case 'announcements':
      items = DEMO.filter((d) => d.total !== null && d.aired === 0).map(toCard)
      break
    case 'top100':
      items = [...DEMO].sort((a, b) => b.rating - a.rating).map(toCard)
      break
    case 'schedule':
      items = DEMO.filter((d) => d.status === 'онгоинг').map(toCard)
      break
    case 'catalog':
      items = DEMO.map(toCard)
      break
    default:
      items = DEMO.map(toCard)
  }
  return {
    section,
    title: SECTION_TITLES[section],
    page,
    totalPages: 1,
    items,
    source: 'demo',
  }
}

export const SECTION_TITLES: Record<SiteSectionId, string> = {
  home: 'Главная',
  catalog: 'Каталог аниме',
  ongoing: 'Онгоинги',
  announcements: 'Анонсы',
  schedule: 'Расписание онгоингов',
  top100: 'ТОП-100',
  random: 'Случайное аниме',
}

export function demoSearch(query: string): AnimeCard[] {
  const q = query.toLowerCase()
  return DEMO.filter((d) => d.title.toLowerCase().includes(q) || d.slug.includes(q)).map(toCard)
}

export function demoDetails(idOrSlug: number | string): AnimeDetails | null {
  const d = DEMO.find((x) =>
    typeof idOrSlug === 'number' ? x.id === idOrSlug : x.slug === idOrSlug,
  )
  return d ? toDetails(d) : null
}

export function demoRandom(): AnimeDetails {
  const d = DEMO[Math.floor(Math.random() * DEMO.length)]
  return toDetails(d)
}
