# YummyTV (Helandy/YummyTV) — Research Report (Task 1-c)

## 1. Repo overview

- **Project**: YummyTV — unofficial **YummyAnime client for Android TV / Android phones** (NOT WPF/Electron — it's a native Android app).
- **Stack**: Kotlin, Jetpack Compose, Ktor client (OkHttp engine), kotlinx.serialization, Room, Hilt, Media3/ExoPlayer, modular clean architecture (`core/*` + `feature/*`, `ui-tv`/`ui-mobile` variants).
- **Repo size**: 47 MB; last commit (shallow clone, master): `2026-09-30 19:09:03 +0300`.
- **Two API backends used**:
  1. `https://api.yani.tv` — the real YummyAnime JSON REST API (all site features). Evidence: `core/network/.../yani/YaniEndpoints.kt:3` (`YANI_BASE_URL`).
  2. `https://yummytv.kemonos.win/api` — the app author's **own** supplemental service (episode names/descriptions from TMDB, mapped by MyAnimeList id). Evidence: `core/network/.../yummy/YummyEndpoints.kt:4`.
- **Key insight for our project**: YummyAnime exposes a token-based JSON API on `api.yani.tv` — no cookie/PHPSESSID scraping needed. Our project currently bridges web cookies from old.yummyani.me; this API is a cleaner path (LIVE-VERIFY-NEEDED).

## 2. Endpoint table (all `https://api.yani.tv`, JSON bodies; evidence = file:line in YummyTV)

Shortcuts: `Acc=YaniAccountApi.kt` (feature/account/data/.../network/), `Det=YaniAnimeApi.kt` (feature/details), `Sea=YaniSearchApi.kt`, `Col=YaniCollectionApi.kt`, `Cmt=YaniCommentsApi.kt`, `Rev=YaniReviewsApi.kt`, `Pst=YaniPostsApi.kt`, `Msg=YaniMessagesApi.kt`, `Blg=YaniBloggerVideosApi.kt`, `Sch=YaniScheduleApi.kt`, `Top=YaniAnimeTopApi.kt`, `Lib=YaniWatchHistoryApi.kt`, `Hom=YaniHomeApi.kt`, `Pgs=YaniPagesApi.kt`.

### Auth / profile
| Method | Path | Purpose | Evidence | Request/response hints | Flag |
|---|---|---|---|---|---|
| POST | `/profile/login` | Login with credentials | Acc:100 | body `{login, password, recaptcha_response?, need_json:true}` → `{response:{token}}`; captcha signaled by HTTP **420** / `error_code:420` / text "капч"/"captcha" (Acc:507-522) | [LIVE-VERIFY-NEEDED] |
| POST | `/users` | Registration | Acc:132 | body `{nickname?, email?, password?, bdate, sex?, lists_privacy, "g-recaptcha-response", need_token:true}` → `{response:{success}}` | [LIVE-VERIFY-NEEDED] |
| POST | `/users/registration-verify` | Email verify → token | Acc:159 | body `{hash}` → `{response:{success, token}}` | [LIVE-VERIFY-NEEDED] |
| GET | `/profile/token` | Refresh bearer token | Acc:170 | → `{response:{token}}` (new long-lived token) | [LIVE-VERIFY-NEEDED] |
| GET | `/profile` | Own profile | Acc:174 | Bearer; → profile DTO (nickname, email, avatar, register_date, last_online, bdate, lists_privacy, tg_nickname, shiki/tg/vk/discord flags, counts…) | [LIVE-VERIFY-NEEDED] |
| PATCH | `/profile` | Update profile | Acc:232 | body `{about, bdate, sex, lists_privacy, hide:{shiki,tg,vk,discord}, notifications:{tg,vk}}` → `{response:bool}` | [LIVE-VERIFY-NEEDED] |
| POST | `/profile/online` | Online heartbeat | Acc:182 | body `{hash: deviceHash}` → `{response:bool}` | [LIVE-VERIFY-NEEDED] |
| POST | `/profile/logout` | Logout | Acc:228 | — | [LIVE-VERIFY-NEEDED] |
| PATCH | `/profile/password` | Change password | Acc:268 | `{old_password, new_password, need_json}` → `{response:{success, token}}` (token rotated!) | [LIVE-VERIFY-NEEDED] |
| POST | `/profile/reset-password` | Password reset email | Acc:280 | `{email, recaptcha_response?}` | [LIVE-VERIFY-NEEDED] |
| DELETE | `/profile/login/{provider}` | Unlink social account | Acc:91 | provider ∈ `vk`, `tg`, `discord`, `shiki` (LinkedAccountProvider.kt) | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/users/{userId}/avatar` | Avatar upload/delete | Acc:240,248 | body = raw bytes (`application/octet-stream`) | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/users/{userId}/banner` | Banner upload/delete | Acc:254,262 | raw bytes | [LIVE-VERIFY-NEEDED] |

### Users / social
| Method | Path | Purpose | Evidence | Hints | Flag |
|---|---|---|---|---|---|
| GET | `/users/id{N}?need_counts=true` | Profile by id | Acc:190 | → profile+counts | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{nickname}?need_counts=true` | Profile by nickname | Acc:203 | | [LIVE-VERIFY-NEEDED] |
| GET | `/users?nickname={q}&order_by=a_z&limit&offset` | User search | Acc:195 | → `{response:{items[]}}` | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/friends?limit&offset` | Friends list | Acc:312 | | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/friends/{friendId}` | Friendship status | Acc:209 | → `{response:{status}}` (404 → none); statuses: friends/followers/following/requests/sent_requests | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/users/{id}/friends/{friendId}` | Add/remove friend | Acc:216,222 | → `{response:bool}` | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/reviews?type=approved&limit&offset` | User's reviews | Acc:318 | | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/collections?limit&offset` | User's collections | Acc:334 | | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/stats/genres|ratings|lists|types-v2` | Profile statistics | Acc:445-460 | four separate endpoints | [LIVE-VERIFY-NEEDED] |
| GET | `/posts?user_id={id}&status=published&sort=new&limit&skip` | User's posts | Acc:325 | note: uses `skip`, not `offset` | [LIVE-VERIFY-NEEDED] |
| GET | `/dialogs?limit&offset&need_uid` | PM dialogs | Msg:31 | | [LIVE-VERIFY-NEEDED] |
| GET | `/dialogs/{userId}/messages?limit&start_from` | PM history (cursor `start_from`) | Msg:38 | | [LIVE-VERIFY-NEEDED] |
| POST | `/dialogs/{userId}/messages` | Send PM | Msg:48 | `{answer_message_id, message}`; read: POST `/dialogs/{u}/messages/read` (Msg:54) | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/dialogs/messages/{messageId}` | Edit/delete PM | Msg:57,63 | body `{reason_edition,new_text}` / `{}`; restore: POST `.../restore` (Msg:69); history GET `.../history` (Msg:72); report POST `.../claim` (Msg:75) | [LIVE-VERIFY-NEEDED] |
| POST/DELETE | `/dialogs/{userId}/ban` | Block/unblock user | Msg:78,84 | body `{user_id}` | [LIVE-VERIFY-NEEDED] |

### Library (lists / favorites / rating / watch progress / subscriptions)
| Method | Path | Purpose | Evidence | Hints | Flag |
|---|---|---|---|---|---|
| GET | `/users/{id}/lists` | ALL list entries | Acc:307 | → `{response:[{anime…, user:{list:{list:{id}}}}]}` | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/lists/{listId}` | One list (listId 0..5, 4=fav) | Acc:302 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/list` | My list state for anime | Acc:340 | → `{response:{list_id, is_fav…}}` | [LIVE-VERIFY-NEEDED] |
| PUT | `/anime/{id}/list` | **Set list status** | Acc:345 | body `{list_id:int}` | [LIVE-VERIFY-NEEDED] |
| DELETE | `/anime/{id}/list` | Remove from lists | Acc:352 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/anime/{id}/list/fav` | Favorite add/remove | Acc:356,363 | body `{}` | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}` | My rating/list state | Acc:406 | → `{response:{user:{rating}, anime_id,…}}` (rating int 1..10) | [LIVE-VERIFY-NEEDED] |
| PUT | `/anime/{id}/rate` | **Set rating** | Acc:411 | body `{rating}` **coerced 1..10** | [LIVE-VERIFY-NEEDED] |
| DELETE | `/anime/{id}/rate` | Remove rating | Acc:418 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/rates` | Rating histogram | Acc:396 | → buckets | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/lists` | List-count stats | Acc:401 | | [LIVE-VERIFY-NEEDED] |
| PUT | `/video/{videoId}` | **Watch progress / mark watched** | Acc:372 | body `{time:sec, duration:sec, times:[int…]}` (rewatch times array) | [LIVE-VERIFY-NEEDED] |
| POST | `/video` | Batch sync watched | Acc:384 | body `{videos:[{video_id, time, duration, times, when?, ep_count?…}]}` (outbox types mark_watched/remove_watched, PendingMutationTypes.kt) | [LIVE-VERIFY-NEEDED] |
| DELETE | `/video` | Unmark watched | Acc:390 | body `{video_ids:[…]}` | [LIVE-VERIFY-NEEDED] |
| GET | `/video/watch-history?limit&offset` | Continue-watching history | Lib:26 | → items `{date, end_time, duration, anime_id, anime_url, title, ep_title, poster{small…mega}, screenshot{time,id,episode,sizes}}` | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/video/{videoId}/subscribe` | **Subscribe to new episodes of a dub** | Acc:432,436 | → `{response:bool}`; per-video (dub) subscription | [LIVE-VERIFY-NEEDED] |
| GET | `/users/{id}/lists/subs` | My subscriptions | Acc:440 | items have `next_episode` | [LIVE-VERIFY-NEEDED] |

