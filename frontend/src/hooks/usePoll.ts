import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiRequestError } from '../lib/api'

export interface PollState<T> {
  data: T | null
  error: ApiRequestError | null
  /** True from the first successful fetch onward. */
  loaded: boolean
  fetching: boolean
  lastUpdatedAt: number | null
  refresh: () => Promise<void>
}

interface UsePollOptions {
  /** Milliseconds between ticks. <= 0 disables polling (manual refresh only). */
  intervalMs?: number
  /** Skip polling entirely while false (e.g. no active incident yet). */
  enabled?: boolean
  /** Keep the last good payload while a tick fails, instead of clearing it. */
  keepPreviousOnError?: boolean
}

/**
 * Interval poller for the live cockpit.
 *
 * Deliberately overlap-safe: a tick is skipped while the previous one is still
 * in flight, so a slow backend can never stack requests up behind each other.
 * Failures are captured as typed ApiRequestError values rather than thrown —
 * the demo must degrade visibly, never crash.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  options: UsePollOptions = {},
): PollState<T> {
  const {
    intervalMs = 2500,
    enabled = true,
    keepPreviousOnError = true,
  } = options

  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiRequestError | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)

  // The fetcher closure changes every render; keep a ref so the interval does
  // not tear down and restart on unrelated state updates.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const inFlight = useRef(false)
  const mounted = useRef(false)
  // Set when refresh() lands mid-flight, so the caller's request is replayed
  // once the current tick settles instead of being silently dropped.
  const rerunRequested = useRef(false)

  // Read through a ref so run() stays referentially stable while still being
  // able to refuse a disabled poll at call time.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const run = useCallback(async () => {
    // A disabled poll must never fetch, even via an explicit refresh(): the
    // fetcher closure can still be bound to the previous subject (e.g. a null
    // incident id), which would request /incident/null/timeline and 404.
    if (!enabledRef.current) return
    if (inFlight.current) {
      rerunRequested.current = true
      return
    }
    inFlight.current = true
    try {
      do {
        rerunRequested.current = false
        setFetching(true)
        try {
          const next = await fetcherRef.current()
          if (!mounted.current) return
          setData(next)
          setError(null)
          setLoaded(true)
          setLastUpdatedAt(Date.now())
        } catch (cause) {
          if (!mounted.current) return
          const err =
            cause instanceof ApiRequestError
              ? cause
              : new ApiRequestError(0, 'UNKNOWN', String(cause))
          setError(err)
          if (!keepPreviousOnError) setData(null)
        } finally {
          if (mounted.current) setFetching(false)
        }
      } while (rerunRequested.current && enabledRef.current && mounted.current)
    } finally {
      // Outer finally: an early `return` on unmount must still release the lock.
      inFlight.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepPreviousOnError])

  // Reset accumulated state when the polling subject changes (new incident).
  const subjectKey = deps.join('|')
  const prevSubject = useRef(subjectKey)
  useEffect(() => {
    if (prevSubject.current !== subjectKey) {
      prevSubject.current = subjectKey
      setData(null)
      setError(null)
      setLoaded(false)
      setLastUpdatedAt(null)
    }
  }, [subjectKey])

  useEffect(() => {
    if (!enabled) return
    void run()
    if (intervalMs <= 0) return

    const id = window.setInterval(() => void run(), intervalMs)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, run, subjectKey])

  useEffect(() => {
    // Set inside an effect (not during render) so StrictMode's
    // mount -> unmount -> remount cycle leaves this true, not false.
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  return { data, error, loaded, fetching, lastUpdatedAt, refresh: run }
}
