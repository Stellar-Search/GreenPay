/**
 * Manual Jest mock for @sentry/react-native.
 * Keeps tests free of native module dependencies.
 */
const Sentry = {
  init: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
};

module.exports = Sentry;
module.exports.default = Sentry;
