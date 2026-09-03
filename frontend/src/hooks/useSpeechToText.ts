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
  continuous?: boolean
  interimResults?: boolean
  onTranscript?: (transcript: string, isFinal: boolean) => void
  onError?: (error: string) => void
}

export function useSpeechToText({
  lang = 'ur-PK',
  fallbackLang = 'ur',
  continuous = true,
  interimResults = true,
  onTranscript,
  onError,
}: UseSpeechToTextOptions = {}) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSupported, setIsSupported] = useState(true)

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const shouldListenRef = useRef(false)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognitionAPI) {
      setIsSupported(false)
      return
    }

    try {
      const recognition = new SpeechRecognitionAPI()
      recognition.continuous = continuous
      recognition.interimResults = interimResults
      recognition.lang = lang

      recognition.onstart = () => {
        setIsListening(true)
        setError(null)
      }

      recognition.onend = () => {
        // If the user intended to keep listening and it stopped prematurely (e.g. browser silence timeout), restart
        if (shouldListenRef.current) {
          try {
            recognition.start()
          } catch {
            setIsListening(false)
            shouldListenRef.current = false
          }
        } else {
          setIsListening(false)
        }
      }

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.error('[Web Speech STT Error]', event.error, event)
        const errCode = event.error

        if (errCode === 'not-allowed' || errCode === 'service-not-allowed') {
          shouldListenRef.current = false
          setIsListening(false)
          setError('Microphone access denied. Please allow microphone permissions in your browser.')
          onErrorRef.current?.(errCode)
          return
        }

        // If language wasn't supported, try fallback language
        if (errCode === 'language-not-supported' && recognition.lang !== fallbackLang) {
          recognition.lang = fallbackLang
          try {
            recognition.start()
            return
          } catch {
            // ignore
          }
        }

        if (errCode !== 'no-speech' && errCode !== 'aborted') {
          setError(errCode)
          onErrorRef.current?.(errCode)
        }
      }

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let accumulated = ''
        let currentInterim = ''

        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i]
          const txt = res[0]?.transcript || ''
          if (res.isFinal) {
            accumulated += txt + ' '
          } else {
            currentInterim += txt
          }
        }

        const cleanFinal = accumulated.trim()
        if (cleanFinal) {
          setTranscript(cleanFinal)
          onTranscriptRef.current?.(cleanFinal, true)
        } else if (currentInterim) {
          setInterimTranscript(currentInterim)
          onTranscriptRef.current?.(currentInterim, false)
        }
      }

      recognitionRef.current = recognition
    } catch (e) {
      console.error('[Web Speech Init Error]', e)
      setIsSupported(false)
    }

    return () => {
      shouldListenRef.current = false
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
        } catch {
          // ignore
        }
      }
    }
  }, [lang, fallbackLang, continuous, interimResults])

  const startListening = useCallback(() => {
    if (!recognitionRef.current) return
    setError(null)
    shouldListenRef.current = true
    try {
      recognitionRef.current.start()
    } catch (err) {
      try {
        recognitionRef.current.stop()
        setTimeout(() => {
          if (shouldListenRef.current) {
            recognitionRef.current?.start()
          }
        }, 100)
      } catch {
        // ignore
      }
    }
  }, [])

  const stopListening = useCallback(() => {
    shouldListenRef.current = false
    setIsListening(false)
    if (!recognitionRef.current) return
    try {
      recognitionRef.current.stop()
    } catch {
      // ignore
    }
  }, [])

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
  }, [])

  return {
    isListening,
    transcript,
    interimTranscript,
    error,
    isSupported,
    startListening,
    stopListening,
    toggleListening,
    resetTranscript,
    setTranscript,
  }
}
