import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LiveCameraFeed from '@/components/multicam/LiveCameraFeed';
import { DEFAULT_SETTINGS, type CameraConfig, type CameraRuntime } from '@/types/multicam';

const mock = vi.hoisted(() => ({
  addEvent: vi.fn(),
  session: {
    video: null as HTMLVideoElement | null,
    home: null as HTMLElement | null,
    runtime: null as CameraRuntime | null,
    reconnect: null,
  },
}));
vi.mock('@/lib/cameraSessions', () => ({ useCameraSession: () => mock.session, getCameraSession: () => mock.session }));
vi.mock('@/hooks/useCameraRegistry', () => ({ useCameraRegistry: () => ({ addEvent: mock.addEvent }) }));
vi.mock('@/hooks/useCctvTalk', () => ({
  useCctvTalk: () => ({ talking: false, error: null, startTalk: vi.fn(), stopTalk: vi.fn() }),
}));
vi.mock('@/components/multicam/MotionTraceOverlay', () => ({
  default: ({ modes, detail, onMovement }: {
    modes: { face: boolean; body: boolean; hands: boolean };
    detail?: 'mesh' | 'outline';
    onMovement?: (value: { kind: 'smile'; label: string; activation: number; features: string[]; source: 'mediapipe-blendshapes' }) => void;
  }) => (
    <div>
      <output data-testid="trace-models">
        {Object.keys(modes).filter(key => modes[key as keyof typeof modes]).join(',')} | {detail}
      </output>
      <button onClick={() => onMovement?.({
        kind: 'smile', label: 'Smiling', activation: 0.72,
        features: ['mouthSmileLeft', 'mouthSmileRight'],
        source: 'mediapipe-blendshapes',
      })}>Simulate blendshape movement</button>
    </div>
  ),
}));

const cam = {
  id: 'slot-1', name: 'Camera 1', path: 'cam1',
  location: 'Living room', enabled: true, aiEnabled: true,
} as CameraConfig;

beforeEach(() => {
  mock.addEvent.mockClear();
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

describe('automatic CCTV face boxes and object detection', () => {
  it('starts face tracing automatically for an online AI-enabled camera, without a toggle', () => {
    const originalVideo = mock.session.video;
    render(<LiveCameraFeed camera={cam} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />);
    expect(screen.getByTestId('trace-models').textContent).toContain('face | outline');
    expect(originalVideo?.parentElement).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Enable landmark tracing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show object detection boxes/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Simulate blendshape movement' }));
    expect(mock.addEvent).toHaveBeenCalledWith(expect.objectContaining({
      cameraId: 'slot-1', type: 'emotion', label: 'Happy',
    }));
  });

  it('does not start face models when AI monitoring is disabled', () => {
    render(<LiveCameraFeed camera={{ ...cam, aiEnabled: false }} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />);
    expect(screen.queryByTestId('trace-models')).toBeNull();
  });

  it('does not start face models for offline cameras', () => {
    mock.session.runtime = { ...mock.session.runtime!, status: 'offline' };
    render(<LiveCameraFeed camera={cam} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />);
    expect(screen.queryByTestId('trace-models')).toBeNull();
  });
});
