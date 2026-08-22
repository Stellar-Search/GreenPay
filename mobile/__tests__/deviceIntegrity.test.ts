/**
 * __tests__/deviceIntegrity.test.ts
 *
 * Unit tests for utils/deviceIntegrity.ts and utils/useDeviceIntegrity.ts.
 * jail-monkey is a native module, mocked in __mocks__/jail-monkey.js.
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';
import JailMonkey from 'jail-monkey';
import { checkDeviceIntegrity } from '../utils/deviceIntegrity';
import { useDeviceIntegrity } from '../utils/useDeviceIntegrity';

let appStateListener: ((state: string) => void) | null = null;

const addEventListenerSpy = jest
  .spyOn(AppState, 'addEventListener')
  .mockImplementation((_type: string, listener: (state: string) => void) => {
    appStateListener = listener;
    return { remove: jest.fn(() => { appStateListener = null; }) };
  });

beforeEach(() => {
  (JailMonkey.isJailBroken as jest.Mock).mockClear();
  (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(false);
  appStateListener = null;
  addEventListenerSpy.mockClear();
});

function simulateAppState(state: string) {
  act(() => {
    appStateListener?.(state);
  });
}

describe('checkDeviceIntegrity', () => {
  test('reports not compromised when JailMonkey.isJailBroken() is false', () => {
    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(false);

    expect(checkDeviceIntegrity()).toEqual({ isCompromised: false });
  });

  test('reports compromised when JailMonkey.isJailBroken() is true', () => {
    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(true);

    expect(checkDeviceIntegrity()).toEqual({ isCompromised: true });
  });
});

describe('useDeviceIntegrity', () => {
  test('exposes isCompromised: false for a clean device', () => {
    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(false);

    const { result } = renderHook(() => useDeviceIntegrity());

    expect(result.current.isCompromised).toBe(false);
  });

  test('exposes isCompromised: true for a jailbroken/rooted device', () => {
    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(true);

    const { result } = renderHook(() => useDeviceIntegrity());

    expect(result.current.isCompromised).toBe(true);
  });

  test('re-checks integrity when the app transitions from background to foreground', () => {
    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(false);

    const { result } = renderHook(() => useDeviceIntegrity());
    expect(result.current.isCompromised).toBe(false);

    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(true);

    simulateAppState('active');

    expect(result.current.isCompromised).toBe(true);
    expect(addEventListenerSpy).toHaveBeenCalled();
  });

  test('does not re-check when the app only transitions to background', () => {
    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(false);

    const { result } = renderHook(() => useDeviceIntegrity());
    expect(result.current.isCompromised).toBe(false);

    (JailMonkey.isJailBroken as jest.Mock).mockReturnValue(true);

    simulateAppState('background');

    expect(result.current.isCompromised).toBe(false);
  });

  test('removes the AppState listener on unmount', () => {
    const { unmount } = renderHook(() => useDeviceIntegrity());
    const remove = (addEventListenerSpy.mock.results[0].value as { remove: jest.Mock }).remove;

    unmount();

    expect(remove).toHaveBeenCalled();
  });
});