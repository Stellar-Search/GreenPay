module.exports = {
  rules: {
    "no-parsefloat-numeric": {
      create: function (context) {
        return {
          CallExpression(node) {
            if (
              node.callee.type === "Identifier" &&
              node.callee.name === "parseFloat"
            ) {
              context.report({
                node,
                message:
                  "Do not use parseFloat on NUMERIC database columns. This causes precision loss. Use a BigNumber library or string-based decimal math.",
              });
            }
          },
        };
      },
    },
  },
};
