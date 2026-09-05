const { wrapReport } = require('../utils/baseline');

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Prevent unresolvable relative imports and cross-package boundary violations",
      category: "Possible Errors",
      recommended: true
    },
    schema: [] // no options
  },
  create: function(context) {
    const originalReport = context.report;
    context.report = wrapReport(context, 'greenpay/no-cross-package-imports', originalReport);

    const filename = context.getFilename();
    const isFrontend = filename.includes('/frontend/');
    const isBackend = filename.includes('/backend/');
    const isMobile = filename.includes('/mobile/');
    const isExtension = filename.includes('/extension/');

    return {
      ImportDeclaration(node) {
        const importSource = node.source.value;
        
        // Allowed paths like @shared or relative paths inside the same package
        if (importSource.startsWith('@shared/')) {
          return;
        }

        // Detect cross-package boundaries by looking for relative path escalations
        if (importSource.includes('../backend/') || importSource.includes('../../backend/')) {
          if (!isBackend) {
            context.report({
              node,
              message: "Cross-package boundary violation: Cannot import backend module from outside backend."
            });
          }
        }

        if (importSource.includes('../frontend/') || importSource.includes('../../frontend/')) {
          if (!isFrontend) {
            context.report({
              node,
              message: "Cross-package boundary violation: Cannot import frontend module from outside frontend."
            });
          }
        }
        
        if (importSource.includes('../mobile/') || importSource.includes('../../mobile/')) {
          if (!isMobile) {
            context.report({
              node,
              message: "Cross-package boundary violation: Cannot import mobile module from outside mobile."
            });
          }
        }
      }
    };
  }
};
