import { KernelMessage } from '@jupyterlab/services';

import { BaseKernel } from '@jupyterlite/kernel';
import { RbValue, RubyVM } from 'ruby-head-wasm-wasi';
import { DefaultRubyVM } from 'ruby-head-wasm-wasi/dist/browser';

/**
 * A kernel that interpret Ruby code.
 */
export class CRubyKernel extends BaseKernel {
  private _vmPromise: Promise<{ vm: RubyVM }> | null = null;
  async useVM(): Promise<{ vm: RubyVM }> {
    if (this._vmPromise) {
      return this._vmPromise;
    }
    this._vmPromise = (async () => {
      const response = await fetch(
        'https://cdn.jsdelivr.net/npm/ruby-head-wasm-wasi@0.3.0-2022-10-17-a/dist/ruby+stdlib.wasm'
      );
      const buffer = await response.arrayBuffer();
      const module = await WebAssembly.compile(buffer);
      return await DefaultRubyVM(module);
    })();
    return this._vmPromise;
  }

  /**
   * Handle a kernel_info_request message
   */
  async kernelInfoRequest(): Promise<KernelMessage.IInfoReplyMsg['content']> {
    const content: KernelMessage.IInfoReply = {
      implementation: 'Ruby',
      implementation_version: '0.1.0',
      language_info: {
        codemirror_mode: {
          name: 'ruby'
        },
        file_extension: '.rb',
        mimetype: 'text/ruby',
        name: 'ruby',
        nbconvert_exporter: 'ruby',
        pygments_lexer: 'ruby',
        version: 'es2017'
      },
      protocol_version: '5.3',
      status: 'ok',
      banner: 'A Ruby kernel running in the browser',
      help_links: [
        {
          text: 'About Ruby Kernel',
          url: 'https://github.com'
        }
      ]
    };
    return content;
  }

  /**
   * Handle an `execute_request` message
   *
   * @param msg The parent message.
   */
  async executeRequest(
    content: KernelMessage.IExecuteRequestMsg['content']
  ): Promise<KernelMessage.IExecuteReplyMsg['content']> {
    const { code } = content;
    try {
      const { vm } = await this.useVM();

      const result = vm.eval(code);
      this.publishExecuteResult({
        execution_count: this.executionCount,
        data: {
          'text/plain': result.toString()
        },
        metadata: {}
      });

      return {
        status: 'ok',
        execution_count: this.executionCount,
        user_expressions: {}
      };
    } catch (e) {
      const { name, stack, message } = e as any as Error;
      this.publishExecuteError({
        ename: name,
        evalue: message,
        traceback: [`${stack}`]
      });

      return {
        status: 'error',
        execution_count: this.executionCount,
        ename: name,
        evalue: message,
        traceback: [`${stack}`]
      };
    }
  }

  /**
   * Handle an complete_request message
   *
   * @param msg The parent message.
   */
  async completeRequest(
    content: KernelMessage.ICompleteRequestMsg['content']
  ): Promise<KernelMessage.ICompleteReplyMsg['content']> {
    const { vm } = await this.useVM();
    const completor = vm.eval(`
      require "irb/completion"
      main_bind = binding
      ->(input) { IRB::InputCompletor.retrieve_completion_data(input.to_s, bind: main_bind) }
    `);
    const { code, cursor_pos } = content;
    const lines = code.slice(0, cursor_pos).split('\n');
    const line = lines[lines.length - 1];
    const rbArrayToArray = (vm: RubyVM, value: RbValue) => {
      const length = value.call('length').toJS();
      const items: RbValue[] = [];
      for (let i = 0; i < length; i++) {
        const element = value.call('at', vm.eval(String(i)));
        items.push(element);
      }
      return items;
    };
    const items = rbArrayToArray(vm, completor.call('call', vm.wrap(line)));

    return {
      matches: items.map(item => item.toString()),
      cursor_start: cursor_pos - line.length,
      cursor_end: cursor_pos,
      metadata: {},
      status: 'ok'
    };
  }

  /**
   * Handle an `inspect_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async inspectRequest(
    content: KernelMessage.IInspectRequestMsg['content']
  ): Promise<KernelMessage.IInspectReplyMsg['content']> {
    throw new Error('Not implemented');
  }

  /**
   * Handle an `is_complete_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async isCompleteRequest(
    content: KernelMessage.IIsCompleteRequestMsg['content']
  ): Promise<KernelMessage.IIsCompleteReplyMsg['content']> {
    throw new Error('Not implemented');
  }

  /**
   * Handle a `comm_info_request` message.
   *
   * @param content - The content of the request.
   *
   * @returns A promise that resolves with the response message.
   */
  async commInfoRequest(
    content: KernelMessage.ICommInfoRequestMsg['content']
  ): Promise<KernelMessage.ICommInfoReplyMsg['content']> {
    throw new Error('Not implemented');
  }

  /**
   * Send an `input_reply` message.
   *
   * @param content - The content of the reply.
   */
  inputReply(content: KernelMessage.IInputReplyMsg['content']): void {
    throw new Error('Not implemented');
  }

  /**
   * Send an `comm_open` message.
   *
   * @param msg - The comm_open message.
   */
  async commOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Send an `comm_msg` message.
   *
   * @param msg - The comm_msg message.
   */
  async commMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Send an `comm_close` message.
   *
   * @param close - The comm_close message.
   */
  async commClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    throw new Error('Not implemented');
  }
}
