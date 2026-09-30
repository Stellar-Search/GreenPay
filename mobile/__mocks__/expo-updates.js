/**
 * Manual Jest mock for expo-updates.
 */
module.exports = {
  updateId: 'mock-update-id',
  runtimeVersion: 'mock-runtime-version',
  isEmbeddedLaunch: true,
  channel: 'production',
  checkForUpdateAsync: jest.fn().mockResolvedValue({ isAvailable: false }),
  fetchUpdateAsync: jest.fn().mockResolvedValue({}),
  reloadAsync: jest.fn().mockResolvedValue(undefined),
};
