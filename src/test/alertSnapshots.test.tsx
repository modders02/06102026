import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AlertLog from '@/components/dashboard/AlertLog';
import type { Alert } from '@/types/dashboard';

const timestamp = new Date('2026-10-04T05:00:00Z');
const alert: Alert = {
  id: 'alert-1', snapshotId: 'source-1', cameraId: 1, timestamp,
  message: 'Lobby fire', severity: 'critical',
};
const snapshot = {
  id: 'source-1', cameraId: 1, timestamp,
  dataUrl: 'data:image/jpeg;base64,original', reason: 'Original camera frame',
};

afterEach(cleanup);

describe('dashboard alert snapshots', () => {
  it.each(['eviction', 'clear'])('closes the preview after alert %s while its snapshot is retained', change => {
    const replacement = { ...alert, id: 'alert-2', snapshotId: 'source-2', message: 'Kitchen smoke' };
    const replacementSnapshot = { ...snapshot, id: 'source-2', reason: 'New camera frame', dataUrl: 'data:image/jpeg;base64,new' };
    const snapshots = [snapshot, replacementSnapshot];
    const view = render(<AlertLog alerts={[alert]} visible snapshots={snapshots} />);

    fireEvent.click(screen.getByRole('button', { name: 'View snapshot for Lobby fire' }));
    expect(screen.getByRole('img', { name: 'Original camera frame' })).toHaveAttribute('src', snapshot.dataUrl);

    view.rerender(<AlertLog alerts={change === 'eviction' ? [replacement] : []} visible snapshots={snapshots} />);
    expect(screen.queryByRole('img', { name: 'Original camera frame' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  });

  it('uses the explicitly linked source even when another same-camera frame is closer', () => {
    const original = { ...snapshot, timestamp: new Date(timestamp.getTime() - 2000) };
    const closer = { ...snapshot, id: 'closer', reason: 'Different detection frame', dataUrl: 'data:image/jpeg;base64,closer' };
    render(<AlertLog alerts={[alert]} visible snapshots={[closer, original]} />);

    expect(screen.getByRole('img', { name: 'Snapshot for Lobby fire' })).toHaveAttribute('src', original.dataUrl);
    fireEvent.click(screen.getByText('Lobby fire'));
    expect(screen.getByRole('img', { name: 'Original camera frame' })).toHaveAttribute('src', original.dataUrl);
    expect(screen.queryByRole('img', { name: 'Different detection frame' })).not.toBeInTheDocument();
  });

  it('keeps an unavailable linked source from being replaced by a nearby detection', () => {
    const other = { ...snapshot, id: 'other', reason: 'Unrelated frame' };
    render(<AlertLog alerts={[alert]} visible snapshots={[other]} />);

    expect(screen.queryByRole('button', { name: 'View snapshot for Lobby fire' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Lobby fire'));
    expect(screen.queryByRole('img', { name: 'Unrelated frame' })).not.toBeInTheDocument();
  });

  it('matches a legacy alert to the nearest frame from the same camera', () => {
    const legacyAlert = { ...alert, snapshotId: undefined };
    const differentCamera = { ...snapshot, id: 'other-camera', cameraId: 2, reason: 'Other camera frame', dataUrl: 'data:image/jpeg;base64,camera2' };
    const nearest = { ...snapshot, id: 'nearest', timestamp: new Date(timestamp.getTime() - 1000) };
    const farther = { ...snapshot, id: 'farther', timestamp: new Date(timestamp.getTime() - 4000), dataUrl: 'data:image/jpeg;base64,farther' };
    render(<AlertLog alerts={[legacyAlert]} visible snapshots={[differentCamera, farther, nearest]} />);

    expect(screen.getByRole('img', { name: 'Snapshot for Lobby fire' })).toHaveAttribute('src', nearest.dataUrl);
    fireEvent.click(screen.getByRole('button', { name: 'View snapshot for Lobby fire' }));
    expect(screen.getByRole('img', { name: 'Original camera frame' })).toHaveAttribute('src', nearest.dataUrl);
    expect(screen.queryByRole('img', { name: 'Other camera frame' })).not.toBeInTheDocument();
  });

  it('closes the preview when the selected source disappears before its alert', () => {
    const view = render(<AlertLog alerts={[alert]} visible snapshots={[snapshot]} />);
    fireEvent.click(screen.getByRole('button', { name: 'View snapshot for Lobby fire' }));

    view.rerender(<AlertLog alerts={[alert]} visible snapshots={[]} />);
    expect(screen.queryByRole('img', { name: 'Original camera frame' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close/ })).not.toBeInTheDocument();
  });
});
