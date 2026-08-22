/**
 * app/donate/[id].tsx
 * Donate screen with project selector, amount input, and Stellar transaction submission.
 */
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { authenticate } from '../../hooks/useBiometricAuth';
import { Keypair, Horizon } from '@stellar/stellar-sdk';

const StellarServer = (require('@stellar/stellar-sdk') as any).Server || Horizon.Server;
import { useTheme } from '../theme';
import { parseAmountToStroops, formatStroopsToXLM, STROOPS_PER_XLM } from '../../utils/amount';
import {
  enqueueDonation,
  getQueuedDonation,
  removeQueuedDonation,
  updateQueuedDonation,
  QueuedDonation,
} from '../../utils/donationQueue';
import { apiGet, apiPost } from '../../utils/api';
import { buildDonationPaymentTransaction } from '../../utils/donationTransaction';
import {
  getConfiguredHorizonUrl,
  getExpectedNetworkDisplayName,
} from '../../utils/stellarNetwork';

const HORIZON_URL = getConfiguredHorizonUrl();

interface ClimateProject {
  id: string;
  name: string;
  description: string;
  walletAddress: string;
}

export default function DonateScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id, queueId } = useLocalSearchParams();
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(id as string | undefined);
  const [amount, setAmount] = useState('1');
  const [message, setMessage] = useState('');
  const [queueEntry, setQueueEntry] = useState<QueuedDonation | null>(null);
  const [secretKey, setSecretKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<'success' | 'error' | 'info' | null>(null);

  useEffect(() => {
    loadProjects();
  }, [id]);

  // Arriving from the offline queue ("Complete now") — prefill the amount
  // and message from the queued intent, and check whether a prior attempt
  // already reached Horizon before the backend confirmation failed.
  useEffect(() => {
    if (!queueId) return;
    (async () => {
      const entry = await getQueuedDonation(queueId as string);
      if (!entry) return;
      setQueueEntry(entry);
      setAmount(entry.amountXLM);
      setMessage(entry.message || '');
      if (entry.horizonTransactionHash) {
        setStatusType('info');
        setStatusMessage(
          `This donation already reached the blockchain (tx ${entry.horizonTransactionHash}) but we couldn't confirm it with our server yet. Tap Donate to retry confirming it — it will not be submitted again.`
        );
      }
    })();
  }, [queueId]);

  const loadProjects = async () => {
    setLoading(true);
    setStatusMessage(null);

    try {
      const list = await apiGet<ClimateProject[]>('/api/projects');
      setProjects(list);
      const initialProjectId = (id as string | undefined) || list[0]?.id;
      setSelectedProjectId(initialProjectId);
    } catch (error) {
      console.error('Error loading projects:', error);
      setStatusType('error');
      setStatusMessage('Unable to load projects. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0] || null;

  /**
   * A prior attempt for this queued donation already reached Horizon but the
   * backend confirmation failed afterward. Never re-sign or re-submit the
   * payment — only retry reporting the existing transaction hash.
   */
  const retryBackendConfirmation = async (entry: QueuedDonation & { horizonTransactionHash: string }) => {
    setSubmitting(true);
    setStatusType('info');
    setStatusMessage('Confirming your donation with the server...');
    try {
      await apiPost('/api/donations', {
        projectId: entry.projectId,
        donorAddress: entry.donorAddress,
        amountXLM: entry.amountXLM,
        amount: entry.amountXLM,
        currency: 'XLM',
        message: entry.message,
        transactionHash: entry.horizonTransactionHash,
      });
      await removeQueuedDonation(entry.id);
      setQueueEntry(null);
      setStatusType('success');
      setStatusMessage(`Donation successful! Transaction hash: ${entry.horizonTransactionHash}`);
      setAmount('1');
      setMessage('');
    } catch (error) {
      console.error('Donation confirmation retry failed:', error);
      setStatusType('info');
      setStatusMessage(
        `Your donation already reached the blockchain (tx ${entry.horizonTransactionHash}) but we still can't confirm it with our server. It's saved and won't be submitted twice — try again shortly.`
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDonate = async () => {
    if (!selectedProject) {
      Alert.alert('Error', 'Please choose a project to donate to.');
      return;
    }

    if (queueEntry?.horizonTransactionHash) {
      await retryBackendConfirmation(queueEntry as QueuedDonation & { horizonTransactionHash: string });
      return;
    }

    const donationStroops = parseAmountToStroops(amount);
    const minStroops = STROOPS_PER_XLM;
    if (donationStroops === null || donationStroops < minStroops) {
      Alert.alert('Error', 'Please enter a valid amount (minimum 1 XLM).');
      return;
    }

    const formattedAmount = formatStroopsToXLM(donationStroops);

    if (!publicKey) {
      Alert.alert('Wallet Required', 'Please connect your Stellar wallet first.');
      return;
    }

    const netState = await NetInfo.fetch();
    const isOffline = netState?.isConnected === false;

    if (isOffline) {
      // No connectivity: don't attempt any Horizon/backend calls. Queue the
      // donation *intent* only (no secret key — never persisted) so the user
      // can finish signing it once they're back online.
      await enqueueDonation({
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        donorAddress: publicKey,
        amountXLM: formattedAmount,
        message: message.trim() || undefined,
      });

      setStatusType('info');
      setStatusMessage(
        "You're offline — this donation has been saved and will be ready to complete once you're back online."
      );
      setAmount('1');
      setMessage('');
      setSecretKey('');
      return;
    }

    if (!secretKey.trim()) {
      Alert.alert('Secret Required', 'Please enter your Stellar secret key to sign the transaction.');
      return;
    }

    let keypair;
    try {
      keypair = Keypair.fromSecret(secretKey.trim());
    } catch (error) {
      Alert.alert('Invalid Secret Key', 'The secret key you entered is not valid.');
      return;
    }

    if (keypair.publicKey() !== publicKey) {
      Alert.alert(
        'Key Mismatch',
        'The secret key does not match the connected public key. Please use the same account.'
      );
      return;
    }

    const authenticated = await authenticate('Confirm donation with biometrics or PIN');
    if (!authenticated) {
      Alert.alert('Authentication Required', 'You must authenticate to sign the transaction.');
      return;
    }

    setSubmitting(true);
    setStatusType('info');
    setStatusMessage('Signing and submitting your donation...');

    let transactionHash: string;
    try {
      const server = new StellarServer(HORIZON_URL);
      const sourceAccount = await server.loadAccount(publicKey);

      const transaction = buildDonationPaymentTransaction({
        sourceAccount,
        destination: selectedProject.walletAddress,
        amount: formattedAmount,
        projectId: selectedProject.id,
      });

      transaction.sign(keypair);

      const horizonResult = await server.submitTransaction(transaction);
      transactionHash = horizonResult.hash;
    } catch (error: any) {
      console.error('Donation failed:', error);
      setStatusType('error');
      setStatusMessage(
        error?.message || 'Donation failed. Please try again.'
      );
      setSubmitting(false);
      return;
    }

    // Horizon has already accepted the payment at this point — it must never
    // be resubmitted, even if the backend confirmation below fails.
    try {
      await apiPost('/api/donations', {
        projectId: selectedProject.id,
        donorAddress: publicKey,
        amountXLM: formattedAmount,
        amount: formattedAmount,
        currency: 'XLM',
        message: message.trim() || undefined,
        transactionHash,
      });

      if (queueEntry) {
        await removeQueuedDonation(queueEntry.id);
        setQueueEntry(null);
      }

      setStatusType('success');
      setStatusMessage(`Donation successful! Transaction hash: ${transactionHash}`);
      setAmount('1');
      setMessage('');
      setSecretKey('');
    } catch (error) {
      console.error('Donation backend confirmation failed:', error);
      if (queueEntry) {
        // Queue-originated donation: stamp the hash onto the existing entry.
        await updateQueuedDonation(queueEntry.id, { horizonTransactionHash: transactionHash });
        setQueueEntry({ ...queueEntry, horizonTransactionHash: transactionHash });
      } else {
        // Plain online donation (no prior queue entry): the payment already
        // reached Horizon, so we must never resubmit it. Create a rescue entry
        // with the tx hash pre-stamped so the hash survives navigation/restart
        // and the background sync can retry backend confirmation on reconnect.
        const rescue = await enqueueDonation({
          projectId: selectedProject.id,
          projectName: selectedProject.name,
          donorAddress: publicKey,
          amountXLM: formattedAmount,
          message: message.trim() || undefined,
        });
        await updateQueuedDonation(rescue.id, { horizonTransactionHash: transactionHash });
        setQueueEntry({ ...rescue, horizonTransactionHash: transactionHash });
      }
      setStatusType('info');
      setStatusMessage(
        `Your donation reached the blockchain (tx ${transactionHash}) but we couldn't confirm it with our server yet. It's saved and won't be submitted twice — tap Donate again to retry confirming it.`
      );
      setSecretKey('');
    } finally {
      setSubmitting(false);
    }
  };

  const connectWallet = async () => {
    Alert.alert(
      'Connect Wallet',
      'Enter your Stellar public key:',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'OK',
          onPress: (input: any) => {
            const trimmed = String(input || '').trim();
            if (/^G[A-Z0-9]{55}$/.test(trimmed)) {
              setPublicKey(trimmed);
            } else {
              Alert.alert('Invalid Key', 'Please enter a valid Stellar public key');
            }
          },
        },
      ],
      { cancelable: true }
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#227239" />
        <Text style={styles.loadingText}>Loading donation details...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Donate to {selectedProject?.name || 'a project'}</Text>
        <Text style={styles.subtitle}>
          Choose a project and donate XLM on {getExpectedNetworkDisplayName()}.
        </Text>
      </View>

      <View style={styles.selectorCard}>
        <Text style={styles.sectionTitle}>Select a project</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.projectList}>
          {projects.map((project) => (
            <TouchableOpacity
              key={project.id}
              style={[
                styles.projectOption,
                project.id === selectedProjectId && styles.projectOptionActive,
              ]}
              onPress={() => setSelectedProjectId(project.id)}
            >
              <Text
                style={[
                  styles.projectOptionText,
                  project.id === selectedProjectId && styles.projectOptionTextActive,
                ]}
              >
                {project.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {!publicKey ? (
        <TouchableOpacity style={[styles.connectButton, { backgroundColor: colors.buttonBackground }]}
          onPress={connectWallet}
        >
          <Text style={[styles.connectButtonText, { color: colors.buttonText }]}>Connect Wallet</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.walletCard}>
          <Text style={styles.walletLabel}>Connected wallet</Text>
          <Text style={styles.walletAddress}>{publicKey.slice(0, 8)}...{publicKey.slice(-4)}</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Amount (XLM)</Text>
        <TextInput
          style={styles.input}
          placeholder="1.00"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
        />

        <Text style={styles.label}>Secret Key</Text>
        <TextInput
          style={styles.input}
          placeholder="S..."
          value={secretKey}
          onChangeText={setSecretKey}
          autoCapitalize="none"
          secureTextEntry
        />

        <Text style={[styles.label, { color: colors.primaryText }]}>Message (optional)</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.primaryText }]}
          placeholder="Leave a message of support..."
          placeholderTextColor={colors.placeholder}
          value={message}
          onChangeText={setMessage}
          maxLength={100}
        />
      </View>

      {statusMessage ? (
        <View
          style={[
            styles.statusBox,
            statusType === 'success'
              ? styles.successBox
              : statusType === 'error'
              ? styles.errorBox
              : styles.infoBox,
          ]}
        >
          <Text style={styles.statusText}>{statusMessage}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.donateButton, submitting && styles.donateButtonDisabled]}
        onPress={handleDonate}
        disabled={submitting}
      >
        <Text style={styles.donateButtonText}>
          {submitting
            ? 'Sending donation...'
            : queueEntry?.horizonTransactionHash
            ? '🌱 Confirm with server'
            : `🌱 Donate ${amount || '1'} XLM`}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingText: {
    fontSize: 18,
    textAlign: 'center',
    marginTop: 16,
  },
  header: {
    padding: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  selectorCard: {
    margin: 16,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
    color: '#1f5136',
  },
  projectList: {
    flexDirection: 'row',
  },
  projectOption: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#f0f7f0',
    marginRight: 10,
  },
  projectOptionActive: {
    backgroundColor: '#227239',
  },
  projectOptionText: {
    color: '#1f5136',
    fontSize: 14,
  },
  projectOptionTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  connectButton: {
    padding: 16,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    alignItems: 'center',
  },
  connectButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  walletCard: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d1e7d1',
  },
  walletLabel: {
    fontSize: 12,
    color: '#6b8f6b',
  },
  walletAddress: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f5136',
    marginTop: 4,
  },
  card: {
    margin: 16,
    padding: 20,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  statusBox: {
    marginHorizontal: 16,
    marginTop: 4,
    padding: 14,
    borderRadius: 12,
  },
  successBox: {
    backgroundColor: '#ecfdf5',
    borderColor: '#34d399',
    borderWidth: 1,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderColor: '#f87171',
    borderWidth: 1,
  },
  infoBox: {
    backgroundColor: '#eff6ff',
    borderColor: '#60a5fa',
    borderWidth: 1,
  },
  statusText: {
    color: '#0f172a',
  },
  donateButton: {
    padding: 16,
    margin: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  donateButtonDisabled: {
    backgroundColor: '#8aaa8a',
  },
  donateButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
});
