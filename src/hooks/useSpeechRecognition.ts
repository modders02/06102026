import { useState, useRef, useCallback, useEffect } from 'react';

export interface FinalSpeechResult {
  id: number;
  transcript: string;
  confidence: number;
  timestamp: string;
}

interface RecognitionAlternative {
  transcript: string;
  confidence?: number;
}

interface RecognitionResult {
  isFinal: boolean;
  [index: number]: RecognitionAlternative;
}

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface RecognitionErrorEvent {
  error: string;
}

interface RecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionConstructor = new () => RecognitionInstance;
type RecognitionWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

export function useSpeechRecognition() {
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalResult, setFinalResult] = useState<FinalSpeechResult | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const finalResultIdRef = useRef(0);
  const transcriptTimerRef = useRef<number | null>(null);
  const interimTimerRef = useRef<number | null>(null);

  const scheduleTranscriptClear = () => {
    if (transcriptTimerRef.current) window.clearTimeout(transcriptTimerRef.current);
    transcriptTimerRef.current = window.setTimeout(() => {
      setTranscript('');
      transcriptTimerRef.current = null;
    }, 3000);
  };

  const scheduleInterimClear = () => {
    if (interimTimerRef.current) window.clearTimeout(interimTimerRef.current);
    interimTimerRef.current = window.setTimeout(() => {
      setInterimTranscript('');
      interimTimerRef.current = null;
    }, 1500);
  };

  useEffect(() => {
    const browser = window as RecognitionWindow;
    const SpeechRecognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    setSupported(!!SpeechRecognition);
  }, []);

  const start = useCallback(() => {
    const browser = window as RecognitionWindow;
    const SpeechRecognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    setFinalResult(null);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: RecognitionResultEvent) => {
      if (recognitionRef.current !== recognition) return;
      let interim = '';
      let final = '';
      let confidence = 1;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript + ' ';
          const resultConfidence = result[0].confidence;
          confidence = Math.min(confidence,
            typeof resultConfidence === 'number' && Number.isFinite(resultConfidence) && resultConfidence > 0
              ? resultConfidence
              : 1,
          );
        } else {
          interim += result[0].transcript;
        }
      }
      if (final) {
        setTranscript(prev => (prev + ' ' + final).trim().split(' ').slice(-30).join(' '));
        scheduleTranscriptClear();
        if (final.trim()) {
          setFinalResult({
            id: ++finalResultIdRef.current,
            transcript: final.trim(),
            confidence,
            timestamp: new Date().toISOString(),
          });
        }
      }
      setInterimTranscript(interim);
      if (interim) scheduleInterimClear();
    };

    recognition.onerror = (event: RecognitionErrorEvent) => {
      console.warn('[SpeechRecognition] Error:', event.error);
      if (event.error !== 'no-speech') {
        setIsListening(false);
      }
    };

    recognition.onend = () => {
      // Auto-restart if still supposed to be listening
      if (recognitionRef.current === recognition) {
        try { recognition.start(); } catch { /* Recognition may already be restarting. */ }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch { /* The browser may reject a duplicate or blocked start. */ }
  }, []);

  const stop = useCallback(() => {
    setFinalResult(null);
    if (recognitionRef.current) {
      const ref = recognitionRef.current;
      recognitionRef.current = null;
      try { ref.stop(); } catch { /* Recognition may have already ended. */ }
      setIsListening(false);
      setInterimTranscript('');
      if (transcriptTimerRef.current) { window.clearTimeout(transcriptTimerRef.current); transcriptTimerRef.current = null; }
      if (interimTimerRef.current) { window.clearTimeout(interimTimerRef.current); interimTimerRef.current = null; }
    }
  }, []);

  const clear = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    setFinalResult(null);
  }, []);

  return { transcript, interimTranscript, finalResult, isListening, supported, start, stop, clear };
}
