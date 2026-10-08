import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Monitoring from '@/pages/Monitoring';
import LiveCameraFeed from '@/components/multicam/LiveCameraFeed';
import DashboardCameraCard from '@/components/dashboard/DashboardCameraCard';
import { clearCameraSession, publishCameraSession } from '@/lib/cameraSessions';
import * as clipRecorder from '@/lib/clipRecorder';
import { DEFAULT_SETTINGS, type CameraRuntime, type DetectionEvent } from '@/types/multicam';
import { slotCamera, type CameraSlot } from '@/hooks/useCameraSlots';

const mocks = vi.hoisted(() => ({
  setCount: vi.fn(),
  stopTalk: vi.fn(),
  clearEvents: vi.fn(),
  events: [] as DetectionEvent[],
  alertEvents: undefined as DetectionEvent[] | undefined,
  localActive: [false, false],
  count: 2,
  slots: [1, 2].map(index => ({
    index, name: `Camera ${index}`, ip: `192.168.1.${index}`, username: '', password: '',
    port: 554, streamPath: '/stream1', aiEnabled: true, connected: true, streamUrl: '',
  })),
}));

vi.mock('@/hooks/useCameraSlots', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/useCameraSlots')>();
  return { ...actual, useCameraSlots: () => ({ count: mocks.count, slots: mocks.slots, activeSlots: mocks.slots.slice(0, mocks.count), setCount: mocks.setCount }) };
});
vi.mock('@/hooks/useCameraRegistry', () => ({ useCameraRegistry: () => ({ settings: DEFAULT_SETTINGS, events: mocks.events, alertEvents: mocks.alertEvents, clearEvents: mocks.clearEvents }) }));
vi.mock('@/hooks/useCamera', () => ({ useCamera: () => ({ cameras: mocks.localActive.map(active => ({ active })) }) }));
vi.mock('@/hooks/useCctvTalk', () => ({
  useCctvTalk: () => ({ talking: false, error: null, startTalk: vi.fn(), stopTalk: mocks.stopTalk }),
}));

const onlineRuntime = {
  status: 'online', objects: [], fire: { detected: false, confidence: 0 }, fps: 8,
} as CameraRuntime;

function makeSession(index: number, runtimePatch: Partial<CameraRuntime> = {}) {
  const home = document.createElement('div');
  const video = document.createElement('video');
  const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
  const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
  video.style.cssText = 'position:fixed;left:-10000px;display:none;';
  home.appendChild(video);
  document.body.appendChild(home);
  publishCameraSession(`slot-${index}`, {
    video,
    home,
    runtime: { ...onlineRuntime, cameraId: `slot-${index}`, ...runtimePatch },
  });
  return { home, video, play, pause };
}

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

beforeEach(() => {
  mocks.setCount.mockClear();
  mocks.stopTalk.mockClear();
  mocks.clearEvents.mockClear();
  mocks.events = [];
  mocks.alertEvents = undefined;
  mocks.localActive = [false, false];
  mocks.count = 2;
  for (const slot of mocks.slots) slot.connected = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearCameraSession('slot-1');
  clearCameraSession('slot-2');
  document.body.replaceChildren();
});

