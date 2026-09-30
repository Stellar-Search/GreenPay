"use strict";
const path = require("path");
module.exports = {
  testRunner: "jest-circus/runner",
  setupFiles: [path.join(__dirname, "jest.setup.env.js")],
};
