import { useCallback, useEffect, useRef, useState } from 'react'

// Web Speech API interface declarations for TypeScript
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
  message?: string
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onstart: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  onend: ((this: SpeechRecognitionInstance, ev: Event) => void) | null
  onerror: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionErrorEvent) => void) | null
  onresult: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionEvent) => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: {
      new (): SpeechRecognitionInstance
    }
    webkitSpeechRecognition?: {
      new (): SpeechRecognitionInstance
    }
  }
}

export interface UseSpeechToTextOptions {
  lang?: string
  fallbackLang?: string
  /**
   * Further language tags attempted, in order, after `fallbackLang`.
   * A `network` error means the browser could not reach its speech endpoint
   * (routine on rural/mobile ISP links); it is retried down this chain
   * SILENTLY instead of surfacing as a hard failure.
   */
  retryLangs?: string[]
  /** Automatic retries a `network` error earns before the hook degrades.
   *  Default 2 = one attempt each at `ur` and `en-US`. */
  networkRetries?: number
  continuous?: boolean
  interimResults?: boolean
  onTranscript?: (transcript: string, isFinal: boolean) => void
  onError?: (error: string) => void
  /** Fired once when speech can no longer be relied upon — the view should
   *  reveal its manual preset bar. */
  onDegraded?: () => void
}