### Catalog / anime
| Method | Path | Purpose | Evidence | Hints | Flag |
|---|---|---|---|---|---|
| GET | `/anime?q=&genres=&exclude_genres=&types=&status=&from_year=&to_year=&season=&min_age=&sort=&sort_forward=&limit=&offset=` | **Search/catalog** (offset paging) | Sea:20 | sort ∈ title/year/rating/rating_counters/views/top/id; genres repeated params | [LIVE-VERIFY-NEEDED] |
| GET | `/anime?sort=random&limit=1` | Random anime | Sea:37 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime?sort=top&types=tv|movie|ona&from_year=1900&limit&offset` | **Top** (reused catalog endpoint) | Top:15 | top = sort=top | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/catalog?limit&offset` | Catalog filter metadata | Sea:49 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/genres` | Genres list | Sea:44 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/genres/{id}` | Genre page | Det:51 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/studio/{url}` | Studio page | Det:45 | | [LIVE-VERIFY-NEEDED] |
| GET | `/director/{id}` | Director page | Det:48 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime?studio_ids=|director_ids=|genres=&sort=rating&sort_forward=false&limit=100&offset=0` | Related by filter | Det:57 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}` | Anime details | Det:30 | incl. `viewing_order` (franchise watch order!), `remote_ids.myanimelist_id`, ratings `{kp_rating, shikimori_rating, myanimelist_rating}`, `next_date/prev_date`, `random_screenshots` | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/videos` | **All episodes+players** (single shot) | Det:33 | see §6 | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/recommendations?from_ai=&limit=24` | Recommendations | Det:36 | | [LIVE-VERIFY-NEEDED] |
| DELETE/PUT | `/anime/{id}/recommend` | Hide/restore recommendation | Det:73,76 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/anime/{id}/recommend/{similarId}/vote` | Vote similar pair | Det:84,95 | body `{action:int}` | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/trailers` | Trailers | Det:42 | → `iframe_url[]` | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/reviews?sort&limit&offset` | Anime reviews | Rev:39 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/collections?limit&offset` | Anime collections | Acc:426 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{id}/bloggervideos?limit&offset` | Blogger videos for anime | Blg:39 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/{slug}` | Resolve notification slug → animeId | Acc:476 | | [LIVE-VERIFY-NEEDED] |
| GET | `/anime/schedule` | Release schedule | Sch:13 | → per-anime `{count, aired, next_date, prev_date}` | [LIVE-VERIFY-NEEDED] |
| GET | `/feed` | Home feed | Hom:13 | → `{announcements, top_carousel.items, new[], recommends[], new_videos[], schedule[], posts, blogger, collections[]}` | [LIVE-VERIFY-NEEDED] |

### Community
| Method | Path | Purpose | Evidence | Hints | Flag |
|---|---|---|---|---|---|
| GET | `/comments/{targetType}/{targetId}?limit&skip&sort` | Comments (target: `anime`,`post`,`review`) | Cmt:35 | uses `skip` | [LIVE-VERIFY-NEEDED] |
| GET | `/comments/{commentId}/children?skip` | Comment replies | Cmt:45 | | [LIVE-VERIFY-NEEDED] |
| POST | `/comments/{targetType}/{targetId}` | Add comment | Cmt:54 | | [LIVE-VERIFY-NEEDED] |
| PATCH/DELETE | `/comments/{commentId}` | Edit/delete | Cmt:63,69 | delete body `{}` | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/comments/{commentId}/vote` | Up/down vote | Cmt:78,84 | | [LIVE-VERIFY-NEEDED] |
| PUT | `/comments/{commentId}/claim` | Report comment | Cmt:90 | | [LIVE-VERIFY-NEEDED] |
| GET | `/reviews?sort&limit&offset` | Reviews feed | Rev:27 | | [LIVE-VERIFY-NEEDED] |
| GET/DELETE | `/reviews/{id}` | Review / delete own | Rev:44,47 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/reviews/{id}/vote` | Reaction to review | Rev:50,55 | body `{action:int}` | [LIVE-VERIFY-NEEDED] |
| GET | `/posts/categories`, `/posts?category&sort&limit&skip`, `/posts/{id}` | News/posts | Pst:22-36 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/posts/{id}/vote` | Vote post | Pst:39,44 | `{action:int}` | [LIVE-VERIFY-NEEDED] |
| GET/POST/PATCH/DELETE | `/collection`, `/collection/{id}` | Collections CRUD | Col:28-54 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/collection/{id}/vote` | Vote collection | Col:60,66 | | [LIVE-VERIFY-NEEDED] |
| GET | `/bloggers`, `/bloggers/{id}`, `/bloggers/video?category&blogger_id&sort&limit&offset`, `/bloggers/video/{id}` | Blogger directory/videos | Blg:30-51 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/bloggers/{id}/subscribe` | Subscribe blogger | Blg:54,57 | | [LIVE-VERIFY-NEEDED] |
| PUT/DELETE | `/bloggers/video/{id}/vote` | Reaction | Blg:60,66 | body `{action:"…"}` | [LIVE-VERIFY-NEEDED] |
| GET | `/pages/{type}` | Static pages (FAQ etc.), raw text/HTML | Pgs:13 | | [LIVE-VERIFY-NEEDED] |

