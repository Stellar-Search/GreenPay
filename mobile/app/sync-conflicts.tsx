/**
 * app/sync-conflicts.tsx
 * Offline donation queue — review and resolve donations that were saved
 * while the device had no connectivity (see hooks/useDonationSync.ts and
 * utils/donationQueue.ts).
 *
 * Secret keys are never stored here. "Complete now" simply routes back to
 * the normal donate screen for the same project so the user re-enters
 * their secret key and finishes signing like any other donation.
 */
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { useDonationSync } from '../hooks/useDonationSync';
import type { QueuedDonation } from '../utils/donationQueue';
import { parseAmountToStroops, formatStroopsToXLM, STROOPS_PER_XLM } from '../utils/amount';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function QueueCard({
  entry,
  onCompleteNow,
  onEditAmount,
  onChooseProject,
  onRemove,
}: {
  entry: QueuedDonation;
  onCompleteNow: (entry: QueuedDonation) => void;
  onEditAmount: (entry: QueuedDonation) => void;
  onChooseProject: () => void;
  onRemove: (entry: QueuedDonation) => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.projectName} numberOfLines={1}>
          {entry.projectName}
        </Text>
        <Text style={styles.amount}>{entry.amountXLM} XLM</Text>
      </View>
      <Text style={styles.savedAt}>Saved {formatDate(entry.createdAt)}</Text>

      {entry.status === 'pending-sync' && (
        <Text style={styles.pendingText}>
          Waiting to check for conflicts once you're back online...
        </Text>
      )}

      {entry.status === 'ready' && (
        <>
          <Text style={styles.readyText}>Ready to complete — no conflicts found.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => onCompleteNow(entry)}>
            <Text style={styles.primaryBtnText}>Complete now</Text>
          </TouchableOpacity>
        </>
      )}

      {entry.status === 'conflict' && entry.conflictReason === 'insufficient-balance' && (
        <>
          <Text style={styles.conflictText}>
            Not enough XLM to cover this donation. {entry.conflictDetail}
          </Text>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => onEditAmount(entry)}>
              <Text style={styles.secondaryBtnText}>Edit amount</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dangerBtn} onPress={() => onRemove(entry)}>
              <Text style={styles.dangerBtnText}>Remove</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {entry.status === 'conflict' && entry.conflictReason === 'project-inactive' && (
        <>
          <Text style={styles.conflictText}>
            {entry.conflictDetail || 'This project is no longer accepting donations.'}
          </Text>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={onChooseProject}>
              <Text style={styles.secondaryBtnText}>Choose a different project</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dangerBtn} onPress={() => onRemove(entry)}>
              <Text style={styles.dangerBtnText}>Remove</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {entry.status === 'conflict' && entry.conflictReason === 'duplicate' && (
        <>
          <Text style={styles.conflictText}>
            {entry.conflictDetail || 'A similar donation already exists in the queue.'}
          </Text>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => onEditAmount(entry)}>
              <Text style={styles.secondaryBtnText}>Edit amount</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.dangerBtn} onPress={() => onRemove(entry)}>
              <Text style={styles.dangerBtnText}>Remove</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {entry.status === 'completed' && (
        <Text style={styles.readyText}>
          This donation already went through — it will be removed from the queue.
        </Text>
      )}
    </View>
  );
}

export default function SyncConflictsScreen() {
  const router = useRouter();
  const { queue, refresh, syncNow, resolve } = useDonationSync();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      const runRefresh = async () => {
        await refresh();
        if (isActive) {
          setLoading(false);
        }
      };

      runRefresh();

      return () => {
        isActive = false;
      };
    }, [refresh])
  );

  const handlePullRefresh = async () => {
    setRefreshing(true);
    await syncNow();
    setRefreshing(false);
  };

  const handleCompleteNow = (entry: QueuedDonation) => {
    router.push(`/donate/${entry.projectId}?queueId=${entry.id}`);
  };

  const handleEditAmount = (entry: QueuedDonation) => {
    if (typeof (Alert as any).prompt !== 'function') {
      Alert.alert('Edit amount', 'Editing is not supported on this device — remove and re-add the donation instead.');
      return;
    }
    (Alert as any).prompt(
      'Edit amount',
      `Enter a new amount (XLM) for ${entry.projectName}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: async (value?: string) => {
            const trimmed = (value || '').trim();
            const parsedStroops = parseAmountToStroops(trimmed);
            const minStroops = STROOPS_PER_XLM;
            if (!trimmed || parsedStroops === null || parsedStroops < minStroops) {
              Alert.alert('Invalid amount', 'Please enter a valid amount (minimum 1 XLM).');
              return;
            }
            await resolve(entry.id, 'edit-amount', { amountXLM: formatStroopsToXLM(parsedStroops) });
          },
        },
      ],
      'plain-text',
      entry.amountXLM
    );
  };

  const handleRemove = (entry: QueuedDonation) => {
    Alert.alert(
      'Remove queued donation',
      `Remove the saved ${entry.amountXLM} XLM donation to ${entry.projectName}?`,
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => resolve(entry.id, 'remove') },
      ]
    );
  };

  const handleChooseProject = () => {
    router.push('/projects');
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#227239" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handlePullRefresh}
          tintColor="#227239"
          colors={['#227239']}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Donations Waiting to Sync</Text>
        <Text style={styles.headerSub}>
          Pull down to re-check for conflicts. Your secret key is never saved — you'll re-enter it
          to finish signing.
        </Text>
      </View>

      {queue.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>✅</Text>
          <Text style={styles.emptyTitle}>Nothing queued</Text>
          <Text style={styles.emptyText}>
            Donations saved while you're offline will show up here.
          </Text>
        </View>
      ) : (
        queue.map((entry) => (
          <QueueCard
            key={entry.id}
            entry={entry}
            onCompleteNow={handleCompleteNow}
            onEditAmount={handleEditAmount}
            onChooseProject={handleChooseProject}
            onRemove={handleRemove}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f0f7f0',
  },
  content: {
    paddingBottom: 32,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    backgroundColor: '#227239',
    padding: 24,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerSub: {
    fontSize: 13,
    color: '#c8e6c9',
    marginTop: 8,
    lineHeight: 18,
  },
  emptyState: {
    alignItems: 'center',
    padding: 40,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a2e1a',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#5a7a5a',
    textAlign: 'center',
    lineHeight: 20,
  },
  card: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  projectName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: '#1a2e1a',
    marginRight: 8,
  },
  amount: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#227239',
  },
  savedAt: {
    fontSize: 12,
    color: '#8aaa8a',
    marginTop: 4,
    marginBottom: 10,
  },
  pendingText: {
    fontSize: 13,
    color: '#5a7a5a',
    fontStyle: 'italic',
  },
  readyText: {
    fontSize: 13,
    color: '#227239',
    fontWeight: '600',
    marginBottom: 10,
  },
  conflictText: {
    fontSize: 13,
    color: '#c62828',
    marginBottom: 12,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  primaryBtn: {
    backgroundColor: '#227239',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  secondaryBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#227239',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#227239',
    fontWeight: '600',
    fontSize: 13,
  },
  dangerBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#c62828',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
  },
  dangerBtnText: {
    color: '#c62828',
    fontWeight: '600',
    fontSize: 13,
  },
});
