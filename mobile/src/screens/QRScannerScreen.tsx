import React, { useRef, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { BarCodeScanner, BarCodeScannerResult } from 'expo-barcode-scanner';
import { useRouter } from 'expo-router';
import { parseSep7PayUri } from '../../utils/sep7';
import { parseGreenPayDonationLink } from '../../utils/qrPayload';
import { apiGet } from '../../utils/api';

interface ClimateProject {
  id: string;
  walletAddress: string;
  status: string;
}

/**
 * Looks up an *active* GreenPay project whose wallet address matches the
 * destination resolved from a scanned SEP-7 payment URI. A checksum-valid
 * Stellar address is not necessarily a *trusted* one — this cross-check is
 * what prevents a scanned QR code from silently routing a donation to an
 * arbitrary (if well-formed) address that has no relationship to GreenPay.
 */
async function findActiveProjectByWalletAddress(destination: string): Promise<ClimateProject | null> {
  try {
    const list = await apiGet<ClimateProject[]>('/api/projects');
    const match = list.find(
      (project) => project.status === 'active' && project.walletAddress === destination
    );
    return match || null;
  } catch {
    return null;
  }
}

/** Human-readable messages for each SEP-7 parse failure reason. */
function sep7RejectionMessage(reason: string): string {
  switch (reason) {
    case 'network-mismatch':
      return 'This payment request targets a different Stellar network than this app is configured for.';
    case 'invalid-destination':
      return 'This payment request does not contain a valid Stellar destination address.';
    case 'invalid-amount':
      return 'This payment request contains an invalid amount.';
    default:
      return 'This payment request is not a valid GreenPay payment link.';
  }
}

function looksLikeSep7Uri(data: string): boolean {
  return data.trim().toLowerCase().startsWith('web+stellar:');
}

export function QRScannerScreen() {
  const router = useRouter();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const scanningRef = useRef(false);

  useEffect(() => {
    let isMounted = true;
    BarCodeScanner.requestPermissionsAsync()
      .then(({ status }) => {
        if (isMounted) setHasPermission(status === 'granted');
      })
      .catch(() => {
        if (isMounted) setHasPermission(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const rejectScan = (message: string) => {
    Alert.alert(
      'Unrecognized QR code',
      message,
      [
        { text: 'Scan again', onPress: () => { setScanned(false); scanningRef.current = false; } },
        { text: 'Cancel', onPress: () => router.back() },
      ],
      {
        cancelable: true,
        onDismiss: () => { setScanned(false); scanningRef.current = false; },
      }
    );
  };

  const navigateToProject = (projectId: string) => {
    router.replace(`/donate/${projectId}`);
  };

  const handleBarCodeScanned = async ({ data }: BarCodeScannerResult) => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanned(true);

    if (typeof data !== 'string' || data.length === 0) {
      rejectScan('This QR code is not a GreenPay donation link.');
      return;
    }

    // 1. SEP-7 payment URI (web+stellar:pay?...) — only trusted once the
    // resolved destination matches a known, active GreenPay project.
    const sep7 = parseSep7PayUri(data);
    if (sep7.ok) {
      const project = await findActiveProjectByWalletAddress(sep7.destination);
      if (project) {
        navigateToProject(project.id);
        return;
      }
      rejectScan("This payment destination doesn't match a known GreenPay project.");
      return;
    }
    if (looksLikeSep7Uri(data)) {
      // It was clearly an attempt at a SEP-7 URI — give a specific reason
      // rather than falling through to the GreenPay-link parser (which
      // can't possibly match a web+stellar: URI anyway).
      rejectScan(sep7RejectionMessage(sep7.reason));
      return;
    }

    // 2. GreenPay's own donation link / custom scheme.
    const link = parseGreenPayDonationLink(data);
    if (link.ok) {
      navigateToProject(link.projectId);
      return;
    }

    // 3. Neither format recognized — fail closed.
    rejectScan('This QR code is not a GreenPay donation link.');
  };

  if (hasPermission === null) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Requesting camera permission…</Text>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Camera access is required to scan QR codes.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <BarCodeScanner
        onBarCodeScanned={handleBarCodeScanned}
        style={StyleSheet.absoluteFillObject}
        barCodeTypes={[BarCodeScanner.Constants.BarCodeType.qr]}
      />

      <View style={styles.overlay}>
        <Text style={styles.hint}>Point camera at a GreenPay QR code</Text>
        <View style={styles.frame} />
        {scanned && (
          <TouchableOpacity style={styles.rescanButton} onPress={() => { setScanned(false); scanningRef.current = false; }}>
            <Text style={styles.rescanText}>Tap to scan again</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => router.back()} style={styles.cancelButton}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  message: { fontSize: 15, color: '#374151', textAlign: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between', alignItems: 'center', padding: 32 },
  hint: { color: '#fff', fontSize: 15, marginTop: 20, textAlign: 'center' },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: '#22c55e',
    borderRadius: 16,
  },
  rescanButton: { backgroundColor: '#22c55e', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
  rescanText: { color: '#fff', fontWeight: '600' },
  cancelButton: { paddingVertical: 12, paddingHorizontal: 24 },
  cancelText: { color: '#fff', fontSize: 15 },
  backButton: { marginTop: 16, backgroundColor: '#22c55e', padding: 12, borderRadius: 8 },
  backButtonText: { color: '#fff', fontWeight: '600' },
});
