const { wrapReport } = require('../utils/baseline');

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Do not read nested 'data' objects when the Axios interceptor has already unwrapped them",
      category: "Possible Errors",
      recommended: true
    },
    fixable: "code",
    schema: [] // no options
  },
  create: function(context) {
    const originalReport = context.report;
    context.report = wrapReport(context, 'greenpay/no-nested-envelope', originalReport);

    return {
      MemberExpression(node) {
        // Look for res.data.data or response.data.data
        if (
          node.property.type === 'Identifier' &&
          node.property.name === 'data' &&
          node.object.type === 'MemberExpression' &&
          node.object.property.type === 'Identifier' &&
          node.object.property.name === 'data'
        ) {
          // Check if root object is res or response
          if (node.object.object.type === 'Identifier' && (node.object.object.name === 'res' || node.object.object.name === 'response')) {
            context.report({
              node,
              message: "Unnecessary nested '.data.data' envelope read. The Axios interceptor already unwraps responses.",
              fix: function(fixer) {
                // Replace `res.data.data` with `res.data`
                return fixer.replaceText(node, `${node.object.object.name}.data`);
              }
            });
          }
        }
      }
    };
  }
};
