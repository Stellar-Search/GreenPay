/**
 * ESLint Plugin: GreenPay
 * Custom rules for the GreenPay codebase
 */

const noParsefloatNumeric = require('./lib/rules/no-parsefloat-numeric');
const noNestedEnvelope = require('./lib/rules/no-nested-envelope');
const noCrossPackageImports = require('./lib/rules/no-cross-package-imports');
const noUndeclaredReachable = require('./lib/rules/no-undeclared-reachable');

module.exports = {
  rules: {
    'no-parsefloat-numeric': noParsefloatNumeric,
    'no-nested-envelope': noNestedEnvelope,
    'no-cross-package-imports': noCrossPackageImports,
    'no-undeclared-reachable': noUndeclaredReachable,
  },
  configs: {
    recommended: {
      plugins: ['greenpay'],
      rules: {
        'greenpay/no-parsefloat-numeric': 'warn',
        'greenpay/no-nested-envelope': 'error',
        'greenpay/no-cross-package-imports': 'error',
        'greenpay/no-undeclared-reachable': 'error',
      },
    },
  },
};
