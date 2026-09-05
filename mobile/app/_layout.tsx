/**
 * app/_layout.tsx
 * Root layout for the mobile app using expo-router.
 *
 * Initialization order (fix for issue #32):
 *   AppInitProvider boots first → hydrates AsyncStorage state → sets
 *   isHydrated = true → AppInitContext flushes any queued deep-link URL →
 *   useDeepLink navigates.  Navigation never fires before state is ready.
 */
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useFonts, Lora_700Bold } from '@expo-google-fonts/lora';
import { useColorScheme } from 'react-native';
import { ThemeProvider, themes } from './theme';
import { useDeepLink } from '../hooks/useDeepLink';
import { useRecurringReminders } from '../hooks/useRecurringReminders';
import { AppInitProvider, useAppInit } from '../src/context/AppInitContext';
import { assertStellarNetworkConfigConsistency } from '../utils/stellarNetwork';
import { initCrashReporter } from '../utils/crashReporter';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';

SplashScreen.preventAutoHideAsync();
import { useWallet } from '../src/hooks/useWallet';
import { useDeviceIntegrity } from '../utils/useDeviceIntegrity';
import { SecurityWarningBanner } from '../components/SecurityWarningBanner';

function DeepLinkHandler() {
  useDeepLink();
  useRecurringReminders();
  return null;
}

function AppShell() {
  const colorScheme = useColorScheme();
  const themeMode = colorScheme === 'dark' ? 'dark' : 'light';
  const theme = themes[themeMode];
  const { publicKey } = useWallet();
  const { isCompromised } = useDeviceIntegrity();

  const { isHydrated } = useAppInit();
  const [fontsLoaded, fontError] = useFonts({
    Lora_700Bold,
  });

  // Initialise crash reporting before any navigation or wallet hooks execute.
  // Wrapped in try/catch so a bad config can never propagate as a boot crash
  // (Requirement 5.6). dryRun is true in dev and preview builds (Req 5.7).
  useEffect(() => {
    try {
      initCrashReporter({
        dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? '',
        updateId: Updates.updateId ?? null,
        runtimeVersion: Updates.runtimeVersion ?? null,
        dryRun:
          __DEV__ ||
          Constants.expoConfig?.extra?.buildProfile === 'preview',
      });
    } catch (err) {
      console.error('[AppShell] initCrashReporter failed:', err);
    }
  }, []);

  useEffect(() => {
    // Fail fast if Horizon URL and STELLAR_NETWORK disagree (issue #145).
    assertStellarNetworkConfigConsistency();
  }, []);

  useEffect(() => {
    if ((fontsLoaded || fontError) && isHydrated) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError, isHydrated]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ThemeProvider>
      {/* DeepLinkHandler is inside AppInitProvider so useAppInit() resolves */}
      <DeepLinkHandler />
      <StatusBar style={theme.statusBarStyle} />
      {/*
        Advisory-only warning, shown app-wide once a wallet is connected on a
        device that looks jailbroken/rooted. Never blocks interaction — see
        components/SecurityWarningBanner for rationale.
      */}
      {isCompromised && publicKey && <SecurityWarningBanner />}
      <Stack screenOptions={{
        headerStyle: { backgroundColor: theme.header },
        headerTintColor: theme.headerText,
        headerTitleStyle: { fontFamily: 'Lora_700Bold' },
      }}>
        <Stack.Screen name="index" options={{ title: 'Home' }} />
        <Stack.Screen name="projects" options={{ title: 'Projects' }} />
        <Stack.Screen name="projects/[id]" options={{ title: 'Project Details' }} />
        <Stack.Screen name="donate/[id]" options={{ title: 'Donate' }} />
        <Stack.Screen name="scan" options={{ title: 'Scan QR Code', headerShown: false }} />
        <Stack.Screen name="impact" options={{ title: 'My Impact' }} />
        <Stack.Screen name="profile/[address]" options={{ title: 'Donor Profile' }} />
        <Stack.Screen name="leaderboard" options={{ title: 'Leaderboard' }} />
        <Stack.Screen name="recurring" options={{ title: 'Monthly Giving' }} />
        <Stack.Screen name="sync-conflicts" options={{ title: 'Sync Donations' }} />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <AppInitProvider>
      <AppShell />
    </AppInitProvider>
  );
}
