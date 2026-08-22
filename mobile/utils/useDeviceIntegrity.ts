/**
 * utils/useDeviceIntegrity.ts
 *
 * Runs the (synchronous, native-module-backed) jailbreak/root check on mount
 * and re-checks on every app foreground transition (AppState -> 'active'),
 * since a device that appears clean at cold mount can gain jailbreak/root
 * tooling while backgrounded. Exposes the latest result as a boolean. Kept
 * separate from deviceIntegrity.ts so plain non-React code can call
 * checkDeviceIntegrity() directly without needing hooks.
 *
 * Advisory only: the result powers a dismissible warning banner and never
 * blocks app functionality (see utils/deviceIntegrity.ts).
 */
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { checkDeviceIntegrity } from './deviceIntegrity';

export function useDeviceIntegrity(): { isCompromised: boolean } {
  const [isCompromised, setIsCompromised] = useState(() => checkDeviceIntegrity().isCompromised);

  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setIsCompromised(checkDeviceIntegrity().isCompromised);
      }
    });
    return () => appStateSubscription.remove();
  }, []);

  return { isCompromised };
}