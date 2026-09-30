import type { ViteConfigTransformer } from '@teambit/vite.utils.merge-transformers';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

export const figmaConnectViteTransformer: ViteConfigTransformer = async (config) => {
  const aliasEntry = {
    find: "@figma/code-connect",
    replacement: esmRequire.resolve("./mock-figma-connect.cjs"),
  };

  if (config.resolve?.alias) {
    if (Array.isArray(config.resolve.alias)) {
      // Append to alias array if it is an array
      config.resolve.alias.push(aliasEntry);
    } else if (typeof config.resolve.alias === "object") {
      // Merge with alias object if it is a record
      config.resolve.alias = {
        ...config.resolve.alias,
        [aliasEntry.find]: aliasEntry.replacement,
      };
    }
  } else {
    // Initialize resolve.alias with the alias entry
    config = {
      ...config,
      resolve: {
        alias: [aliasEntry],
      },
    };
  }

  return config;
}     
