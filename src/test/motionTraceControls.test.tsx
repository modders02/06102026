import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveCameraFeed from '@/components/multicam/LiveCameraFeed';
import { DEFAULT_SETTINGS, type CameraConfig, type CameraRuntime } from '@/types/multicam';

const mock = vi.hoisted(() => ({
  session: {
    video: null as HTMLVideoElement | null,
    home: null as HTMLElement | null,
    runtime: null as CameraRuntime | null,
    reconnect: null,
  },
}));
vi.mock('@/lib/cameraSessions', () => ({ useCameraSession: () => mock.session }));
vi.mock('@/hooks/useCctvTalk', () => ({
  useCctvTalk: () => ({ talking: false, error: null, startTalk: vi.fn(), stopTalk: vi.fn() }),
}));
vi.mock('@/components/multicam/MotionTraceOverlay', () => ({
  default: ({ modes, detail }: {
    modes: { face: boolean; body: boolean; hands: boolean };
    detail?: 'mesh' | 'outline';
  }) => (
    <output data-testid="trace-models">
      {Object.keys(modes).filter(key => modes[key as keyof typeof modes]).join(',')} | {detail}
    </output>
  ),
}));

const cam = {
  id: 'slot-1', name: 'Camera 1', path: 'cam1',
  location: 'Living room', enabled: true, aiEnabled: true,
} as CameraConfig;

beforeEach(() => {
  mock.session.video = document.createElement('video');
  mock.session.home = document.createElement('div');
  mock.session.home.appendChild(mock.session.video);
  document.body.appendChild(mock.session.home);
  vi.spyOn(mock.session.video, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  mock.session.runtime = {
    cameraId: 'slot-1', status: 'online', objects: [], fire: { detected: false, confidence: 0 },
  } as CameraRuntime;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('optional CCTV landmark controls', () => {
  it('does not start models before opt-in and keeps the same shared video', () => {
    const originalVideo = mock.session.video;
    render(<LiveCameraFeed camera={cam} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />);
    expect(screen.queryByTestId('trace-models')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable landmark tracing for Camera 1' }));
    expect(screen.getByTestId('trace-models').textContent).toContain('face,body,hands | mesh');
    expect(originalVideo?.parentElement).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Body pose tracing' }));
    expect(screen.getByTestId('trace-models').textContent).toContain('face,hands | mesh');
    fireEvent.click(screen.getByRole('button', { name: 'Switch face mesh detail' }));
    expect(screen.getByTestId('trace-models').textContent).toContain('face,hands | outline');
    expect(screen.getByRole('button', { name: 'Show object detection boxes while tracing' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Show object detection boxes while tracing' }));
    expect(screen.getByRole('button', { name: 'Show object detection boxes while tracing' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Disable landmark tracing for Camera 1' }));
    expect(screen.queryByTestId('trace-models')).toBeNull();
  });

  it('never starts diagnostic tracing when AI is switched off', () => {
    render(<LiveCameraFeed camera={{ ...cam, aiEnabled: false }} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Enable landmark tracing for Camera 1' })).toBeDisabled();
    expect(screen.queryByTestId('trace-models')).toBeNull();
  });
});
