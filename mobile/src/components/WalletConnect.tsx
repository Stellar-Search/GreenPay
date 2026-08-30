import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Modal,
  Alert,
} from 'react-native';
import { useWallet } from '../hooks/useWallet';
import { FirstDonationPaths } from './FirstDonationPaths';
import { track } from '../../utils/funnel';

interface WalletConnectProps {
  /**
   * Offer the no-account paths alongside manual address entry. Opt-in per
   * screen and off by default, so every existing call site keeps exactly the
   * behaviour it had — the donors it already serves are not the ones with a
   * problem.
   */
  allowGuidedOnboarding?: boolean;
  projectId?: string;
}

// Lobstr deep-links only support payment requests, not wallet connection.
// WalletConnect for Stellar (SEP-43) is still in draft and has no stable
// mobile SDK. Manual public-key entry with SecureStore is the reliable choice.
export function WalletConnect({ allowGuidedOnboarding = false, projectId }: WalletConnectProps = {}) {
  const { publicKey, loading, error, connect, disconnect } = useWallet();
  const [modalVisible, setModalVisible] = useState(false);
  const [inputAddress, setInputAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [showPaths, setShowPaths] = useState(false);

  if (loading) return <ActivityIndicator size="small" color="#22c55e" />;

  if (publicKey) {
    return (
      <TouchableOpacity
        style={styles.connectedBadge}
        onLongPress={() =>
          Alert.alert('Disconnect wallet?', truncateAddress(publicKey), [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Disconnect', style: 'destructive', onPress: disconnect },
          ])
        }
      >
        <View style={styles.dot} />
        <Text style={styles.addressText}>{truncateAddress(publicKey)}</Text>
      </TouchableOpacity>
    );
  }

  const handleConnect = async () => {
    setConnecting(true);
    const ok = await connect(inputAddress);
    setConnecting(false);
    if (ok) {
      setModalVisible(false);
      setInputAddress('');
      void track('account_ready', { path: 'connected_wallet', projectId });
    }
  };

  /**
   * Adopts the address the onboarding flow just created. It goes through the
   * same `connect` as a hand-typed address, so a sponsored donor's session is
   * stored and restored exactly like anyone else's.
   */
  const handleOnboarded = async (address: string) => {
    const ok = await connect(address);
    if (ok) {
      setShowPaths(false);
      setModalVisible(false);
    }
  };

  if (showPaths) {
    return (
      <FirstDonationPaths
        projectId={projectId}
        onAccountReady={handleOnboarded}
        onUseExistingWallet={() => {
          setShowPaths(false);
          setModalVisible(true);
        }}
      />
    );
  }

  return (
    <>
      <TouchableOpacity style={styles.connectButton} onPress={() => setModalVisible(true)}>
        <Text style={styles.connectButtonText}>Connect Wallet</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Connect Stellar Wallet</Text>
            <Text style={styles.sheetSubtitle}>
              Enter your Stellar public key (starts with G)
            </Text>

            <TextInput
              style={styles.input}
              placeholder="GABC...XYZ"
              placeholderTextColor="#9ca3af"
              value={inputAddress}
              onChangeText={setInputAddress}
              autoCapitalize="characters"
              autoCorrect={false}
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <TouchableOpacity
              style={[styles.confirmButton, connecting && styles.disabled]}
              onPress={handleConnect}
              disabled={connecting || !inputAddress.trim()}
            >
              {connecting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.confirmButtonText}>Connect</Text>
              )}
            </TouchableOpacity>

            {allowGuidedOnboarding && (
              // Previously this modal's only outcome for a donor without an
              // address was to close it. That is where first-time donors
              // stopped.
              <TouchableOpacity
                onPress={() => {
                  setModalVisible(false);
                  setShowPaths(true);
                }}
                testID="mobile-no-wallet"
              >
                <Text style={styles.noWalletText}>
                  Don&apos;t have a Stellar address? Donate without one →
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

function truncateAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const styles = StyleSheet.create({
  connectButton: {
    backgroundColor: '#22c55e',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
  },
  connectButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  connectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0fdf4',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', marginRight: 6 },
  addressText: { color: '#15803d', fontWeight: '600', fontSize: 13 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  sheetSubtitle: { color: '#6b7280', marginBottom: 16, fontSize: 14 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 13,
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  errorText: { color: '#ef4444', fontSize: 12, marginBottom: 10 },
  confirmButton: {
    backgroundColor: '#22c55e',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  confirmButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.5 },
  cancelText: { color: '#6b7280', textAlign: 'center', fontSize: 14 },
  noWalletText: {
    color: '#16a34a',
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
});
