import { ReactEnv } from '@bitdev/react.react-env';
import { ReactVitePreview } from '@bitdev/react.preview.react-vite-preview';
import { EnvHandler } from '@teambit/envs';
import { Pipeline } from '@teambit/builder';
import { Preview } from '@teambit/preview';
import {
  CodeConnect,
  figmaConnectViteTransformer,
} from '@bitdesign/figma.code-connect';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import hostDependencies from './preview/host-dependencies.js';

const require = createRequire(import.meta.url);

export class FigmaEnv extends ReactEnv {
  /**
   * name of the environment. used for friendly mentions across bit.
   */
  name = 'figma-env';

  /**
   * create an instance for Bit Preview.
   */
  preview(): EnvHandler<Preview> {
    return ReactVitePreview.from({
      // docsTemplate: require.resolve('./preview/docs.js'),
      mounter: require.resolve('./preview/mounter.js'),
      hostDependencies,
      transformers: [
        figmaConnectViteTransformer   
      ]
    });
  }

  snap(): Pipeline {
    return Pipeline.from([CodeConnect.from({})]);
  }

  tag(): Pipeline {
    return Pipeline.from([CodeConnect.from({})]);
  }

  protected tsTypesPath = './types';

  protected dirName = dirname(fileURLToPath(import.meta.url));
}

export default new FigmaEnv();
