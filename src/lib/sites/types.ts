/**
 * Контракт адаптера аниме-сайта (мастер-промпт #78).
 * Новый сайт = новая реализация этого интерфейса; остальное приложение не меняется.
 */
import {
  AnimeCard,
  AnimeDetails,
  SectionPage,
  SiteSectionId,
  VideoEntry,
} from '@/lib/avc/types'

export interface SiteDiagnostics {
  name: string
  ok: boolean
  detail: string
}

export interface IAnimeSiteAdapter {
  readonly siteName: string
  readonly baseUrl: string

  searchAnime(query: string): Promise<AnimeCard[]>
  getAnimeById(id: number): Promise<AnimeDetails | null>
  getAnimeBySlug(slug: string): Promise<AnimeDetails | null>
  getSection(section: SiteSectionId, page?: number): Promise<SectionPage>
  getRandom(): Promise<AnimeDetails | null>
  getVideos(animeId: number): Promise<VideoEntry[]>
  runDiagnostics(): Promise<SiteDiagnostics[]>
}
