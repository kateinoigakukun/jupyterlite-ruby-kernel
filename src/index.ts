// Copyright (c) JupyterLite Contributors
// Distributed under the terms of the Modified BSD License.

import {
  JupyterLiteServer,
  JupyterLiteServerPlugin
} from '@jupyterlite/server';

import { IKernel, IKernelSpecs } from '@jupyterlite/kernel';

import { CRubyKernel } from './kernel';

import logo32 from '../style/logos/ruby-logo-32x32.png';
import logo64 from '../style/logos/ruby-logo-64x64.png';

/**
 * A plugin to register the Ruby kernel.
 */
const kernel: JupyterLiteServerPlugin<void> = {
  id: '@jupyterlite/ruby-kernel:kernel',
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (app: JupyterLiteServer, kernelspecs: IKernelSpecs) => {
    kernelspecs.register({
      spec: {
        name: 'ruby',
        display_name: 'Ruby',
        language: 'ruby',
        argv: [],
        resources: {
          'logo-32x32': logo32,
          'logo-64x64': logo64
        }
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        return new CRubyKernel(options);
      }
    });
  }
};

const plugins: JupyterLiteServerPlugin<any>[] = [kernel];

export default plugins;
