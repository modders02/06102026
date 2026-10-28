import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardEvents from '@/components/dashboard/DashboardEvents';
import ValidationLayer from '@/components/dashboard/ValidationLayer';
import { clearCameraSession, publishCameraSession } from '@/lib/cameraSessions';
import type { CameraRuntime, DetectionEvent } from '@/types/multicam';

const mocks = vi.hoisted(() => ({ events: [] as DetectionEvent[], clearEvents: vi.fn() }));
vi.mock('@/hooks/useCameraRegistry', () => ({
  useCameraRegistry: () => ({ events: mocks.events, alertEvents: [], clearEvents: mocks.clearEvents }),
}));
vi.mock('@/hooks/useCameraSlots', () => ({
  useCameraSlots: () => ({ activeSlots: [{ index: 1, name: 'Kitchen camera' }] }),
}));

const runtime = (outcome?: CameraRuntime['alertValidation']): CameraRuntime => ({
  cameraId: 'validation-history', status: 'online', error: null,
  fps: 8, latencyMs: 0, saliencyScore: 0, attentionScore: 0, objects: [], humanCount: 0,
  fire: { detected: false, confidence: 0 }, smoke: { detected: false, confidence: 0 },
  faceDistress: { detected: false, label: '', confidence: 0 },
  audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
  transcript: '', audioListening: true, audio: null, audioMessage: 'Listening',
  audioTone: 'ok', audioBackendReachable: true, lastDetectionAt: null, detections: 0, alerts: 0,
  alertValidation: outcome,
});

const accepted: NonNullable<CameraRuntime['alertValidation']> = {
  status: 'accepted', keyword: 'help', confidence: 0.94, emotion: 'Frightened',
  emotionConfidence: 0.91, reason: 'The wake word matched a frightened expression.',
  evaluatedAt: '2026-10-15T01:00:00Z', sourceDecision: 'accepted',
};

beforeEach(() => { mocks.events = []; });
afterEach(() => { cleanup(); clearCameraSession('validation-history'); vi.useRealTimers(); });

