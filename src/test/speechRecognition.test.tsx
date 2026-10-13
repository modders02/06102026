import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';

interface RecognitionSegment {
  isFinal: boolean;
  0: { transcript: string; confidence?: number };
}

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: ((event: { resultIndex: number; results: RecognitionSegment[] }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn();

  constructor() { FakeSpeechRecognition.instances.push(this); }
}

const segment = (transcript: string, isFinal: boolean, confidence?: number): RecognitionSegment => ({
  isFinal, 0: { transcript, confidence },
});

function deliver(recognition: FakeSpeechRecognition, results: RecognitionSegment[], resultIndex = 0) {
  act(() => recognition.onresult?.({ resultIndex, results }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T05:00:00Z'));
  FakeSpeechRecognition.instances = [];
  vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('finalized local speech evidence', () => {
  it('publishes only newly finalized text while keeping accumulated and interim display text', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    expect(result.current.supported).toBe(true);
    expect(result.current.finalResult).toBeNull();
    act(() => result.current.start());
    const recognition = FakeSpeechRecognition.instances[0];

    deliver(recognition, [segment('hel', false)]);
    expect(result.current.interimTranscript).toBe('hel');
    expect(result.current.finalResult).toBeNull();

    deliver(recognition, [segment('help', true, 0.91)]);
    const first = result.current.finalResult;
    expect(first).toEqual({
      id: 1, transcript: 'help', confidence: 0.91, timestamp: '2026-10-13T05:00:00.000Z',
    });
    expect(result.current.transcript).toBe('help');

    act(() => vi.advanceTimersByTime(1000));
    deliver(recognition, [segment('help', true, 0.91), segment('I am', false)], 1);
    expect(result.current.finalResult).toBe(first);
    expect(result.current.interimTranscript).toBe('I am');

    deliver(recognition, [segment('help', true, 0.91), segment('I am okay', true, 0.83)], 1);
    expect(result.current.finalResult).toEqual({
      id: 2, transcript: 'I am okay', confidence: 0.83, timestamp: '2026-10-13T05:00:01.000Z',
    });
    expect(result.current.transcript).toBe('help I am okay');
    expect(result.current.interimTranscript).toBe('');
  });

  it('groups final segments from one callback and excludes its interim text from evidence', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    deliver(FakeSpeechRecognition.instances[0], [
      segment('fire', true, 0.92),
      segment('in the kitchen', true, 0.64),
      segment('please', false, 0.99),
    ]);

    expect(result.current.finalResult).toEqual({
      id: 1, transcript: 'fire in the kitchen', confidence: 0.64, timestamp: '2026-10-13T05:00:00.000Z',
    });
    expect(result.current.transcript).toBe('fire in the kitchen');
    expect(result.current.interimTranscript).toBe('please');
  });

  it.each([0, undefined, NaN, -1])('treats unavailable confidence %s as unknown rather than rejecting final speech', confidence => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    deliver(FakeSpeechRecognition.instances[0], [segment('help', true, confidence)]);

    expect(result.current.finalResult?.confidence).toBe(1);
  });

  it('clears final evidence explicitly and retains monotonic IDs for another identical utterance', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    const recognition = FakeSpeechRecognition.instances[0];
    deliver(recognition, [segment('help', true, 0.9), segment('me', false)]);

    act(() => result.current.clear());
    expect(result.current.finalResult).toBeNull();
    expect(result.current.transcript).toBe('');
    expect(result.current.interimTranscript).toBe('');

    deliver(recognition, [segment('help', true, 0.85)]);
    expect(result.current.finalResult).toMatchObject({ id: 2, transcript: 'help', confidence: 0.85 });
  });

  it('clears final evidence on stop and starts a new session without replaying old display text', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => result.current.start());
    const firstRecognition = FakeSpeechRecognition.instances[0];
    deliver(firstRecognition, [segment('help', true, 0.9)]);

    act(() => result.current.stop());
    expect(result.current.finalResult).toBeNull();
    expect(result.current.isListening).toBe(false);
    expect(firstRecognition.stop).toHaveBeenCalledOnce();
    deliver(firstRecognition, [segment('late help', true, 0.99)]);
    expect(result.current.finalResult).toBeNull();

    act(() => result.current.start());
    expect(result.current.finalResult).toBeNull();
    expect(result.current.transcript).toBe('help');
    const restarted = FakeSpeechRecognition.instances[1];
    act(() => firstRecognition.onend?.());
    expect(firstRecognition.start).toHaveBeenCalledOnce();
    deliver(firstRecognition, [segment('stale help', true, 0.99)]);
    expect(result.current.finalResult).toBeNull();
    deliver(restarted, [segment('hello', false)]);
    expect(result.current.finalResult).toBeNull();
    deliver(restarted, [segment('fire', true, 0.95)]);
    expect(result.current.finalResult).toMatchObject({ id: 2, transcript: 'fire', confidence: 0.95 });
  });
});
