import { KernelMessage } from '@jupyterlab/services';

import { BaseKernel } from '@jupyterlite/kernel';
import { RbValue, RubyVM } from 'ruby-head-wasm-wasi';
import { WASI } from '@wasmer/wasi';
import { WasmFs } from '@wasmer/wasmfs';
// @ts-ignore
import * as path from 'path-browserify';

interface IOWriter {
  write(line: string, type: 'stdout' | 'stderr'): void;
}

class ConsoleWriter implements IOWriter {
  write(line: string, type: 'stdout' | 'stderr') {
    if (type === 'stdout') {
      console.log(line);
    } else {
      console.error(line);
    }
  }
}

/**
 * A kernel that interpret Ruby code.
 */
export class CRubyKernel extends BaseKernel {
  private _vmPromise: Promise<{ vm: RubyVM; mainBind: RbValue }> | null = null;
  private _ioWriter: IOWriter = new ConsoleWriter();

  async useVM(): Promise<{ vm: RubyVM; mainBind: RbValue }> {
    if (this._vmPromise) {
      return this._vmPromise;
    }
    this._vmPromise = (async () => {
      const wasmFs = new WasmFs();

      const originalWriteSync = wasmFs.fs.writeSync.bind(wasmFs.fs);
      const stdOutErrBuffers: { [key: number]: string } = { 1: '', 2: '' };
      const self = this;
      wasmFs.fs.writeSync = function (...args: any[]) {
        const fd: number = args[0];
        let text;
        if (args.length === 4) {
          text = args[1];
        } else {
          const buffer = args[1] as Uint8Array;
          text = new TextDecoder('utf-8').decode(buffer);
        }
        const handlers: { [key: number]: (text: string) => void } = {
          1: (line: string) => self._ioWriter.write(line, 'stdout'),
          2: (line: string) => self._ioWriter.write(line, 'stderr')
        };
        if (handlers[fd]) {
          text = stdOutErrBuffers[fd] + text;
          const i = text.lastIndexOf('\n');
          if (i >= 0) {
            handlers[fd](text.substring(0, i + 1));
            text = text.substring(i + 1);
          }
          stdOutErrBuffers[fd] = text;
        }
        // @ts-ignore
        return originalWriteSync(...args);
      };

      const args = ['ruby.wasm', '-e_=0', '-I/gems/lib'];

      const vm = new RubyVM();
      Error.stackTraceLimit = Infinity;
      wasmFs.fs.mkdirSync('/home/me', { mode: 0o777, recursive: true });
      wasmFs.fs.mkdirSync('/home/me/.gem/specs', {
        mode: 0o777,
        recursive: true
      });
      wasmFs.fs.writeFileSync('/dev/null', new Uint8Array(0));
      wasmFs.fs.mkdirSync('/gems/lib', { mode: 0o777, recursive: true });
      wasmFs.fs.writeFileSync('/gems/lib/socket.rb', new Uint8Array(0));
      const wasi = new WASI({
        args,
        env: {
          GEM_PATH: '/gems:/home/me/.gem/ruby/3.2.0+2',
          GEM_SPEC_CACHE: '/home/me/.gem/specs',
          RUBY_FIBER_MACHINE_STACK_SIZE: String(1024 * 1024 * 20)
        },
        preopens: {
          '/home': '/home',
          '/dev': '/dev',
          '/gems': '/gems'
        },
        bindings: {
          ...WASI.defaultBindings,
          fs: wasmFs.fs,
          path: path
        }
      });

      const wrapWASI = (wasiObject: any) => {
        // PATCH: @wasmer-js/wasi@0.x forgets to call `refreshMemory` in `clock_res_get`,
        // which writes its result to memory view. Without the refresh the memory view,
        // it accesses a detached array buffer if the memory is grown by malloc.
        // But they wasmer team discarded the 0.x codebase at all and replaced it with
        // a new implementation written in Rust. The new version 1.x is really unstable
        // and not production-ready as far as katei investigated in Apr 2022.
        // So override the broken implementation of `clock_res_get` here instead of
        // fixing the wasi polyfill.
        // Reference: https://github.com/wasmerio/wasmer-js/blob/55fa8c17c56348c312a8bd23c69054b1aa633891/packages/wasi/src/index.ts#L557
        const original_clock_res_get = wasiObject.wasiImport['clock_res_get'];
        wasiObject.wasiImport['clock_res_get'] = function (...args: any[]) {
          wasiObject.refreshMemory();
          return original_clock_res_get(...args);
        };
        wasiObject.wasiImport['fd_fdstat_set_flags'] = function () {
          return 0;
        };
        return wasiObject.wasiImport;
      };

      const imports = {
        wasi_snapshot_preview1: wrapWASI(wasi)
      };
      vm.addToImports(imports);
      const response = await fetch(
        'https://cdn.jsdelivr.net/npm/ruby-head-wasm-wasi@0.4.0-2022-11-05-b/dist/ruby+stdlib.wasm'
      );
      const buffer = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(buffer, imports);
      await vm.setInstance(instance);

      wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
      (instance.exports._initialize as any)();
      vm.initialize(args);
      const setJupyterKernel = vm.eval(`-> (kernel) { $JUPYTER_KERNEL = kernel }`);
      setJupyterKernel.call("call", vm.wrap(this));
      return { vm, mainBind: vm.eval('binding') };
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

  async withWriter<R>(writer: IOWriter, body: () => Promise<R>): Promise<R> {
    const oldWriter = this._ioWriter;
    this._ioWriter = writer;
    try {
      const result = await body();
      return result;
    } finally {
      this._ioWriter = oldWriter;
    }
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
      (globalThis as any).RUBY_TMP_CODE = code;
      const writer: IOWriter = {
        write: (text, type) => {
          this.stream({ name: type, text });
        }
      };
      const result = await this.withWriter(writer, async () => {
        return await vm.evalAsync(`
          Kernel.eval(JS.global[:RUBY_TMP_CODE].to_s, TOPLEVEL_BINDING)
        `);
      });
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
    const { vm, mainBind } = await this.useVM();
    const completor = vm.eval(`
      require "irb/completion"
      ->(input, bind) { IRB::InputCompletor.retrieve_completion_data(input.to_s, bind: bind) }
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
    const items = rbArrayToArray(
      vm,
      completor.call('call', vm.wrap(line), mainBind)
    );

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
