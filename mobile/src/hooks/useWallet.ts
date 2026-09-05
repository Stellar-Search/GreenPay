import { useState, useEffect, useCallback } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { StrKey } from '@stellar/stellar-sdk';
import {
  getWalletPublicKey,
  setWalletPublicKey,
  clearWalletPublicKey,
} from '../../utils/walletKeyStorage';
import { syncPushTokenWithWallet } from '../../utils/notifications';

export function useWallet() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchKey = useCallback(() => {
    getWalletPublicKey()
      .then((stored) => setPublicKey(stored))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchKey();
    const subscription = DeviceEventEmitter.addListener('WALLET_CHANGED', fetchKey);
    return () => subscription.remove();
  }, [fetchKey]);

  const connect = useCallback(async (address: string) => {
    setError(null);
    const trimmed = address.trim();

    if (!StrKey.isValidEd25519PublicKey(trimmed)) {
      setError('Invalid Stellar address. Must start with G and be 56 characters.');
      return false;
    }

    await setWalletPublicKey(trimmed);
    setPublicKey(trimmed);
    DeviceEventEmitter.emit('WALLET_CHANGED');
    void syncPushTokenWithWallet(trimmed);
    return true;
  }, []);

  const disconnect = useCallback(async () => {
    await clearWalletPublicKey();
    setPublicKey(null);
    DeviceEventEmitter.emit('WALLET_CHANGED');
    void syncPushTokenWithWallet(undefined);
  }, []);

  return { publicKey, loading, error, connect, disconnect };
}
