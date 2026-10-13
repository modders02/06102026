import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HouseholdVoiceTraining from '@/components/household/HouseholdVoiceTraining';

const mocks = vi.hoisted(() => ({ sync: vi.fn(), remove: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/householdVoiceTraining', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/householdVoiceTraining')>();
  return { ...real, synchronizeHouseholdVoice: mocks.sync, deleteHouseholdVoiceSample: mocks.remove };
});

beforeEach(() => {
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.sync.mockReset().mockResolvedValue({
    active_household_id: 'household-1',
    words: [{ id: 'word-1', phrase: 'help me', key: 'help_me' }],
    keywords: { help_me: 0, unknown: 0 },
    ready_keywords: [],
    sample_ids: { help_me: [], unknown: [] },
    negative_ready: false,
    open_set_ready: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('household voice training workflow', () => {
  it('hides recording controls until an eligible wake word is saved, including for the default 911 phrase', async () => {
    const view = render(<HouseholdVoiceTraining householdId="household-1" words={[{ id: 'default', phrase: '911' }]} />);
    expect(screen.queryByTestId('household-voice-training')).not.toBeInTheDocument();
    expect(mocks.sync).not.toHaveBeenCalled();

    view.rerender(<HouseholdVoiceTraining householdId="household-1" words={[{ id: 'word-1', phrase: 'help me' }]} />);
    expect(await screen.findByTestId('household-voice-training')).toBeInTheDocument();
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(screen.getByText('help me')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Record' })).toHaveLength(2);

    view.rerender(<HouseholdVoiceTraining householdId="household-1" words={[]} />);
    expect(screen.queryByTestId('household-voice-training')).not.toBeInTheDocument();
  });

  it('shows controls and sample counts without descriptive training paragraphs', async () => {
    render(<HouseholdVoiceTraining householdId="household-1" words={[{ id: 'word-1', phrase: 'help me' }]} />);
    expect(await screen.findByTestId('household-voice-training')).toBeInTheDocument();
    expect(screen.getByText('Household voice training')).toBeInTheDocument();
    expect(screen.queryByText(/Members can teach MSDS/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recorded audio is stored/)).not.toBeInTheDocument();
    expect(screen.getByText(/0 \/ 3 samples/)).toBeInTheDocument();
  });
  it('lists each enrolled recording and removes the requested sample when Delete is clicked', async () => {
    const sampleId = 'a'.repeat(32);
    const word = { id: 'word-1', phrase: 'help me' };
    mocks.sync.mockResolvedValueOnce({
      active_household_id: 'household-1', words: [], keywords: { help_me: 1, unknown: 0 },
      sample_ids: { help_me: [sampleId], unknown: [] },
      ready_keywords: [], negative_ready: false, open_set_ready: false,
    }).mockResolvedValue({
      active_household_id: 'household-1', words: [], keywords: { help_me: 0, unknown: 0 },
      sample_ids: { help_me: [], unknown: [] },
      ready_keywords: [], negative_ready: false, open_set_ready: false,
    });
    render(<HouseholdVoiceTraining householdId="household-1" words={[word]} />);
    const deleteButton = await screen.findByRole('button', { name: 'Delete sample 1 for help me' });
    expect(screen.getByRole('button', { name: 'Retry sample 1 for help me' })).toBeEnabled();
    expect(screen.getByText(/1 \/ 3 samples/)).toBeInTheDocument();
    fireEvent.click(deleteButton);
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('household-1', 'word-1', sampleId));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete sample 1 for help me' })).not.toBeInTheDocument());
    expect(screen.getByText(/0 \/ 3 samples/)).toBeInTheDocument();
  });

});