### Notifications
| Method | Path | Purpose | Evidence | Hints | Flag |
|---|---|---|---|---|---|
| GET | `/profile/notifications?limit&offset` | Notifications feed | Acc:465 | items: `text_html`, `title_html`, `click_uri`, `sub_type`, `object_id`, `anime_id` | [LIVE-VERIFY-NEEDED] |
| GET | `/profile/notifications/counts` | Unread counters | Acc:471 | | [LIVE-VERIFY-NEEDED] |
| POST | `/profile/notifications/{id}/read` and `/profile/notifications/read` | Mark read (one/all) | Acc:482,487 | | [LIVE-VERIFY-NEEDED] |
| DELETE | `/profile/notifications/{id}` and `/profile/notifications` | Delete (one/all) | Acc:495,500 | | [LIVE-VERIFY-NEEDED] |

### Supplemental (author's own API — NOT YummyAnime)
| Method | Path | Purpose | Evidence | Hints | Flag |
|---|---|---|---|---|---|
| GET | `https://yummytv.kemonos.win/api/anime/mal/{malId}` | Episode titles/descriptions from TMDB | YummyEpisodesApi.kt:21 | 404 = "no episodes" (no MAL mapping); keyed by MyAnimeList id | (optional) |

## 3. Library status codes/names (UserAnimeList.kt:3-9 + YaniUserListsRepository.kt:24)

