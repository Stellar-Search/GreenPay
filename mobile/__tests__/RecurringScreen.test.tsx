import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import RecurringScreen from '../app/recurring';
import * as recurringDonations from '../utils/recurringDonations';

jest.mock('expo-router', () => ({
  useFocusEffect: (cb: any) => {
    require('react').useEffect(() => {
      const cleanup = cb();
      return () => {
        if (cleanup) cleanup();
      };
    }, [cb]);
  }
}));

jest.mock('../utils/recurringDonations', () => ({
  loadRecurringDonations: jest.fn(),
  cancelRecurringDonation: jest.fn(),
}));

describe('RecurringScreen Focus/Blur', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('focuses the screen, navigates away mid-load, and asserts no state update and no warning', async () => {
    let resolveLoad: (val: any) => void = () => {};
    const loadPromise = new Promise((res) => {
      resolveLoad = res;
    });

    (recurringDonations.loadRecurringDonations as jest.Mock).mockReturnValue(loadPromise);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { unmount, queryByTestId } = render(<RecurringScreen />);

    // Unmount before the promise resolves
    unmount();

    // Now resolve the promise
    await act(async () => {
      resolveLoad([]);
    });

    // Verify no warnings or errors were logged
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