describe('shared live camera views', () => {
  it('uses the existing video and restores its hidden home without stopping playback', () => {
    const { home, video, pause } = makeSession(1);
    const originalStyle = video.style.cssText;
    const view = render(<LiveCameraFeed camera={slotCamera(mocks.slots[0] as CameraSlot)} settings={DEFAULT_SETTINGS} onConnect={vi.fn()} />);

    expect(view.container.contains(video)).toBe(true);
    expect(home.contains(video)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Hear camera sound' }));
    expect(video.muted).toBe(false);

    view.unmount();
    expect(home.contains(video)).toBe(true);
    expect(video.style.cssText).toBe(originalStyle);
    expect(video.muted).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    expect(mocks.stopTalk).toHaveBeenCalled();
  });

  it('shows the existing camera transcript once below the live video without starting another pipeline', () => {
    const { video } = makeSession(1, {
      transcript: 'help me',
      audioListening: true,
      audioMessage: 'Listening',
      audioTone: 'ok',
    });
    const view = render(
      <LiveCameraFeed
        camera={slotCamera(mocks.slots[0] as CameraSlot)}
        settings={DEFAULT_SETTINGS}
        onConnect={vi.fn()}
      />,
    );

    expect(view.container.contains(video)).toBe(true);
    expect(screen.getByText('Live transcription')).toBeInTheDocument();
    expect(screen.getByText('help me')).toBeInTheDocument();
    expect(screen.getAllByText('help me')).toHaveLength(1);
  });

  it('labels custom-only audio as safety keyword detection instead of stalled transcription', () => {
    makeSession(1, {
      transcript: '',
      audioListening: true,
      audioMessage: 'Listening for trained safety keywords…',
      audioTone: 'ok',
      audio: {
        thread_running: true,
        connected: true,
        chunks_received: 1,
        bytes_received: 32000,
        last_chunk_at: null,
        last_transcription_at: null,
        last_transcript: '',
        recognition_engine: 'custom',
        custom_kws: {
          open_set_ready: true,
          language_scope: 'en',
          active_keywords: ['help', 'fire', 'emergency', 'danger', 'intruder', 'police', 'ambulance', 'stop'],
          ready_keywords: ['help'],
          last_segment_ms: 620,
          last_candidate: 'help',
          last_candidate_confidence: 0.934,
          last_runner_up_keyword: 'fire',
          last_runner_up_confidence: 0.898,
          last_class_margin: 0.0354,
          last_required_margin: 0.0341,
          last_negative_confidence: 0.895,
          last_duration_ratio: 1.12,
          last_decision: 'duration_mismatch',
          last_keyword: 'emergency',
          last_processing_ms: 205.95,
        },
        error: null,
        ffmpeg_error: null,
      },
    });

    render(
      <LiveCameraFeed
        camera={slotCamera(mocks.slots[0] as CameraSlot)}
        settings={DEFAULT_SETTINGS}
        onConnect={vi.fn()}
      />,
    );

    expect(screen.getByText('Safety keyword detection')).toBeInTheDocument();
    expect(screen.getByText('Candidate: help (93.4%) · duration_mismatch')).toBeInTheDocument();
    expect(screen.queryByText('Listening… no speech heard yet.')).not.toBeInTheDocument();
    const diagnostics = screen.getByTestId('voice-diagnostics');
    expect(within(diagnostics).getByText('Voice diagnostics')).toBeInTheDocument();
    expect(within(diagnostics).getByText(/Scope:/)).toHaveTextContent('English only');
    expect(within(diagnostics).getByText('duration_mismatch')).toBeInTheDocument();
    expect(within(diagnostics).getByText(/help \(93\.4%\)/)).toBeInTheDocument();
    expect(within(diagnostics).getByText(/fire \(89\.8%\)/)).toBeInTheDocument();
    expect(within(diagnostics).getByText('0.0354 / 0.0341')).toBeInTheDocument();
    expect(within(diagnostics).getByText('emergency', { selector: 'span.font-mono' })).toBeInTheDocument();
  });

  it('changes focused camera and layout without changing configured slots', () => {
    const first = makeSession(1);
    const second = makeSession(2);
    const view = render(<MemoryRouter initialEntries={['/cameras?camera=slot-2']}><Monitoring /><Location /></MemoryRouter>);

    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(view.container.contains(second.video)).toBe(true);
    expect(first.home.contains(first.video)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'All live cameras' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(view.container.contains(first.video)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'One column' }));
    expect(mocks.setCount).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Event history' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Camera alerts' })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/cameras');
  });

  it('opens the matching dashboard connection slot for an offline camera', () => {
    mocks.slots[1].connected = false;
    render(<MemoryRouter initialEntries={['/cameras?camera=slot-2']}><Monitoring /><Location /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /Camera 2.*Connect CCTV/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard?connect=2');
    expect(mocks.setCount).not.toHaveBeenCalled();
  });

  it('keeps an explicitly requested offline slot focused beyond the layout count', () => {
    mocks.count = 1;
    mocks.slots[1].connected = false;
    render(<MemoryRouter initialEntries={['/cameras?camera=slot-2&events=slot-2']}><Monitoring /><Location /></MemoryRouter>);

    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Choose live camera' })).toHaveValue('slot-2');
    expect(screen.getByRole('combobox', { name: 'Filter events by camera' })).toHaveValue('slot-2');
    fireEvent.click(screen.getByRole('button', { name: /Camera 2.*Connect CCTV/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard?connect=2');
    expect(mocks.setCount).not.toHaveBeenCalled();
  });

  it.each([1, 2])('shows active local camera %s even beyond the layout count with CCTV disconnected', index => {
    mocks.count = 1;
    mocks.slots[index - 1].connected = false;
    mocks.localActive[index - 1] = true;
    const { video } = makeSession(index);
    const view = render(<MemoryRouter initialEntries={[`/cameras?camera=slot-${index}`]}><Monitoring /></MemoryRouter>);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(view.container.contains(video)).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Choose live camera' })).toHaveValue(`slot-${index}`);
    expect(screen.getByText('2 connected cameras')).toBeInTheDocument();
  });

  it('keeps a connected camera selectable when its slot exceeds the configured layout count', () => {
    mocks.count = 1;
    const { video } = makeSession(2);
    const view = render(<MemoryRouter initialEntries={['/cameras?camera=slot-2']}><Monitoring /><Location /></MemoryRouter>);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(view.container.contains(video)).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Choose live camera' })).toHaveValue('slot-2');
    expect(screen.getAllByRole('option', { name: 'Camera 2' })).toHaveLength(2);
    expect(screen.getByTestId('location')).toHaveTextContent('/cameras?camera=slot-2');
    expect(mocks.setCount).not.toHaveBeenCalled();
  });
});

describe('camera alerts and event history', () => {
  beforeEach(() => {
    mocks.events = [
      { id: 'first', cameraId: 'slot-1', cameraName: 'Camera 1', location: 'Lobby', type: 'object', label: 'Lobby delivery', confidence: 0.8, timestamp: '2026-10-02T02:40:23Z' },
      { id: 'second', cameraId: 'slot-2', cameraName: 'Camera 2', location: 'Kitchen', type: 'fire', label: 'Kitchen fire', confidence: 0.9, timestamp: '2026-10-02T02:41:23Z', clipUrl: 'blob:test-recording', snapshot: 'data:image/jpeg;base64,test' },
    ];
  });

  it('opens the exact alert snapshot with its source and timestamp, then closes it', async () => {
    render(<MemoryRouter initialEntries={['/cameras?camera=slot-2']}><Monitoring /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: 'View snapshot: Kitchen fire from Camera 2' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Kitchen fire' })).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'Kitchen fire snapshot from Camera 2' })).toHaveAttribute('src', 'data:image/jpeg;base64,test');
    expect(within(dialog).getByText(/Camera 2 · Kitchen/)).toHaveTextContent('90% confidence');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps an alert snapshot available after the event leaves general history', () => {
    mocks.alertEvents = [mocks.events[1]];
    mocks.events = [mocks.events[0]];
    render(<MemoryRouter initialEntries={['/cameras']}><Monitoring /></MemoryRouter>);

    expect(screen.getByText('Lobby delivery')).toBeInTheDocument();
    expect(screen.getByText(/Kitchen fire/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View snapshot: Kitchen fire from Camera 2' }));
    expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute('src', 'data:image/jpeg;base64,test');
  });

  it('closes a snapshot preview when its alert is cleared or evicted', () => {
    mocks.alertEvents = [mocks.events[1]];
    const view = render(<MemoryRouter initialEntries={['/cameras']}><Monitoring /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'View snapshot: Kitchen fire from Camera 2' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    mocks.events = [];
    mocks.alertEvents = [];
    view.rerender(<MemoryRouter initialEntries={['/cameras']}><Monitoring /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the missing folder and save failure without a Downloads fallback', async () => {
    mocks.events[1] = { ...mocks.events[1], clipError: 'No folder selected.' };
    render(<MemoryRouter initialEntries={['/cameras']}><Monitoring /></MemoryRouter>);
    expect(screen.getAllByText('No folder selected.')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Recording settings' }));
    await waitFor(() => expect(screen.getAllByText('No folder selected.')).toHaveLength(3));
    expect(screen.queryByText(/Downloads/)).not.toBeInTheDocument();
  });

  it('confirms folder selection without displaying the destination name', async () => {
    vi.spyOn(clipRecorder, 'clipFolderSupported').mockReturnValue(true);
    vi.spyOn(clipRecorder, 'restoreClipFolder').mockResolvedValue('');
    const chooseFolder = vi.spyOn(clipRecorder, 'pickClipFolder').mockResolvedValue('Private recording folder');
    render(<MemoryRouter initialEntries={['/cameras']}><Monitoring /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Recording settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await waitFor(() => expect(screen.getByText('Folder selected.')).toBeInTheDocument());
    expect(chooseFolder).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Private recording folder/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saving to/)).not.toBeInTheDocument();
  });

  it('shows history for the focused camera and follows live camera selection', () => {
    const view = render(<MemoryRouter initialEntries={['/cameras?camera=slot-1']}><Monitoring /><Location /></MemoryRouter>);

    expect(screen.getByRole('combobox', { name: 'Filter events by camera' })).toHaveValue('slot-1');
    expect(screen.getByText('Lobby delivery')).toBeInTheDocument();
    expect(screen.queryByText('Kitchen fire')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Choose live camera' }), { target: { value: 'slot-2' } });
    expect(screen.getByRole('combobox', { name: 'Filter events by camera' })).toHaveValue('slot-2');
    expect(screen.queryByText('Lobby delivery')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Kitchen fire/)).toHaveLength(2);
    const recording = view.container.querySelector('video');
    expect(recording).toHaveAttribute('preload', 'none');
    expect(recording).not.toHaveAttribute('autoplay');
  });

  it('allows all history while a camera is focused and resets filters with All live cameras', () => {
    render(<MemoryRouter initialEntries={['/cameras?camera=slot-1&events=slot-2']}><Monitoring /><Location /></MemoryRouter>);

    expect(screen.getByRole('combobox', { name: 'Filter events by camera' })).toHaveValue('slot-2');
    expect(screen.queryByText('Lobby delivery')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter events by camera' }), { target: { value: 'all' } });
    expect(screen.getByRole('combobox', { name: 'Choose live camera' })).toHaveValue('slot-1');
    expect(screen.getByText('Lobby delivery')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/cameras?camera=slot-1&events=all');

    fireEvent.click(screen.getByRole('button', { name: 'All live cameras' }));
    expect(screen.getByRole('combobox', { name: 'Filter events by camera' })).toHaveValue('all');
    expect(screen.getByTestId('location')).toHaveTextContent('/cameras');
    fireEvent.click(screen.getByRole('button', { name: 'Clear event history' }));
    expect(mocks.clearEvents).toHaveBeenCalledOnce();
  });

  it.each([true, false])('opens camera history from a dashboard card with connected=%s', connected => {
    const slot = { ...mocks.slots[1], connected } as CameraSlot;
    const onConnect = vi.fn();
    const view = render(<MemoryRouter initialEntries={['/dashboard']}><DashboardCameraCard slot={slot} monitoring eventCount={3} onConnect={onConnect} onToggleAi={vi.fn()} /><Location /></MemoryRouter>);

    expect(view.container.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Events (3)' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/cameras?camera=slot-2&events=slot-2');
    expect(onConnect).not.toHaveBeenCalled();
  });
});
