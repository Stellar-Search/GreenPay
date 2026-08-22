/**
 * __tests__/useCachedResource.test.tsx
 *
 * The shared cache hook must keep isStale on the return value and reload
 * when NetInfo reports a reconnect — the same signal useDonationSync uses.
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';
import axios from 'axios';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCachedResource } from '../hooks/useCachedResource';

const PAYLOAD = [{ id: 'p1', name: 'Amazon' }];

describe('useCachedResource', () => {
  let reconnectListener: ((state: { isConnected?: boolean }) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    reconnectListener = undefined;
    (NetInfo.addEventListener as jest.Mock).mockImplementation((cb: (state: any) => void) => {
      reconnectListener = cb;
      return jest.fn();
    });
    (NetInfo.fetch as jest.Mock).mockResolvedValue({ isConnected: true });
  });

  it('exposes isStale when falling back to expired cache', async () => {
    const stale = JSON.stringify({
      data: PAYLOAD,
      timestamp: Date.now() - 11 * 60 * 1000,
    });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(stale);
    (axios.get as jest.Mock).mockRejectedValue(new Error('offline'));

    const fetcher = jest.fn(async () => {
      const res = await axios.get('/api/projects');
      return res.data.data;
    });

    const { result } = renderHook(() => useCachedResource('home:projects_list', fetcher));

    await waitFor(() => {
      expect(result.current.fromCache).toBe(true);
      expect(result.current.isStale).toBe(true);
      expect(result.current.data).toEqual(PAYLOAD);
    });
  });

  it('reloads on the NetInfo reconnect transition', async () => {
    (axios.get as jest.Mock)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: { data: PAYLOAD } });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

    const fetcher = jest.fn(async () => {
      const res = await axios.get('/api/projects');
      return res.data.data;
    });

    const { result } = renderHook(() => useCachedResource('home:projects_list', fetcher));

    await waitFor(() => expect(result.current.error).toBe(true));

    await act(async () => {
      reconnectListener?.({ isConnected: false });
    });
    await act(async () => {
      reconnectListener?.({ isConnected: true });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(PAYLOAD);
      expect(result.current.fromCache).toBe(false);
      expect(result.current.isStale).toBe(false);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
