import type { WebpackConfigMutator } from '@teambit/webpack';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * modifies the webpack config for the components preview bundle.
 * @see https://bit.dev/reference/webpack/webpack-config
 */
export const figmaConnectTransformer = (
  configMutator: WebpackConfigMutator
): WebpackConfigMutator => {
  return configMutator.merge({
    resolve: {
      alias: {
        '@figma/code-connect': require.resolve('./mock-figma-connect.cjs'),
      },
    },
  });
};
