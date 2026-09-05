/**
 * src/context/AppInitContext.tsx
 *
 * Provides a strict, ordered app-initialization sequence that solves the
 * deep-link / push-notification / state-hydration race condition.
 *
 * Startup dependency graph:
 *   1. SecureStore read (via utils/walletKeyStorage) (wallet public key)
 *   2. isHydrated = true                 (state is safe to read)
 *   3. Pending deep-link / notification destination processed (navigation is now safe)
 *
 * Any deep link or notification tap that arrives before step 2 is queued in a ref and replayed
 * exactly once after hydration completes. Subsequent events (warm start) are
 * processed immediately because isHydrated is already true.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { getWalletPublicKey } from '../../utils/walletKeyStorage';
import { AppDestination, resolveDeepLinkDestination } from '../../utils/navigationDestinations';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppInitState {
  /** True once all local-storage reads have completed and the root state is safe to use. */
  isHydrated: boolean;
  /** Wallet public key restored from SecureStore during hydration (null if not connected). */
  walletPublicKey: string | null;
  /**
   * Queue a deep-link URL to be processed after hydration.
   */
  queueDeepLink: (url: string) => void;
  /**
   * Register a handler that will be called once — either immediately (if
   * already hydrated) or after hydration completes — with the pending URL.
   */
  onDeepLinkReady: (handler: (url: string) => void) => void;
  /**
   * Queue a validated destination to be processed after hydration.
   */
  queueDestination: (destination: AppDestination) => void;
  /**
   * Register a handler for pending AppDestination navigation after hydration.
   */
  onDestinationReady: (handler: (destination: AppDestination) => void) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AppInitContext = createContext<AppInitState | null>(null);

export function useAppInit(): AppInitState {
  const ctx = useContext(AppInitContext);
  if (!ctx) {
    throw new Error('useAppInit must be used inside <AppInitProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppInitProvider({ children }: { children: React.ReactNode }) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [walletPublicKey, setWalletPublicKey] = useState<string | null>(null);
  const isHydratedRef = useRef(false);

  // Queue holds at most one pending item for cold-start scenarios
  const pendingUrl = useRef<string | null>(null);
  const pendingDestination = useRef<AppDestination | null>(null);

  const deepLinkHandler = useRef<((url: string) => void) | null>(null);
  const destinationHandler = useRef<((dest: AppDestination) => void) | null>(null);

  // ── Step 1: hydrate all local state ──────────────────────────────────────
  useEffect(() => {
    async function hydrate() {
      try {
        const stored = await getWalletPublicKey();
        setWalletPublicKey(stored ?? null);
      } catch {
        // Non-fatal — app continues without a pre-loaded wallet.
      } finally {
        // ── Step 2: mark hydration complete ──────────────────────────────
        isHydratedRef.current = true;
        setIsHydrated(true);
      }
    }

    hydrate();
  }, []);

  // ── Step 3: flush pending items once hydration finishes ──────────────────
  useEffect(() => {
    if (!isHydrated) return;

    if (pendingDestination.current && destinationHandler.current) {
      const dest = pendingDestination.current;
      pendingDestination.current = null;
      destinationHandler.current(dest);
    }

    if (pendingUrl.current) {
      const url = pendingUrl.current;
      pendingUrl.current = null;
      if (deepLinkHandler.current) {
        deepLinkHandler.current(url);
      }
      if (destinationHandler.current && !pendingDestination.current) {
        const dest = resolveDeepLinkDestination(url);
        if (dest) {
          destinationHandler.current(dest);
        }
      }
    }
  }, [isHydrated]);

  // ── Public API ────────────────────────────────────────────────────────────

  const queueDeepLink = useCallback((url: string) => {
    if (isHydratedRef.current) {
      if (deepLinkHandler.current) {
        deepLinkHandler.current(url);
      } else if (destinationHandler.current) {
        const dest = resolveDeepLinkDestination(url);
        if (dest) destinationHandler.current(dest);
      }
    } else {
      pendingUrl.current = url;
    }
  }, []);

  const onDeepLinkReady = useCallback((handler: (url: string) => void) => {
    deepLinkHandler.current = handler;

    if (isHydratedRef.current && pendingUrl.current) {
      const url = pendingUrl.current;
      pendingUrl.current = null;
      handler(url);
    }
  }, []);

  const queueDestination = useCallback((dest: AppDestination) => {
    if (isHydratedRef.current) {
      destinationHandler.current?.(dest);
    } else {
      pendingDestination.current = dest;
    }
  }, []);

  const onDestinationReady = useCallback((handler: (dest: AppDestination) => void) => {
    destinationHandler.current = handler;

    if (isHydratedRef.current) {
      if (pendingDestination.current) {
        const dest = pendingDestination.current;
        pendingDestination.current = null;
        handler(dest);
      } else if (pendingUrl.current) {
        const url = pendingUrl.current;
        pendingUrl.current = null;
        const dest = resolveDeepLinkDestination(url);
        if (dest) handler(dest);
      }
    }
  }, []);

  return (
    <AppInitContext.Provider
      value={{
        isHydrated,
        walletPublicKey,
        queueDeepLink,
        onDeepLinkReady,
        queueDestination,
        onDestinationReady,
      }}
    >
      {children}
    </AppInitContext.Provider>
  );
}