- `0` = WATCHING (смотрю), `1` = PLANNED (в планах), `2` = COMPLETED (просмотрено), `3` = DROPPED (брошено), `5` = POSTPONED (отложено); **`4` = FAVORITES** (handled via `/list/fav` + `is_fav`, not in enum).
- Set via `PUT /anime/{id}/list` body `{"list_id": N}`; favorites via `/list/fav`.
- Friendship statuses: NONE/FRIENDS/FOLLOWERS/FOLLOWING/REQUESTS/SENT_REQUESTS. Review moderation: APPROVED/WAITING/DECLINED.

## 4. Rating scale

- **Integer 1..10** — `setRating(... rating.coerceIn(1, 10))` (YaniAccountApi.kt:413); profile cache validates `rating in 1..10` (YaniAnimeRepository.kt:315). Histogram via `/anime/{id}/rates`.

## 5. Auth mechanism (differs from our current cookie approach!)

- **Pure JSON API auth**: `POST /profile/login {login, password, recaptcha_response?}` → `{response:{token}}`. Token is a **long-lived bearer** sent as `Authorization: Bearer <token>` on every request (YaniHttpClientFactory.kt:80-84).
- Token "refresh" = `GET /profile/token` → new token. Change-password also rotates the token. 401/403 ⇒ session rejected (YaniAccountRepository.kt:304).
- **Captcha**: hCaptcha in embedded WebView; site key `b1847961-208e-4a90-9671-1e6bba9e0b36` (AccountState.kt:17). Server signals captcha requirement with HTTP **420**, `error_code:420`, or "капч"/"captcha" text (YaniAccountApi.kt:504-522). Login body field is `recaptcha_response`, registration uses `g-recaptcha-response` (legacy names even though UI is hCaptcha).
- **Required headers on api.yani.tv** (YaniHttpClientFactory.kt:23-26): `X-Application: <appToken>` (hard-coded default `ze645twqfeql6l1u`, YaniApplicationTokenPreference.kt:7), `Lang: ru|uk` (content language), `Authorization: Bearer …`. Token stored in Android Keystore-encrypted prefs; **no cookies involved**.
- Registration → email hash → `POST /users/registration-verify` → token. There is also device-to-device session transfer via local NSD + PIN (NsdLocalAuthRepository.kt).