export function useSpeechToText({
  lang = 'ur-PK',
  fallbackLang = 'ur',
  retryLangs = ['en-US'],
  networkRetries = 2,
  continuous = false,
  interimResults = true,
  onTranscript,
  onError,
  onDegraded,
}: UseSpeechToTextOptions = {}) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSupported, setIsSupported] = useState(true)
  /** True when speech cannot be relied on: unsupported, permission denied, or
   *  the network retry chain is exhausted. Never a crash — a signal for the
   *  view to offer manual input. */
  const [degraded, setDegraded] = useState(false)
  /** Language tag in use after any fallback. */
  const [activeLang, setActiveLang] = useState(lang)

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const shouldListenRef = useRef(false)
  const networkRetryRef = useRef(0)
  const langIndexRef = useRef(0)
  /** Final text committed by sessions that already ended. Restarting the
   *  recognizer clears `event.results`, so without this the textarea would
   *  lose everything spoken before each auto-restart. */
  const carriedFinalRef = useRef('')
  const sessionFinalRef = useRef('')

  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onDegradedRef = useRef(onDegraded)
  onDegradedRef.current = onDegraded

  // Read through a ref: `retryLangs` defaults to a fresh array literal every
  // render, so placing it in the callback deps would rebuild the recognizer
  // identity on every keystroke of the parent view.
  const langChainRef = useRef<string[]>([])
  langChainRef.current = Array.from(new Set([lang, fallbackLang, ...retryLangs]))

  useEffect(() => {
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
      setIsSupported(false)
      setDegraded(true)
    }
  }, [])

  const stopListening = useCallback(() => {
    shouldListenRef.current = false
    setIsListening(false)
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // ignore
      }
      recognitionRef.current = null
    }
  }, [])

  const startListening = useCallback(() => {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognitionAPI) {
      setIsSupported(false)
      setDegraded(true)
      const msg = 'Speech recognition is not supported in this browser. Use Chrome or Edge.'
      console.warn('[Web Speech STT]', msg)
      setError(msg)
      onErrorRef.current?.(msg)
      onDegradedRef.current?.()
      return
    }

    // Stop any previously running recognizer
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort()
      } catch {
        // ignore
      }
      recognitionRef.current = null
    }

    // An explicit user retry earns a fresh budget from the primary tag again,
    // and clears `degraded` so a manual preset bar hides if speech returns.
    shouldListenRef.current = true
    networkRetryRef.current = 0
    langIndexRef.current = 0
    carriedFinalRef.current = ''
    sessionFinalRef.current = ''
    setDegraded(false)
    setError(null)

    const chain = langChainRef.current

    try {
      const recognition = new SpeechRecognitionAPI()
      recognition.continuous = continuous
      recognition.interimResults = interimResults
      recognition.lang = chain[0] ?? lang
      setActiveLang(recognition.lang)

      /** Advance to the next language tag; null once the chain is exhausted. */
      const advanceLang = (): string | null => {
        const next = chain[langIndexRef.current + 1]
        if (!next) return null
        langIndexRef.current += 1
        recognition.lang = next
        setActiveLang(next)
        return next
      }

      const restart = () => {
        // start() on a running session throws; onend also re-arms, so
        // swallowing here keeps the retry chain moving without double-firing.
        try {
          recognition.start()
        } catch {
          /* already started — onend will restart it */
        }
      }

      /** Terminal: stop cleanly and hand off to the view's manual presets. */
      const markDegraded = (code: string) => {
        shouldListenRef.current = false
        setIsListening(false)
        setDegraded(true)
        setError(code)
        onErrorRef.current?.(code)
        onDegradedRef.current?.()
      }

      recognition.onstart = () => {
        setIsListening(true)
        setError(null)
      }

      recognition.onend = () => {
        // Keep listening through the browser's silence timeout: carry the text
        // already committed, then re-arm. A restart clears `event.results`, so
        // without the carry the textarea would lose everything spoken so far.
        if (shouldListenRef.current) {
          if (sessionFinalRef.current) {
            carriedFinalRef.current = [carriedFinalRef.current, sessionFinalRef.current]
              .filter(Boolean)
              .join(' ')
            sessionFinalRef.current = ''
          }
          try {
            recognition.start()
          } catch {
            shouldListenRef.current = false
            setIsListening(false)
          }
        } else {
          setIsListening(false)
        }
      }

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        const code = event.error
        console.warn('[Web Speech STT]', code)

        // Permission / vendor refusal — no retry can help these.
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          markDegraded(code)
          return
        }

        if (code === 'network') {
          // Walk ur-PK -> ur -> en-US before admitting defeat. An ISP-level
          // speech outage must never surface as a red failure while a retry
          // is still available.
          if (shouldListenRef.current && networkRetryRef.current < networkRetries) {
            networkRetryRef.current += 1
            if (advanceLang()) {
              restart()
              return
            }
          }
          markDegraded('network')
          return
        }

        if (code === 'language-not-supported') {
          if (shouldListenRef.current && advanceLang()) {
            restart()
            return
          }
          markDegraded(code)
          return
        }

        // Silence and user aborts are normal conditions, not failures.
        if (code !== 'no-speech' && code !== 'aborted') {
          setError(code)
          onErrorRef.current?.(code)
        }
      }

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let committed = ''
        let pending = ''
        let lastWasFinal = false

        for (let i = 0; i < event.results.length; i += 1) {
          const res = event.results[i]
          const txt = res?.[0]?.transcript ?? ''
          if (res?.isFinal) {
            committed += txt + ' '
            lastWasFinal = true
          } else {
            pending += txt
            lastWasFinal = false
          }
        }

        const finalText = committed.trim()
        const interimText = pending.trim()
        if (finalText) sessionFinalRef.current = finalText

        // Final AND interim stream together. The previous `final || interim`
        // either/or meant the first committed segment masked every later
        // interim result, so the textarea appeared to freeze mid-sentence.
        const combined = [carriedFinalRef.current, finalText, interimText]
          .filter(Boolean)
          .join(' ')

        if (finalText) setTranscript(finalText)
        if (interimText) setInterimTranscript(interimText)

        if (combined) {
          // Speech is flowing again: clear any degradation and refund the retry
          // budget so the next hiccup gets its own attempts.
          networkRetryRef.current = 0
          setDegraded(false)
          setError(null)
          onTranscriptRef.current?.(combined, lastWasFinal)
        }
      }

      recognitionRef.current = recognition
      restart()
    } catch (e) {
      console.error('[Web Speech Init Error]', e)
      shouldListenRef.current = false
      setIsListening(false)
      setDegraded(true)
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      onErrorRef.current?.(msg)
      onDegradedRef.current?.()
    }
  }, [lang, continuous, interimResults, networkRetries])

  const toggleListening = useCallback(() => {
    if (shouldListenRef.current) {
      stopListening()
    } else {
      startListening()
    }
  }, [startListening, stopListening])

  const resetTranscript = useCallback(() => {
    setTranscript('')
    setInterimTranscript('')
    carriedFinalRef.current = ''
    sessionFinalRef.current = ''
  }, [])

  return {
    isListening,
    transcript,
    interimTranscript,
    error,
    isSupported,
    /** Speech input cannot be relied on — reveal manual presets. */
    degraded,
    /** Language tag currently in use after any fallback. */
    activeLang,
    startListening,
    stopListening,
    toggleListening,
    resetTranscript,
    setTranscript,
  }
}
