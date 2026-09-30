import {
  BuildTask,
  type BuildContext,
  type BuiltTaskResult,
  type TaskHandler,
} from '@teambit/builder';
import type { EnvContext } from '@teambit/envs';
import { Logger } from '@teambit/logger';
import type { Component } from '@teambit/component';
import { CompositionsMain } from '@teambit/compositions';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { findUpSync } from 'find-up';

const esmRequire = createRequire(import.meta.url);

interface FigmaConfig {
  codeConnect: CodeConnectConfig;
  parser?: string;
}

interface CodeConnectConfig {
  include?: string[];
  exclude?: string[];
  importPaths?: ImportPaths;
  paths?: Paths;
}

interface ImportPaths {
  [key: string]: string;
}

interface Paths {
  [key: string]: string[];
}

const defaultConfigFile: FigmaConfig = {
  codeConnect: {
    include: ['*.{ts,tsx}'],
    exclude: ['test/**', 'docs/**', 'build/**', 'dist/**', 'node_modules/**'],
  },
};

export type CodeConnectOpts = {
  accessToken?: string;
};

export class CodeConnect implements BuildTask {
  constructor(
    readonly aspectId: string,
    readonly logger: Logger,
    readonly options: CodeConnectOpts,
    readonly compositions: CompositionsMain
  ) {}

  readonly name = 'CodeConnect';

  async execute(context: BuildContext): Promise<BuiltTaskResult> {
    this.logger.console('running code-connect task');

    context.capsuleNetwork.seedersCapsules.forEach(async (seederCapsule) => {
      this.logger.debug(`checking ${seederCapsule.path} for figma.config.json`);

      const configPath = join(seederCapsule.path, 'figma.config.json');

      if (!existsSync(configPath)) {
        this.logger.debug(
          `figma.config.json not found in ${seederCapsule.path}`
        );

        writeFileSync(
          configPath,
          JSON.stringify(
            this.applyCustomPaths(defaultConfigFile, seederCapsule.component),
            null,
            2
          )
        );
      } else {
        const currentConfig = esmRequire(configPath);
        writeFileSync(
          configPath,
          JSON.stringify(
            this.applyCustomPaths(currentConfig, seederCapsule.component),
            null,
            2
          )
        );
      }

      this.logger.debug(`found figma.config.json in ${seederCapsule.path}`);

      const codeConnectPath = esmRequire.resolve('@figma/code-connect');

      this.logger.debug(`code-connect path: ${codeConnectPath}`);

      const codeConnectPkgJson = findUpSync('package.json', {
        cwd: codeConnectPath,
        type: 'file',
      });

      if (!codeConnectPkgJson) {
        this.logger.debug(
          `code-connect package.json not found in ${codeConnectPath}`
        );
        return;
      }

      this.logger.debug(
        `code-connect package.json path: ${codeConnectPkgJson}`
      );

      const codeConnectBin = join(dirname(codeConnectPkgJson), 'bin', 'figma');

      const args = ['connect', 'publish'];

      if (this.options.accessToken) {
        args.push('--token', this.options.accessToken);
      }

      execFileSync(codeConnectBin, args, {
        cwd: seederCapsule.path,
        stdio: 'inherit',
        env: {
          ...process.env,
        },
      });
    });

    return {
      componentsResults: [],
      artifacts: [
        {
          name: 'figma-files',
          globPatterns: ['**/tmp/*.figma.tsx'],
        },
      ],
    };
  }

  /**
   * Apply custom importPaths to the component to convert `./index(.ts|tsx)` to the package import
   */
  private applyCustomPaths(
    currentConfig: FigmaConfig,
    component: Component
  ): FigmaConfig {
    const newConfig = { ...currentConfig };

    if (!newConfig.codeConnect.importPaths) {
      newConfig.codeConnect.importPaths = {};
    }

    const componentId = component.id.toObject();

    newConfig.codeConnect.importPaths['/*'] = component.getPackageName();

    this.logger.debug(
      JSON.stringify(newConfig),
      `updated figma.config.json with importPaths for ${componentId}`
    );

    return newConfig;
  }

  static from(options: CodeConnectOpts): TaskHandler {
    const name = this.name;
    const handler = (context: EnvContext) => {
      const envId = context.envId.toString();

      const logger = context.createLogger(`${envId}:${this.name}`);

      const aspect = context.getAspect<CompositionsMain>(
        'teambit.compositions/compositions'
      );

      return new CodeConnect(envId, logger, options, aspect);
    };
    return { name, handler };
  }
}
