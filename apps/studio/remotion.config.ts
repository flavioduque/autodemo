import { Config } from "@remotion/cli/config";

/**
 * The workspace compiles with `moduleResolution: "nodenext"`, which requires
 * relative imports to carry an explicit `.js` extension. The Remotion bundler
 * resolves modules like a bundler and does not apply that mapping by default,
 * so it is declared here.
 */
Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"]
    }
  }
}));
