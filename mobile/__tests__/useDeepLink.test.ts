/**
 * __tests__/useDeepLink.test.ts
 *
 * Tests for the useDeepLink hook, including the hydration-queue fix (#32).
 * The hook now depends on AppInitContext, so every render is wrapped in
 * AppInitProvider.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppInitProvider } from '../src/context/AppInitContext';

const mockPush = jest.fn();
const mockGetInitialURL = jest.fn(() => Promise.resolve(null));
const mockAddEventListener = jest.fn(() => ({ remove: jest.fn() }));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('expo-linking', () => ({
  getInitialURL: () => mockGetInitialURL(),
  addEventListener: (...args: unknown[]) => mockAddEventListener(...args),
  parse: (url: string) => {
    const match = url.match(/^greenpay:\/\/(.+)/);
    return { path: match ? match[1] : null };
  },
}));

jest.mock('../utils/recurringDonations', () => ({
  getRecurringDonation: jest.fn().mockResolvedValue(null),
}));

import { useDeepLink } from '../hooks/useDeepLink';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(AppInitProvider, null, children);

beforeEach(() => {
  mockPush.mockClear();
  mockGetInitialURL.mockResolvedValue(null);
});

// ── Cold-start navigation ────────────────────────────────────────────────────

test('navigates to project screen on cold start after hydration', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://project/42');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).toHaveBeenCalledWith('/projects/42');
  unmount();
});

test('navigates to donate screen on cold start after hydration', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://donate/GABCXYZ');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).toHaveBeenCalledWith('/donate/GABCXYZ');
  unmount();
});

// ── Warm-start navigation ───────────────────────────────────────────────────

test('handles warm-start url event for project', async () => {
  let urlHandler: ((e: { url: string }) => void) | undefined;
  mockAddEventListener.mockImplementationOnce(
    (_event: string, handler: (e: { url: string }) => void) => {
      urlHandler = handler;
      return { remove: jest.fn() };
    },
  );

  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {
    urlHandler?.({ url: 'greenpay://project/99' });
  });
  expect(mockPush).toHaveBeenCalledWith('/projects/99');
  unmount();
});

// ── Guard rails ─────────────────────────────────────────────────────────────

test('does not navigate for unknown path segments', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://unknown/123');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

test('does not navigate when url has no param', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://project');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

// ── Deep-link validation (shared rules with the QR parser) ───────────────────

test('does not navigate for a deep link with a traversal project id', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://donate/../../etc/passwd');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

test('does not navigate for a deep link with an oversized project id', async () => {
  mockGetInitialURL.mockResolvedValueOnce(`greenpay://donate/${'a'.repeat(65)}`);
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

test('does not navigate for a deep link with a control character in the id', async () => {
  const ctrl = String.fromCharCode(2);
  mockGetInitialURL.mockResolvedValueOnce(`greenpay://donate/abc${ctrl}`);
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

test('does not navigate for a deep link with a query string or extra segment', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://donate/abc?evil=1');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

test('does not navigate for a deep link with a foreign host segment', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://evil.com/donate/abc');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });
  await act(async () => {});
  expect(mockPush).not.toHaveBeenCalled();
  unmount();
});

// ── Race condition fix (#32) ─────────────────────────────────────────────────

test('queues cold-start link and processes it only once after hydration', async () => {
  mockGetInitialURL.mockResolvedValueOnce('greenpay://donate/GQUEUE');
  const { unmount } = renderHook(() => useDeepLink(), { wrapper });

  // Flush all microtasks (hydration + URL resolution + handler invocation)
  await act(async () => {});

  // Must be called exactly once — not before hydration, not doubled
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/donate/GQUEUE');
  unmount();
});
