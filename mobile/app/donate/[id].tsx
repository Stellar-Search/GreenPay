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
import { useWallet } from '../../src/hooks/useWallet';
import { WalletConnect } from '../../src/components/WalletConnect';
import {
  createRecurringDonation,
  completeRecurringCycle,
  getRecurringDonation,
  requestNotificationPermissionsIfNeeded,
} from '../../utils/recurringDonations';


const HORIZON_URL = getConfiguredHorizonUrl();

const DURATION_OPTIONS: { label: string; months: number | null }[] = [
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '12 months', months: 12 },
  { label: 'Ongoing', months: null },
];

interface ClimateProject {
  id: string;
  name: string;
  description: string;
  walletAddress: string;
}

export default function DonateScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id, queueId, recurringId, amount: amountParam } = useLocalSearchParams();
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(id as string | undefined);
  const [amount, setAmount] = useState('1');
  const [message, setMessage] = useState('');
  const [queueEntry, setQueueEntry] = useState<QueuedDonation | null>(null);
  const [activeRecurringId, setActiveRecurringId] = useState<string | null>(
    typeof recurringId === 'string' ? recurringId : null,
  );
  const [durationMonths, setDurationMonths] = useState<number | null>(6);
  const [settingUpMonthly, setSettingUpMonthly] = useState(false);
  const [secretKey, setSecretKey] = useState('');
  const { publicKey } = useWallet();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<'success' | 'error' | 'info' | null>(null);

  useEffect(() => {
    loadProjects();
  }, [id]);

  // Prefill from a monthly-due deep link / push notification tap.
  useEffect(() => {
    if (typeof amountParam === 'string' && amountParam.trim()) {
      setAmount(amountParam);
    }
    if (typeof recurringId !== 'string') return;
    (async () => {
      const entry = await getRecurringDonation(recurringId);
      if (!entry || entry.status !== 'active') return;
      setActiveRecurringId(entry.id);
      setAmount(entry.amountXLM);
      setSelectedProjectId(entry.projectId);
      setStatusType('info');
      setStatusMessage(
        `Monthly donation due for ${entry.projectName}. Enter your secret key and tap Donate to sign this cycle — GreenPay never auto-signs.`,
      );
    })();
  }, [recurringId, amountParam]);

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

      // Built by utils/donationTransaction so the network passphrase comes from
      // one place. The previous inline builder referenced TransactionBuilder,
      // Operation, Asset, Memo and NETWORK_PASSPHRASE, none of which are imported
      // in this module, so every submission threw a ReferenceError.
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

      if (activeRecurringId) {
        await completeRecurringCycle(activeRecurringId);
        setActiveRecurringId(null);
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

  const handleSetupMonthly = async () => {
    if (!selectedProject) {
      Alert.alert('Error', 'Please choose a project first.');
      return;
    }
    const donationStroops = parseAmountToStroops(amount);
    if (donationStroops === null || donationStroops < STROOPS_PER_XLM) {
      Alert.alert('Error', 'Enter a valid monthly amount (minimum 1 XLM).');
      return;
    }

    setSettingUpMonthly(true);
    try {
      await requestNotificationPermissionsIfNeeded();
      const created = await createRecurringDonation({
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        amountXLM: formatStroopsToXLM(donationStroops),
        durationMonths,
      });
      setStatusType('success');
      setStatusMessage(
        `Monthly giving scheduled for ${created.amountXLM} XLM. We'll notify you when the next cycle is due — you'll tap to sign; GreenPay never stores your secret key.`,
      );
      Alert.alert(
        'Monthly giving set up',
        `Next reminder: ${new Date(created.nextDueDate).toLocaleDateString()}. Manage it anytime under Monthly Giving.`,
        [
          { text: 'View schedule', onPress: () => router.push('/recurring') },
          { text: 'OK' },
        ],
      );
    } catch (error) {
      console.error('Failed to create recurring donation', error);
      Alert.alert('Error', 'Could not set up monthly giving. Please try again.');
    } finally {
      setSettingUpMonthly(false);
    }
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
        <Text style={styles.subtitle}>Choose a project and donate XLM on {getExpectedNetworkDisplayName()}.</Text>
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

      <View style={{ alignItems: 'center', marginVertical: 8, paddingHorizontal: 16 }}>
        <WalletConnect />
      </View>

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
            : activeRecurringId
            ? `🌱 Sign monthly ${amount || '1'} XLM`
            : `🌱 Donate ${amount || '1'} XLM`}
        </Text>
      </TouchableOpacity>

      {!activeRecurringId && !queueEntry ? (
        <View style={styles.monthlyCard}>
          <Text style={styles.sectionTitle}>Monthly giving</Text>
          <Text style={styles.monthlyHint}>
            Schedule a reminder each month. You always re-enter your secret key to sign —
            GreenPay never auto-pays.
          </Text>
          <View style={styles.durationRow}>
            {DURATION_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.label}
                style={[
                  styles.durationChip,
                  durationMonths === opt.months && styles.durationChipActive,
                ]}
                onPress={() => setDurationMonths(opt.months)}
              >
                <Text
                  style={[
                    styles.durationChipText,
                    durationMonths === opt.months && styles.durationChipTextActive,
                  ]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            style={[styles.monthlyButton, settingUpMonthly && styles.donateButtonDisabled]}
            onPress={handleSetupMonthly}
            disabled={settingUpMonthly}
            accessibilityLabel="Set up monthly donation"
          >
            <Text style={styles.monthlyButtonText}>
              {settingUpMonthly ? 'Scheduling...' : `📅 Set up ${amount || '1'} XLM / month`}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
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
    backgroundColor: '#227239',
  },
  donateButtonDisabled: {
    backgroundColor: '#8aaa8a',
  },
  donateButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  monthlyCard: {
    marginHorizontal: 16,
    marginBottom: 28,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1e7d1',
  },
  monthlyHint: {
    fontSize: 13,
    color: '#5a7a5a',
    lineHeight: 18,
    marginBottom: 12,
  },
  durationRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  durationChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#f0f7f0',
  },
  durationChipActive: {
    backgroundColor: '#227239',
  },
  durationChipText: {
    fontSize: 13,
    color: '#1f5136',
  },
  durationChipTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  monthlyButton: {
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#1a2e1a',
  },
  monthlyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