## 6. Episode pagination approach

- **There is none**: `GET /anime/{id}/videos` returns the **entire episode list at once** — flat array of `YaniAnimeVideoDto {video_id, number:"…" (string), iframe_url, duration, views, watched:{end_time,date}, subscribed, skips:{opening,ending}, data:{player, dubbing, player_id}}` (YaniAnimeDto.kt:161-188; fetch with no paging params, YaniAnimeRepository.kt:324). Long-running shows (Naruto/One Piece) come in one response; the app caches offline-first and groups by dub/season client-side.
- Episode *names/descriptions* come from the author's TMDB service keyed by MAL id (404 tolerated = "no data").
- Catalog/search/top/watch-history/notifications paginate with `limit`+`offset` (posts/comments use `skip`; dialogs use `start_from` cursor).

## 7. Player/video source resolution (from extractors)

- Per-episode **iframe_url + player name + dubbing** ("озвучка") from `/anime/{id}/videos`. Extractors in `feature/player/data/.../extractor/`: **Kodik** (fetch iframe HTML w/ `Referer: https://yani.tv/`, parse `urlParams={d,d_sign,pd,pd_sign,ref,ref_sign}` → kodik API → HLS), **Sibnet** (video.sibnet.ru), **Alloha** (hidden WebView on `https://alloha.yani.tv/`, intercept XHR `/bnsi/` JSON `hlsSource[]{audioId,label,quality{"1080":"url1 or url2"}}`, anti-bot headers `authorizations/accepts-controls/borth`, loopback HLS proxy; full doc `docs/alloha-player.md`), **CVH** (`ru.yummyani.me/iframeCVH.html?dubbing_code=X&anime_id=N&episode=N` → `plapi.cdnvideohub.com/api/v1/player/sv/playlist` → `…/sv/video` → HLS), **Aksor** (player.aksor.tv), **VK** (vk.com/video_ext.php), **Rutube**, **Zedfilm** (zedfilm.ru/hlamer.ru).
- Skip segments (opening/ending) come from the video's `skips` field.

