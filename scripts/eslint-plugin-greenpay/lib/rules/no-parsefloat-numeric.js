const { wrapReport } = require('../utils/baseline');

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Do not use parseFloat or Number() on numeric database columns or monetary values",
      category: "Possible Errors",
      recommended: true
    },
    schema: [] // no options
  },
  create: function(context) {
    // Override report for baseline suppression
    const originalReport = context.report;
    context.report = wrapReport(context, 'greenpay/no-parsefloat-numeric', originalReport);

    // List of identifiers that strongly suggest monetary/numeric origin from the DB
    const MONEY_VARS = ['amount', 'balance', 'total', 'xlm', 'usd', 'quantity'];

    return {
      CallExpression(node) {
        let isFlagged = false;
        
        if (node.callee.type === 'Identifier' && (node.callee.name === 'parseFloat' || node.callee.name === 'Number')) {
          if (node.arguments.length > 0 && node.arguments[0].type === 'Identifier') {
            const argName = node.arguments[0].name.toLowerCase();
            if (MONEY_VARS.some(v => argName.includes(v))) {
              isFlagged = true;
            }
          }
          // Also check member expressions (e.g. parseFloat(row.amount))
          if (node.arguments.length > 0 && node.arguments[0].type === 'MemberExpression') {
            const prop = node.arguments[0].property;
            if (prop.type === 'Identifier' && MONEY_VARS.some(v => prop.name.toLowerCase().includes(v))) {
              isFlagged = true;
            }
          }
        }

        if (isFlagged) {
          context.report({
            node,
            message: "Do not use {{callee}} on monetary values. This causes precision loss. Use a BigNumber library or string-based decimal math.",
            data: {
              callee: node.callee.name
            }
          });
        }
      }
    };
  }
};
