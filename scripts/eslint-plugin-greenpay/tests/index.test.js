const { RuleTester } = require('eslint');
const noParsefloatNumeric = require('../lib/rules/no-parsefloat-numeric');
const noNestedEnvelope = require('../lib/rules/no-nested-envelope');
const noCrossPackageImports = require('../lib/rules/no-cross-package-imports');
const noUndeclaredReachable = require('../lib/rules/no-undeclared-reachable');

const tester = new RuleTester({ parserOptions: { ecmaVersion: 2021, sourceType: 'module' } });

// Tests for no-parsefloat-numeric
tester.run('no-parsefloat-numeric', noParsefloatNumeric, {
  valid: [
    { code: "const val = new BigNumber(amount);" },
    { code: "parseInt('123', 10);" },
    { code: "parseFloat(someRandomString);" }
  ],
  invalid: [
    {
      code: "const x = parseFloat(amount);",
      errors: [{ message: "Do not use parseFloat on monetary values. This causes precision loss. Use a BigNumber library or string-based decimal math." }]
    },
    {
      code: "const y = Number(row.total);",
      errors: [{ message: "Do not use Number on monetary values. This causes precision loss. Use a BigNumber library or string-based decimal math." }]
    }
  ]
});

// Tests for no-nested-envelope
tester.run('no-nested-envelope', noNestedEnvelope, {
  valid: [
    { code: "const data = res.data;" },
    { code: "const info = response.data;" }
  ],
  invalid: [
    {
      code: "const info = res.data.data;",
      errors: [{ message: "Unnecessary nested '.data.data' envelope read. The Axios interceptor already unwraps responses." }],
      output: "const info = res.data;"
    }
  ]
});

// Tests for no-cross-package-imports
tester.run('no-cross-package-imports', noCrossPackageImports, {
  valid: [
    { code: "import { foo } from '@shared/utils';", filename: "/home/user/repo/frontend/src/index.js" },
    { code: "import { bar } from './local';", filename: "/home/user/repo/frontend/src/index.js" }
  ],
  invalid: [
    {
      code: "import { db } from '../../backend/src/db';",
      filename: "/home/user/repo/frontend/src/index.js",
      errors: [{ message: "Cross-package boundary violation: Cannot import backend module from outside backend." }]
    }
  ]
});

console.log("All rule tests passed.");