## 8. Feature list implemented by YummyTV (README + UI modules)

- Dual UI: Android TV (D-pad) + mobile; home feed w/ hero carousel, continue watching, schedule, collections, new videos, bloggers.
- Catalog search with filters (genre/exclude-genre/type/status/year/season/min-age/sort), studio & director pages, top (TV/movie/ONA), schedule, random.
- Title page: description, multi-source ratings (site/KP/Shikimori/MAL), episodes with TMDB names, trailers, recommendations (+AI) w/ votes & hide, franchise **viewing order** (`viewing_order`), screenshots, collections, next-episode countdown.
- Account: login/register/verify/password change/reset, profile edit, avatar/banner upload, online heartbeat, social links (VK/TG/Discord/Shikimori) link/unlink + visibility.
- Library: 5 statuses + favorites, ratings 1-10 + histogram, **per-dub episode subscriptions** with local push on new episode (polls notifications), watch history/continue watching, watched thresholds (1/5/10 min before end depending on episode length), offline mutation outbox + background sync.
- Community: comments (threaded, votes, reports, spoiler hiding), reviews (moderation statuses, reactions), news/posts (categories, votes), blogger videos (subscribe, reactions), user profiles, user search, friends, dialogs (PM: send/edit/delete/restore/history/ban/report), profile stats (genres/ratings/lists/types).
- Player: Media3, quality/dub/balancer switch, PiP, auto-skip opening/ending, next-episode autoplay, offline downloads (incl. Alloha via session proxy), MP4 export.

## 9. Risks / caveats

- All endpoints are **reconstructed from a third-party client** (shallow clone; master last commit `2026-09-30 19:09:03 +0300`). YummyAnime can change the API at any time; nothing is officially documented → everything marked [LIVE-VERIFY-NEEDED] must be re-verified against `api.yani.tv` before use.
- `X-Application: ze645twqfeql6l1u` is YummyTV's hard-coded app token; whether the API enforces it (or accepts other values) is unknown — LIVE-VERIFY.
- hCaptcha (HTTP 420) gates login/register/password-reset; automated login will periodically require solving captcha.
- Our project's current design (persistent web session on old.yummyani.me) is a *different* mechanism than this token API; the token API is cleaner for a desktop client but must be verified live first (it may be restricted/flagged).
- Alloha extraction is fragile by design (WebView + anti-bot session); Kodik/CVH depend on iframe internals. High maintenance if replicated.
- `yummytv.kemonos.win` episode-names API is YummyTV author's private service — do not depend on it.
- Legal/ToS: unofficial API usage of a private site; keep request rates low and don't ship others' tokens without verification.
