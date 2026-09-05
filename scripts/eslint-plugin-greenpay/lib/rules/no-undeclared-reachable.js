const { wrapReport } = require('../utils/baseline');

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Flag identifiers used in reachable code but never imported or defined",
      category: "Possible Errors",
      recommended: true
    },
    schema: [] // no options
  },
  create: function(context) {
    const originalReport = context.report;
    context.report = wrapReport(context, 'greenpay/no-undeclared-reachable', originalReport);

    // Globals allowed in the environments
    const ALLOWED_GLOBALS = new Set([
      'console', 'process', 'require', 'module', 'exports', 'window', 'document', 'setTimeout', 'clearTimeout',
      'Promise', 'Error', 'Buffer', 'Array', 'Object', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Date',
      'fetch', 'describe', 'it', 'beforeEach', 'afterEach', 'expect', 'jest', '__dirname', 'global', 'localStorage'
    ]);

    return {
      Identifier(node) {
        // We only care about variables being read
        // Check if it's part of a declaration, assignment, property of an object, etc.
        const parent = node.parent;
        
        // Ignore properties like obj.foo
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
          return;
        }

        // Ignore object keys like { foo: 1 }
        if (parent.type === 'Property' && parent.key === node) {
          return;
        }
        
        // Ignore variable declarations, function parameters
        if (parent.type === 'VariableDeclarator' && parent.id === node) return;
        if (parent.type === 'FunctionDeclaration' && (parent.id === node || parent.params.includes(node))) return;
        if (parent.type === 'ArrowFunctionExpression' && parent.params.includes(node)) return;

        // Try to resolve in the ESLint scope
        const scope = context.getScope();
        
        // check if it's declared in current or any upper scope
        let currentScope = scope;
        let isDefined = false;
        
        while (currentScope) {
          if (currentScope.set.has(node.name)) {
            isDefined = true;
            break;
          }
          currentScope = currentScope.upper;
        }
        
        if (!isDefined && !ALLOWED_GLOBALS.has(node.name)) {
          context.report({
            node,
            message: "'{{name}}' is used but never imported or defined.",
            data: {
              name: node.name
            }
          });
        }
      }
    };
  }
};
