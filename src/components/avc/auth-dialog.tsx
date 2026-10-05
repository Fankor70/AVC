'use client'
/**
 * AuthDialog — «Вход через YummyAnime».
 *
 * ДВА режима входа на РЕАЛЬНЫЙ сайт:
 *   - EXE: openLoginWindow() открывает окно сайта через мост; пароль вводится
 *     только на сайте, сессия живёт в постоянном профиле оболочки
 *     (partition persist:yummyanime) и не покидает main-процесс.
 *   - Web (превью в браузере): форма «логин + пароль» — сервер приложения
 *     отправляет их напрямую на сервер сайта (POST /api/profile/login),
 *     получает cookie-сессию, проверяет её и хранит ТОЛЬКО на сервере
 *     (db/yummy-session.json, 0600, вне git). Пароль нигде не хранится.
 *
 * Cookie-мост (ручная вставка cookie) остаётся запрещён — спека, секции 15/16.
 *
 * ВАЖНО (проверено живым сайтом): отдельной страницы /login НЕТ (404) —
 * форма «Вход» встроена в ГЛАВНУЮ страницу сайта.
 */
import { useEffect, useState } from 'react'
import {
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { avcApi, getElectronBridge } from '@/lib/avc/api'
import { siteLoginUrl } from '@/lib/avc/site-urls'
import { useAvcStore } from '@/lib/avc/store'
import type { YummyAccountSnapshot } from '@/lib/avc/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function AuthDialog() {
  const open = useAvcStore((s) => s.authOpen)
  const setOpen = useAvcStore((s) => s.setAuthOpen)
  const setYummyAccount = useAvcStore((s) => s.setYummyAccount)

  // Мост есть только в EXE-сборке; определяем после гидрации (SSR-safe)
  const [hasBridge, setHasBridge] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [webCheckBusy, setWebCheckBusy] = useState(false)

  // Форма входа веб-режима (пароль живёт только в этом состоянии компонента)
  const [webLogin, setWebLogin] = useState('')
  const [webPassword, setWebPassword] = useState('')
  const [webError, setWebError] = useState<string | null>(null)
  const [webBusy, setWebBusy] = useState(false)

  useEffect(() => {
    setHasBridge(getElectronBridge() !== null)
  }, [])

  /** Применить снапшот: в store + toast; при подтверждённом входе закрыть диалог */
  const applySnapshot = (snap: YummyAccountSnapshot, closeOnLogin: boolean) => {
    setYummyAccount(snap)
    if (snap.state === 'loggedIn') {
      toast({ description: `Вы вошли как ${snap.user?.username ?? 'без имени'}` })
      if (closeOnLogin) setOpen(false)
      return
    }
    toast({
      variant: 'destructive',
      description:
        snap.message ?? 'Сайт не подтвердил вход — завершите вход на сайте и попробуйте снова',
    })
  }

  /** EXE: открыть окно сайта для входа; промис резолвится ПОСЛЕ его закрытия */
  const loginViaSite = async () => {
    setLoginBusy(true)
    try {
      const snap = await avcApi.openLoginWindow()
      applySnapshot(snap, true)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Не удалось открыть окно входа',
      })
    } finally {
      setLoginBusy(false)
    }
  }

  /** EXE: полная проверка аутентификации через сайт (verifyAuthentication) */
  const verifyNow = async () => {
    setVerifyBusy(true)
    try {
      const snap = await avcApi.verifyAuthentication()
      applySnapshot(snap, true)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка проверки аккаунта',
      })
    } finally {
      setVerifyBusy(false)
    }
  }

  /** Web: вход реальными логином/паролем через сервер приложения → сайт */
  const loginWithPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (webBusy) return
    setWebError(null)
    if (webLogin.trim().length < 2 || webPassword.length < 1) {
      setWebError('Введите логин и пароль от YummyAnime')
      return
    }
    setWebBusy(true)
    try {
      const res = await avcApi.yummyLogin(webLogin.trim(), webPassword)
      if (res.ok && res.snapshot) {
        setWebPassword('') // пароль не держим в состоянии ни секунды дольше нужного
        applySnapshot(res.snapshot, true)
        return
      }
      setWebError(res.message ?? 'Сайт отклонил вход')
      toast({ variant: 'destructive', description: res.message ?? 'Сайт отклонил вход' })
    } catch {
      setWebError('Не удалось отправить запрос — попробуйте ещё раз')
    } finally {
      setWebBusy(false)
    }
  }

  /** Web: честная проверка сохранённой сессии на сайте */
  const checkWeb = async () => {
    setWebCheckBusy(true)
    try {
      const snap = await avcApi.yummyAccount(true)
      applySnapshot(snap, false)
    } catch (e) {
      toast({
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Ошибка проверки',
      })
    } finally {
      setWebCheckBusy(false)
    }
  }

  /** Открыть главную сайта: форма «Вход» встроена в неё (/login на сайте = 404) */
  const openSite = () => {
    window.open(siteLoginUrl(useAvcStore.getState().settings.baseUrl), '_blank', 'noopener')
  }

  const anyBusy = loginBusy || verifyBusy

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-sky-400" aria-hidden />
            Вход через YummyAnime
          </DialogTitle>
          <DialogDescription>
            {hasBridge
              ? 'Войдите защищённо на YummyAnime: пароль вводится только на сайте, в его собственном окне — приложение пароль не видит. Аккаунт, статусы и избранное живут на YummyAnime.'
              : 'Введите логин и пароль от YummyAnime — они отправятся напрямую на сервер сайта. Пароль нигде не хранится, а сессия живёт на сервере приложения.'}
          </DialogDescription>
        </DialogHeader>

        {hasBridge ? (
          <>
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => void loginViaSite()}
                disabled={anyBusy}
                className="min-h-11 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {loginBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                )}
                Войти через YummyAnime
              </Button>

              <Button
                variant="outline"
                disabled={anyBusy}
                onClick={() => void verifyNow()}
                className="min-h-11 gap-2 border-border bg-card/60 hover:border-sky-400/40 hover:text-sky-300"
              >
                {verifyBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                Проверить аккаунт
              </Button>
            </div>

            {loginBusy && (
              <p
                role="status"
                className="flex items-start gap-2 rounded-lg border border-sky-400/40 bg-sky-400/40 p-2.5 text-xs leading-relaxed text-sky-200"
              >
                <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                Открыто окно сайта — завершите вход там. Это окно закроется автоматически
                после входа.
              </p>
            )}

            <p className="text-xs leading-relaxed text-muted-foreground">
              Форма «Вход» находится вверху главной страницы сайта (там же вход через
              Telegram / VK / Shikimori). Сессия сохраняется в постоянном профиле сайта
              и переживёт перезапуск приложения.
            </p>
          </>
        ) : (
          <>
            {/* РЕАЛЬНАЯ форма входа: логин + пароль → сервер сайта */}
            <form onSubmit={loginWithPassword} className="flex flex-col gap-3" noValidate>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="avc-web-login" className="text-xs text-muted-foreground">
                  Логин или e-mail от YummyAnime
                </Label>
                <Input
                  id="avc-web-login"
                  name="login"
                  type="text"
                  autoComplete="username"
                  inputMode="email"
                  placeholder="например, you@example.com"
                  value={webLogin}
                  onChange={(e) => setWebLogin(e.target.value)}
                  disabled={webBusy}
                  className="min-h-11 border-border bg-card/60"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="avc-web-password" className="text-xs text-muted-foreground">
                  Пароль
                </Label>
                <Input
                  id="avc-web-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Пароль от сайта"
                  value={webPassword}
                  onChange={(e) => setWebPassword(e.target.value)}
                  disabled={webBusy}
                  className="min-h-11 border-border bg-card/60"
                />
              </div>

              {webError && (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-400/30 bg-rose-400/10 p-2.5 text-xs leading-relaxed text-rose-200"
                >
                  {webError}
                </p>
              )}

              <Button
                type="submit"
                disabled={webBusy}
                className="min-h-11 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {webBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                )}
                Войти на YummyAnime
              </Button>
            </form>

            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                disabled={webCheckBusy}
                onClick={() => void checkWeb()}
                className="min-h-11 gap-2 border-border bg-card/60 hover:border-sky-400/40 hover:text-sky-300"
              >
                {webCheckBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden />
                )}
                Проверить сохранённую сессию
              </Button>

              <Button
                variant="ghost"
                onClick={openSite}
                className="min-h-11 gap-2 text-muted-foreground hover:text-sky-300"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                Войти в браузере (Telegram / VK / Shikimori)
              </Button>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Пароль уходит только на сервер old.yummyani.me (тот же запрос, что и на
              сайте) и нигде не сохраняется. Вход через Telegram / VK / Shikimori —
              только в окне сайта (кнопка выше или EXE-сборка).
            </p>
          </>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          После входа все действия — «добавь в смотрю», «оцени на 8», «добавь в
          избранное» — выполняются в вашем аккаунте на сайте, и результат виден на
          самом YummyAnime.
        </p>
      </DialogContent>
    </Dialog>
  )
}