describe('live validation and significant event history', () => {
  it.each(['accepted', 'rejected'] as const)('shows facial loading until the pipeline returns %s', status => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const pending: NonNullable<CameraRuntime['alertValidation']> = {
      ...accepted, status: 'pending', emotion: '', emotionConfidence: 0,
      reason: 'Waiting for matching facial evidence.',
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(startedAt + 4000).toISOString(),
    };
    publishCameraSession('validation-history', { runtime: runtime(pending) });
    const view = render(<ValidationLayer cameraId="validation-history" />);
    const progress = () => screen.getByRole('progressbar', { name: 'Facial validation progress' });
    expect(progress()).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByRole('status')).toHaveTextContent('PENDING');

    act(() => { vi.advanceTimersByTime(2000); });
    expect(progress()).toHaveAttribute('aria-valuenow', '50');
    act(() => publishCameraSession('validation-history', { runtime: runtime({
      ...pending, reason: 'No face is currently detected; waiting for facial evidence.',
      evaluatedAt: new Date().toISOString(),
    }) }));
    expect(progress()).toHaveAttribute('aria-valuenow', '50');

    // Returning to the panel resumes the original window instead of restarting.
    view.unmount();
    render(<ValidationLayer cameraId="validation-history" />);
    expect(progress()).toHaveAttribute('aria-valuenow', '50');
    act(() => { vi.advanceTimersByTime(4000); });
    expect(progress()).toHaveAttribute('aria-valuenow', '99');
    expect(screen.getByRole('status')).toHaveTextContent('PENDING');

    act(() => publishCameraSession('validation-history', { runtime: runtime({
      ...accepted, status,
      emotion: status === 'accepted' ? 'Frightened' : '',
      reason: status === 'accepted' ? 'Matching face detected.' : 'No face detected within the validation window.',
    }) }));
    expect(progress()).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByRole('status')).toHaveTextContent(status.toUpperCase());
    expect(screen.queryByText('Checking facial expression…')).not.toBeInTheDocument();

    const nextStart = Date.now();
    act(() => publishCameraSession('validation-history', { runtime: runtime({
      ...pending, startedAt: new Date(nextStart).toISOString(),
      deadlineAt: new Date(nextStart + 4000).toISOString(),
    }) }));
    expect(progress()).toHaveAttribute('aria-valuenow', '1');
  });

  it('does not show facial loading for a rejected wake word or fire validation', () => {
    publishCameraSession('validation-history', { runtime: runtime({
      ...accepted, status: 'rejected', sourceDecision: 'below_threshold',
    }) });
    render(<ValidationLayer cameraId="validation-history" />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    act(() => publishCameraSession('validation-history', { runtime: runtime({
      ...accepted, keyword: 'fire', status: 'pending', emotion: '',
    }) }));
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows the checked word, confidence, evidence and time from the same decision', () => {
    publishCameraSession('validation-history', { runtime: runtime(accepted) });
    render(<ValidationLayer cameraId="validation-history" cameraName="Kitchen camera" />);

    const panel = screen.getByRole('region', { name: 'Validation layer' });
    expect(panel).toHaveTextContent('Kitchen camera');
    expect(panel).toHaveTextContent('"help"');
    expect(panel).toHaveTextContent('94.0%');
    expect(panel).toHaveTextContent('Frightened');
    expect(within(panel).getByRole('status')).toHaveTextContent('ACCEPTED');
    expect(panel.querySelector('time')).toHaveAttribute('datetime', accepted.evaluatedAt);
    expect(within(panel).getByText('Live')).toBeInTheDocument();
  });

  it.each([
    ['offline', 'Offline'], ['connecting', 'Connecting'], ['error', 'Unavailable'],
  ] as const)('describes a %s camera without claiming validation is active', (status, label) => {
    publishCameraSession('validation-history', { runtime: { ...runtime(accepted), status } });
    render(<ValidationLayer cameraId="validation-history" />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('ACCEPTED');
  });

  it('shows a waiting offline state when there is no camera session', () => {
    render(<ValidationLayer cameraId="validation-history" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('WAITING');
    expect(screen.getByText('None yet')).toBeInTheDocument();
    expect(screen.queryByText(/Last checked/)).not.toBeInTheDocument();
  });

  it('does not present the initial waiting timestamp as a completed check', () => {
    publishCameraSession('validation-history', { runtime: runtime({
      ...accepted, status: 'waiting', keyword: '', confidence: 0, emotion: '', emotionConfidence: 0,
      reason: 'Waiting for a wake word and camera evidence.', evaluatedAt: new Date(0).toISOString(),
    }) });
    render(<ValidationLayer cameraId="validation-history" />);

    expect(screen.getByRole('status')).toHaveTextContent('WAITING');
    expect(screen.queryByText(/Last checked/)).not.toBeInTheDocument();
  });

  it('does not display the old Fire detected (night vision) popup or thumbnail', () => {
    mocks.events = [{
      id: 'old-night-fire',
      cameraId: 'slot-1',
      cameraName: 'Kitchen camera',
      type: 'fire',
      label: 'Fire detected (night vision)',
      fireConfirmed: true,
      confidence: 1,
      timestamp: '2026-10-29T04:18:13+08:00',
      snapshot: 'data:image/jpeg;base64,night',
      alertValidation: { status: 'pending', keyword: '', emotion: 'visual fire', reason: 'Waiting for accepted keyword' },
    }];
    render(<MemoryRouter><DashboardEvents /></MemoryRouter>);
    const history = screen.getByRole('region', { name: 'Event history' });
    expect(history).toHaveTextContent('No events yet.');
    expect(within(history).queryByText('Fire detected (night vision)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {
      name: 'View snapshot: Fire detected (night vision) from Kitchen camera',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a significant confirmed smoke incident without showing its rejected audio validation', () => {
    mocks.events = [{
      id: 'recorded-check', cameraId: 'validation-history', cameraName: 'Kitchen camera',
      location: 'Kitchen', type: 'smoke', label: 'Smoke detected',
      smokeConfirmed: true, confidence: 0.93, timestamp: '2026-10-15T00:59:00Z',
      snapshot: 'data:image/jpeg;base64,smoke-evidence',
      alertValidation: { status: 'rejected', reason: 'duration_mismatch', keyword: 'fire', emotion: '' },
    }];
    publishCameraSession('validation-history', { runtime: runtime(accepted) });
    render(<MemoryRouter><ValidationLayer cameraId="validation-history" cameraName="Kitchen camera" /><DashboardEvents /></MemoryRouter>);

    const history = screen.getByRole('region', { name: 'Event history' });
    expect(within(history).getByText('Smoke detected')).toBeInTheDocument();
    expect(within(history).getByRole('button', {
      name: 'View snapshot: Smoke detected from Kitchen camera',
    })).toBeInTheDocument();
    expect(within(history).queryByText('Validation at this event')).not.toBeInTheDocument();
    expect(history).not.toHaveTextContent('REJECTED');
    expect(history).not.toHaveTextContent('duration_mismatch');

    // Live validation remains distinct and continues to update normally.
    act(() => publishCameraSession('validation-history', {
      runtime: runtime({ ...accepted, status: 'pending', reason: 'Waiting for current camera evidence.' }),
    }));
    expect(within(screen.getByRole('region', { name: 'Validation layer' }))
      .getByRole('status')).toHaveTextContent('PENDING');
    expect(within(history).getByText('Smoke detected')).toBeInTheDocument();
    expect(history).not.toHaveTextContent('PENDING');
    expect(screen.getByRole('region', { name: 'Camera alerts' })).toHaveTextContent('No camera alerts yet.');
  });
});
