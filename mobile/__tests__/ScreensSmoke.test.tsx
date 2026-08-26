import React from 'react';
import { render } from '@testing-library/react-native';
import { ThemeProvider } from '../app/theme';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: '123', address: 'G123' }),
  Stack: {
    Screen: () => null
  }
}));

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn()
}));

import ProjectsScreen from '../app/projects/index';
import ProjectDetailScreen from '../app/projects/[id]';
import ImpactScreen from '../app/impact';
import ProfileScreen from '../app/profile/[address]';
import LeaderboardScreen from '../app/leaderboard';
import SyncConflictsScreen from '../app/sync-conflicts';

describe('Screens Smoke Tests', () => {
  const renderScreen = (Component: React.ComponentType) => 
    render(<ThemeProvider><Component /></ThemeProvider>);

  it('renders projects screen', () => {
    expect(() => renderScreen(ProjectsScreen)).not.toThrow();
  });

  it('renders project detail screen', () => {
    expect(() => renderScreen(ProjectDetailScreen)).not.toThrow();
  });

  it('renders impact screen', () => {
    expect(() => renderScreen(ImpactScreen)).not.toThrow();
  });

  it('renders profile screen', () => {
    expect(() => renderScreen(ProfileScreen)).not.toThrow();
  });

  it('renders leaderboard screen', () => {
    expect(() => renderScreen(LeaderboardScreen)).not.toThrow();
  });

  it('renders sync conflicts screen', () => {
    expect(() => renderScreen(SyncConflictsScreen)).not.toThrow();
  });
});
