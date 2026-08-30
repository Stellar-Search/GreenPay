/**
 * src/components/FirstDonationPaths.tsx
 *
 * The mobile graduated-onboarding flow: the choice a donor without an account
 * is offered, the disclosure they must accept, and the sponsored setup itself.
 *
 * The sequence is not rearrangeable:
 *
 *   1. Show the trade-offs. Nothing exists yet, so declining costs nothing.
 *   2. Generate the keypair on the device, into the platform keychain.
 *   3. Ask the backend to sponsor. It returns a transaction the sponsor has
 *      already signed and that cannot be submitted without the donor's.
 *   4. Sign it here and send it back.
 *   5. Offer the key for export, prominently, before anything else.
 *
 * Step 3's transaction is what makes this non-custodial structurally rather
 * than by promise: its closing operation is sourced by the donor, so the
 * platform physically cannot create an account it controls.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  STARTER_ACCOUNT_TRADEOFFS,
  createStarterAccount,
  loadStarterAccount,
  markExported,
  signWithStarterAccount,
  type StarterAccount,
} from '../../utils/starterAccount';
import {
  abandonSponsorship,
  assessDonorSituation,
  fetchOnboardingPaths,
  requestSponsorship,
  submitSponsorship,
  type DonorSituation,
  type OnboardingPathId,
  type OnboardingPathOption,
} from '../../utils/onboarding';
import { getSessionId, track } from '../../utils/funnel';

type View_ = 'choosing' | 'disclosure' | 'working' | 'ready' | 'error';

interface FirstDonationPathsProps {
  projectId?: string;
  onAccountReady: (publicKey: string) => void;
  onUseExistingWallet?: () => void;
}

export function FirstDonationPaths({
  projectId,
  onAccountReady,
  onUseExistingWallet,
}: FirstDonationPathsProps) {
  const [view, setView] = useState<View_>('choosing');
  const [options, setOptions] = useState<OnboardingPathOption[] | null>(null);
  const [guarantee, setGuarantee] = useState<string | null>(null);
  const [situation, setSituation] = useState<DonorSituation | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [account, setAccount] = useState<StarterAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);
  const [progress, setProgress] = useState('');

  // A ref, not state: the unmount cleanup below has to read the *current*
  // value, which a state variable captured at render time would not give it.
  const pendingSponsorshipId = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void getSessionId({ projectId }).then((id) => mounted && setSessionId(id));
    void track('donate_intent', { projectId });

    fetchOnboardingPaths()
      .then((res) => {
        if (!mounted) return;
        setOptions(res.paths);
        setGuarantee(res.guarantee);
        void track('path_offered', { projectId });
      })
      // A failed fetch must not blank the screen: the donor can still use a
      // wallet they already have, and the fallback below keeps that reachable.
      .catch(() => mounted && setOptions([]));

    void loadStarterAccount().then((starter) => {
      if (!mounted) return;
      setAccount(starter);
      void assessDonorSituation({ address: starter?.publicKey ?? null }).then(
        (result) => mounted && setSituation(result),
      );
    });

    return () => {
      mounted = false;
    };
  }, [projectId]);

  /**
   * Releasing the reserved capacity on unmount is what makes "walking away
   * leaves no partial state" immediate. The server sweeps expired offers
   * regardless, so this is a courtesy, never the only guarantee.
   */
  useEffect(
    () => () => {
      if (pendingSponsorshipId.current) {
        void abandonSponsorship(pendingSponsorshipId.current);
        pendingSponsorshipId.current = null;
      }
    },
    [],
  );

  const choose = useCallback(
    (path: OnboardingPathId) => {
      void track('path_selected', { path, projectId });
      if (path === 'connected_wallet') {
        onUseExistingWallet?.();
        return;
      }
      setView('disclosure');
    },
    [onUseExistingWallet, projectId],
  );

  const runSetup = useCallback(async () => {
    setError(null);
    setView('working');
    void track('tradeoff_acknowledged', { path: 'sponsored_account', projectId });

    let created: StarterAccount;
    try {
      setProgress('Creating your key on this device…');
      // An existing key is reused rather than replaced: overwriting it would
      // destroy the only copy of a key that may already hold XLM.
      created = (await loadStarterAccount()) ?? (await createStarterAccount(true));
      setAccount(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a key on this device.');
      setView('error');
      return;
    }

    try {
      const offer = await requestSponsorship({
        publicKey: created.publicKey,
        sessionId: sessionId ?? '',
      });
      pendingSponsorshipId.current = offer.id;

      setProgress('Signing with your key…');
      const signedXdr = await signWithStarterAccount(offer.xdr, offer.networkPassphrase);

      setProgress('Setting up your account on Stellar…');
      await submitSponsorship(offer.id, signedXdr);
      // Submitted: there is no capacity left to release, so the unmount
      // cleanup must not try to abandon it.
      pendingSponsorshipId.current = null;

      void track('account_ready', { path: 'sponsored_account', projectId });
      setView('ready');
    } catch (err) {
      if (pendingSponsorshipId.current) {
        void abandonSponsorship(pendingSponsorshipId.current);
        pendingSponsorshipId.current = null;
      }
      setError(
        err instanceof Error
          ? err.message
          : 'Your account could not be set up. Nothing was created.',
      );
      setView('error');
    }
  }, [projectId, sessionId]);

  /**
   * Reveals the key and records that the donor has seen it.
   *
   * No clipboard call: adding a clipboard dependency to put a Stellar secret
   * on the system pasteboard is a poor trade — the pasteboard is readable by
   * other apps and, on iOS, syncs across devices via Handoff. The key is
   * rendered as selectable text instead, so the donor copies it deliberately
   * with the OS's own selection, or types it into a password manager.
   */
  const revealSecret = useCallback(async () => {
    if (!account) return;
    setSecretVisible(true);
    setCopied(true);
    await markExported();
  }, [account]);

  if (view === 'disclosure') {
    return (
      <ScrollView style={styles.container} testID="mobile-tradeoff-notice">
        <Text style={styles.title}>{STARTER_ACCOUNT_TRADEOFFS.title}</Text>
        <Text style={styles.subtitle}>
          Read this before you continue. Some of it cannot be undone later.
        </Text>

        <View style={styles.costBox}>
          <Text style={styles.costLabel}>GreenPay locks 1.0000000 XLM</Text>
          <Text style={styles.costNote}>
            Stellar requires a minimum balance before an account can exist. GreenPay puts that up so
            you don’t have to, and gets it back when the sponsorship ends. It is not a gift, and it
            is not yours to spend.
          </Text>
        </View>

        {/* Give-ups first: benefits first with caveats below is exactly how a
            donor ends up surprised later. */}
        <Text style={styles.sectionHeadingWarn}>What you are giving up</Text>
        {STARTER_ACCOUNT_TRADEOFFS.giveUp.map((line) => (
          <Text key={line} style={styles.bulletWarn} testID="mobile-tradeoff-giveup">
            ! {line}
          </Text>
        ))}

        <Text style={styles.sectionHeading}>What you keep</Text>
        {STARTER_ACCOUNT_TRADEOFFS.keep.map((line) => (
          <Text key={line} style={styles.bullet}>
            ✓ {line}
          </Text>
        ))}

        <Text style={styles.sectionHeading}>What you can do about it</Text>
        {STARTER_ACCOUNT_TRADEOFFS.mitigation.map((line) => (
          <Text key={line} style={styles.bullet}>
            {line}
          </Text>
        ))}

        <View style={styles.ackRow}>
          <Switch
            value={acknowledged}
            onValueChange={setAcknowledged}
            testID="mobile-tradeoff-acknowledge"
          />
          <Text style={styles.ackText}>
            I understand that GreenPay cannot recover my key, and that losing it means losing access
            to this account.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, !acknowledged && styles.disabled]}
          disabled={!acknowledged}
          onPress={runSetup}
          testID="mobile-tradeoff-continue"
        >
          <Text style={styles.primaryButtonText}>Set up my account</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setView('choosing')} testID="mobile-tradeoff-cancel">
          <Text style={styles.linkText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (view === 'working') {
    return (
      <View style={styles.centered} testID="mobile-starter-progress">
        <ActivityIndicator size="small" color="#22c55e" />
        <Text style={styles.subtitle}>{progress}</Text>
        <Text style={styles.note}>Your key is generated here and never sent anywhere.</Text>
      </View>
    );
  }

  if (view === 'error') {
    return (
      <View style={styles.container} testID="mobile-starter-error">
        <Text style={styles.errorTitle}>We couldn’t set up your account</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={runSetup}>
          <Text style={styles.primaryButtonText}>Try again</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setView('choosing')}>
          <Text style={styles.linkText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (view === 'ready' && account) {
    return (
      <ScrollView style={styles.container} testID="mobile-starter-ready">
        <Text style={styles.title}>Your account is ready</Text>
        <Text style={styles.subtitle}>
          You own it. GreenPay covered the minimum balance Stellar requires, and holds nothing else.
        </Text>

        <View style={styles.addressBox}>
          <Text style={styles.addressLabel}>Your address</Text>
          <Text style={styles.address}>{account.publicKey}</Text>
        </View>

        <View style={styles.warnBox}>
          <Text style={styles.warnTitle}>Save your key now</Text>
          <Text style={styles.warnText}>
            This is the only copy, and it lives on this device alone. GreenPay does not have it and
            cannot recover it for you. It works in any Stellar wallet.
          </Text>

          {secretVisible ? (
            <>
              <Text style={styles.secret} testID="mobile-starter-secret" selectable>
                {account.secret}
              </Text>
              <Text style={styles.warnText}>
                {copied
                  ? 'Press and hold to select it, then save it in a password manager.'
                  : ''}
              </Text>
            </>
          ) : (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={revealSecret}
              testID="mobile-starter-reveal"
            >
              <Text style={styles.secondaryButtonText}>Show my key</Text>
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => onAccountReady(account.publicKey)}
          testID="mobile-starter-continue"
        >
          <Text style={styles.primaryButtonText}>Continue to donate</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  const recommended = situation?.recommendedPath;
  const available = (options ?? []).filter((option) => option.id !== 'claimable_balance');

  return (
    <ScrollView style={styles.container} testID="mobile-first-donation-paths">
      <Text style={styles.title}>How would you like to donate?</Text>

      {situation && (
        <Text style={styles.subtitle} testID="mobile-donor-situation">
          {situation.reason}
        </Text>
      )}

      {available.length === 0 && (
        <Text style={styles.subtitle}>Enter a Stellar address to donate.</Text>
      )}

      {available.map((option) => {
        const isRecommended = option.id === recommended;
        return (
          <TouchableOpacity
            key={option.id}
            testID={`mobile-path-${option.id}`}
            disabled={!option.available}
            onPress={() => choose(option.id)}
            style={[
              styles.pathCard,
              isRecommended && styles.pathCardRecommended,
              !option.available && styles.disabled,
            ]}
          >
            <View style={styles.pathHeader}>
              <Text style={styles.pathTitle}>{option.title}</Text>
              {isRecommended && option.available && (
                <Text style={styles.badge}>Suggested</Text>
              )}
            </View>

            {option.available ? (
              <>
                {option.requires && option.requires.length > 0 && (
                  <Text style={styles.pathMeta}>Needs: {option.requires.join(' · ')}</Text>
                )}
                {/* The headline cost on the choice itself: a donor should not
                    have to open a path to find out what it costs them. */}
                {option.tradeoffs.giveUp.length > 0 && (
                  <Text style={styles.pathWarn}>{option.tradeoffs.giveUp[0]}</Text>
                )}
                {option.limits && (
                  <Text style={styles.pathMeta}>
                    Up to {option.limits.maxDonationXlm} XLM per donation.
                  </Text>
                )}
              </>
            ) : (
              <Text style={styles.pathMeta}>{option.unavailableReason}</Text>
            )}
          </TouchableOpacity>
        );
      })}

      {guarantee && (
        <Text style={styles.note} testID="mobile-onboarding-guarantee">
          {guarantee}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#fff' },
  centered: { padding: 32, alignItems: 'center', backgroundColor: '#fff' },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 6, color: '#14532d' },
  subtitle: { color: '#4b654b', marginBottom: 14, fontSize: 14, lineHeight: 20 },
  note: { color: '#547454', fontSize: 12, marginTop: 12, lineHeight: 18 },
  sectionHeading: { fontSize: 14, fontWeight: '700', color: '#166534', marginTop: 14, marginBottom: 6 },
  sectionHeadingWarn: { fontSize: 14, fontWeight: '700', color: '#92400e', marginTop: 6, marginBottom: 6 },
  bullet: { color: '#4b654b', fontSize: 13, lineHeight: 19, marginBottom: 6 },
  bulletWarn: { color: '#92400e', fontSize: 13, lineHeight: 19, marginBottom: 6 },
  costBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    marginBottom: 12,
  },
  costLabel: { fontWeight: '700', color: '#14532d', marginBottom: 4 },
  costNote: { color: '#4b654b', fontSize: 12, lineHeight: 18 },
  ackRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 16, marginBottom: 14 },
  ackText: { flex: 1, color: '#4b654b', fontSize: 13, lineHeight: 19 },
  primaryButton: {
    backgroundColor: '#22c55e',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#d97706',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  secondaryButtonText: { color: '#92400e', fontWeight: '600', fontSize: 14 },
  linkText: { color: '#16a34a', textAlign: 'center', paddingVertical: 10, fontSize: 14 },
  disabled: { opacity: 0.5 },
  pathCard: {
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  pathCardRecommended: { borderColor: '#22c55e', backgroundColor: '#f0fdf4' },
  pathHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  pathTitle: { flex: 1, fontWeight: '700', color: '#14532d', fontSize: 14 },
  badge: {
    fontSize: 11,
    color: '#fff',
    backgroundColor: '#22c55e',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
  },
  pathMeta: { color: '#547454', fontSize: 12, marginTop: 4 },
  pathWarn: { color: '#b45309', fontSize: 12, marginTop: 4 },
  addressBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    marginBottom: 12,
  },
  addressLabel: { fontSize: 11, fontWeight: '700', color: '#166534', marginBottom: 4 },
  address: { fontFamily: 'monospace', fontSize: 11, color: '#14532d' },
  warnBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    marginBottom: 14,
  },
  warnTitle: { fontWeight: '700', color: '#92400e', marginBottom: 4 },
  warnText: { color: '#92400e', fontSize: 12, lineHeight: 18 },
  secret: { fontFamily: 'monospace', fontSize: 11, color: '#92400e', marginTop: 8 },
  errorTitle: { fontSize: 16, fontWeight: '700', color: '#b91c1c', marginBottom: 6 },
  errorText: { color: '#b91c1c', fontSize: 13, marginBottom: 14, lineHeight: 19 },
});
