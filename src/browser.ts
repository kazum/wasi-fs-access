// Copyright 2020 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { IDisposable } from 'xterm';
import Bindings, { OpenFlags, stringOut } from './bindings.js';
import { FileOrDir, OpenFiles } from './fileSystem.js';

declare const Terminal: typeof import('xterm').Terminal;
declare const LocalEchoController: any;
declare const FitAddon: typeof import('xterm-addon-fit');
declare const WebLinksAddon: typeof import('xterm-addon-web-links');

// Backports for new APIs to Chromium <=85.
let hasSupport = true;
try {
  navigator.storage.getDirectory ??= () =>
    FileSystemDirectoryHandle.getSystemDirectory({
      type: 'sandbox'
    });
  FileSystemDirectoryHandle.prototype.getDirectoryHandle ??=
    FileSystemDirectoryHandle.prototype.getDirectory;
  FileSystemDirectoryHandle.prototype.getFileHandle ??=
    FileSystemDirectoryHandle.prototype.getFile;
  FileSystemDirectoryHandle.prototype.values ??= function (
    this: FileSystemDirectoryHandle
  ) {
    return this.getEntries()[Symbol.asyncIterator]();
  };
  globalThis.showDirectoryPicker ??= () =>
    chooseFileSystemEntries({
      type: 'open-directory'
    });
  if (!('kind' in FileSystemHandle.prototype)) {
    Object.defineProperty(FileSystemHandle.prototype, 'kind', {
      get(this: FileSystemHandle): FileSystemHandleKind {
        return this.isFile ? 'file' : 'directory';
      }
    });
  }
} catch {
  hasSupport = false;
}

(async () => {
  let term = new Terminal();

  let fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  let localEcho = new LocalEchoController();
  let pythonModulePromise: Promise<WebAssembly.Module> | null = null;
  let knownCommands = ['help', 'mount', 'cd', 'coder', 'python', 'python3'];
  localEcho.addAutocompleteHandler((index: number): string[] =>
    index === 0 ? knownCommands : []
  );
  {
    let storedHistory = localStorage.getItem('command-history');
    if (storedHistory) {
      localEcho.history.entries = storedHistory.split('\n');
      localEcho.history.rewind();
    }
  }
  term.loadAddon(localEcho);

  term.loadAddon(new WebLinksAddon.WebLinksAddon());

  term.open(document.body);
  fitAddon.fit();
  onresize = () => fitAddon.fit();

  const ANSI_GRAY = '\x1B[38;5;251m';
  const ANSI_BLUE = '\x1B[34;1m';
  const ANSI_RESET = '\x1B[0m';

  function writeIndented(s: string) {
    term.write(
      s
        .trimStart()
        .replace(/\n +/g, '\r\n')
        .replace(/https:\S+/g, ANSI_BLUE + '$&' + ANSI_RESET)
        .replace(/^#.*$/gm, ANSI_GRAY + '$&' + ANSI_RESET)
    );
  }

  writeIndented(`
    # Welcome to a shell powered by WebAssembly, WASI, Asyncify and File System Access API!
    # Github repo with the source code and details: https://github.com/GoogleChromeLabs/wasi-fs-access

  `);
  if (!hasSupport) {
    writeIndented(`
      Looks like your browser doesn't have support for the File System Access API yet.
      Please try a Chromium-based browser such as Google Chrome or Microsoft Edge.
    `);
    return;
  }

  const module = WebAssembly.compileStreaming(fetch('./coreutils.async.wasm'));

  // This is just for the autocomplete, so spawn the task and ignore any errors.
  (async () => {
    let helpStr = '';

    await new Bindings({
      openFiles: new OpenFiles({}),
      args: ['--help'],
      stdout: stringOut(chunk => (helpStr += chunk))
    }).run(await module);

    knownCommands = knownCommands.concat(
      helpStr
        .match(/Currently defined functions\/utilities:(.*)/s)![1]
        .match(/[\w-]+/g)!
    );
  })();

  writeIndented(`
    # Right now you have /sandbox mounted to a persistent sandbox filesystem:
    $ df -a
    Filesystem          1k-blocks         Used    Available  Use% Mounted on
    wasi                        0            0            0     - /sandbox

    # To mount a real directory, use command
    $ mount /mount/point
    # and choose a source in the dialogue.

    # To start the AI coding assistant, use
    $ coder

    # Happy hacking!
  `);

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const createStdin = (term: any, textEncoder: TextEncoder) => {
    let onData: IDisposable | undefined;
    let dataBuffer: Uint8Array[] = [];
    let resolveRead: (() => void) | undefined;
    let lineBuffer = '';

    onData = term.onData((chunk: string) => {
      // Handle paste (chunk can be multiple chars)
      for (const char of chunk) {
        if (char === '\x03') {
          // Ctrl+C handled globally
          continue;
        }
        if (char === '\x04') { // Ctrl+D (EOF)
          if (lineBuffer.length === 0) {
            dataBuffer.push(new Uint8Array(0));
            if (resolveRead) { resolveRead(); resolveRead = undefined; }
          }
          continue;
        }
        if (char === '\r') {
          term.write('\r\n');
          lineBuffer += '\n';
          dataBuffer.push(textEncoder.encode(lineBuffer));
          lineBuffer = '';
          if (resolveRead) { resolveRead(); resolveRead = undefined; }
          continue;
        }
        if (char === '\x7F') { // Backspace
          if (lineBuffer.length > 0) {
            term.write('\b \b');
            lineBuffer = lineBuffer.slice(0, -1);
          }
          continue;
        }
        // Normal char
        term.write(char);
        lineBuffer += char;
      }
    });

    return {
      read: async () => {
        if (dataBuffer.length === 0) {
          await new Promise<void>(r => resolveRead = r);
        }
        return dataBuffer.shift() || new Uint8Array(0);
      },
      dispose: () => {
        if (onData) onData.dispose();
      }
    };
  };

  const stdout = {
    write(data: Uint8Array) {
      term.write(
        textDecoder.decode(data, { stream: true }).replaceAll('\n', '\r\n')
      );
    }
  };

  const cmdParser = /(?:'(.*?)'|"(.*?)"|(\S+))\s*/gsuy;

  let preOpens: Record<string, FileSystemDirectoryHandle> = {};
  preOpens['/sandbox'] = await navigator.storage.getDirectory();

  let pwd = '/sandbox';

  async function executeCommand(line: string) {
    let args = Array.from(
      line.matchAll(cmdParser),
      ([, s1, s2, s3]) => {
        if (s2 !== undefined) {
          return s2
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
        }
        return s1 ?? s3;
      }
    );
    if (!args.length) {
      return;
    }
    if (args[0].startsWith('#')) {
      return;
    }
    switch (args[0]) {
      case 'help':
        args[0] = '--help';
        break;
      case 'mount': {
        let dest = args[1];
        if (!dest || dest === '--help' || !dest.startsWith('/')) {
          term.writeln(
            'Provide a desination mount point like "mount /work" and choose a source in the dialogue.'
          );
          return;
        }

        // Prevent nested mounts (User requested restriction to avoid errors)
        for (const mountPoint of Object.keys(preOpens)) {
          if (dest === mountPoint) continue; // Allow overwrite
          // Check if dest is inside an existing mount
          // Ensure proper path boundary check (e.g. /sand vs /sandbox)
          const mpSlash = mountPoint.endsWith('/') ? mountPoint : mountPoint + '/';
          if (dest.startsWith(mpSlash)) {
            term.writeln(`Error: Nested mounts are not supported (${dest} is inside ${mountPoint}).`);
            term.writeln('Please mount at a new top-level directory (e.g. /work, /data).');
            return;
          }
          // Check if dest contains an existing mount
          const destSlash = dest.endsWith('/') ? dest : dest + '/';
          if (mountPoint.startsWith(destSlash)) {
            term.writeln(`Error: Cannot mount parent ${dest} because ${mountPoint} is already mounted.`);
            return;
          }
        }

        let src = (preOpens[dest] = await showDirectoryPicker());
        // Explicitly request write access immediately to prevent permission errors later
        // during async AI execution (execution within AI response loop might lack user activation)
        if ((await src.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          const perm = await src.requestPermission({ mode: 'readwrite' });
          if (perm !== 'granted') {
            term.writeln('Warning: Write permission was denied. Some operations may fail.');
          }
        }

        term.writeln(
          `Successfully mounted (...host path...)/${src.name} at ${dest}.`
        );
        return;
      }
      case 'cd': {
        let dest = args[1];
        if (dest) {
          // Resolve against the current working dir.
          dest = new URL(dest, `file://${pwd}/`).pathname;
          if (dest.endsWith('/')) {
            dest = dest.slice(0, -1) || '/';
          }
          let openFiles = new OpenFiles(preOpens);
          let { preOpen, relativePath } = openFiles.findRelPath(dest);
          await preOpen.getFileOrDir(
            relativePath,
            FileOrDir.Dir,
            OpenFlags.Directory
          );
          // We got here without failing, set the new working dir.
          pwd = dest;
        } else {
          term.writeln('Provide the directory argument.');
        }
        return;
      }
      case 'coder': {
        // 1. Initialize Engine if needed
        if (!(window as any).engine) {
          term.writeln('Initializing WebLLM (Qwen2.5-Coder)... (First run downloads model)');
          try {
            // @ts-ignore
            const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
            (window as any).engine = await CreateMLCEngine(
              'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',
              { initProgressCallback: (report: { text: string }) => term.write(`\r\x1B[K${report.text}`) }
            );
            term.writeln('\r\x1B[KModel loaded.');
            (window as any).messages = [
              { role: "system", content: "You are a helpful coding assistant running in a WebAssembly shell. You can execute commands by outputting a bash code block. To manipulate files, output the command in a ```bash ... ``` block. I will execute it and give you the output.\nIMPORTANT: If you want to run a python script, you MUST first create the file using `cat` or `echo` before running it.\nTo create multi-line files, use `printf` with `\\n` (e.g. `printf \"import os\\nprint('hello')\" > hello.py`) OR use multiple `echo` commands appending to the file.\nDO NOT use interactive `cat` (e.g. `cat > file`) or multi-line strings (e.g. `echo \"\"\"...\"\"\"`) as they will fail.\nExample:\n```bash\nprintf \"print('hello')\\nprint('world')\" > hello.py\npython hello.py\n```" }
            ];
          } catch (err) {
            term.writeln(`\r\x1B[KError loading model: ${(err as Error).message}`);
            return;
          }
        }

        // 2. Define Helper for one turn of conversation
        const processChatTurn = async (input: string) => {
          (window as any).messages.push({ role: "user", content: input });

          while (true) {
            term.write('AI: ');
            try {
              const chunks = await (window as any).engine.chat.completions.create({
                messages: (window as any).messages,
                stream: true
              });
              let fullResponse = "";
              for await (const chunk of chunks) {
                const content = chunk.choices[0]?.delta?.content || "";
                fullResponse += content;
                term.write(content.replace(/\n/g, '\r\n'));
              }
              term.writeln('');
              (window as any).messages.push({ role: "assistant", content: fullResponse });

              // Check for bash code blocks
              const bashBlockRegex = /```bash\n([\s\S]*?)\n```/g;
              let match;
              let commands: string[] = [];
              while ((match = bashBlockRegex.exec(fullResponse)) !== null) {
                commands.push(match[1]);
              }

              if (commands.length > 0) {
                term.writeln('\n[Executing commands directly...]');
                for (const cmd of commands) {
                  const lines = cmd.split('\n');
                  for (const line of lines) {
                    if (line.trim()) {
                      term.writeln(`\n$ ${line}`);
                      let outputBuffer = "";
                      const originalWrite = stdout.write;
                      stdout.write = (data: Uint8Array) => {
                        outputBuffer += textDecoder.decode(data, { stream: true });
                        originalWrite.call(stdout, data);
                      };
                      try {
                        await executeCommand(line);
                      } catch (e) {
                        outputBuffer += `Error: ${(e as Error).message}`;
                      } finally {
                        stdout.write = originalWrite;
                      }
                      (window as any).messages.push({
                        role: "user",
                        content: `Command executed: ${line}\nOutput:\n${outputBuffer}`
                      });
                    }
                  }
                }
                continue; // Continue loop specifically for tool use
              } else {
                break; // Done with this turn
              }
            } catch (err) {
              term.writeln(`Error generating response: ${(err as Error).message}`);
              break;
            }
          }
        };

        // 3. Handle Mode
        if (args.length > 1) {
          // Single-shot
          await processChatTurn(args.slice(1).join(' '));
        } else {
          // Interactive CLI Loop
          term.writeln('Welcome to Coder CLI. Type /help for commands, /exit to quit.');
          while (true) {
            const line = await localEcho.read('(coder) > ');
            if (!line.trim()) continue;

            if (line.startsWith('/')) {
              const [cmd] = line.split(' ');
              switch (cmd) {
                case '/exit':
                  return;
                case '/clear':
                  (window as any).messages = [(window as any).messages[0]];
                  term.writeln('Context cleared.');
                  break;
                case '/help':
                  term.writeln('Commands:');
                  term.writeln('  /exit   - Exit coder mode');
                  term.writeln('  /clear  - Clear conversation history');
                  term.writeln('  /help   - Show this help message');
                  break;
                default:
                  term.writeln(`Unknown command: ${cmd}`);
              }
              continue;
            }

            await processChatTurn(line);
          }
        }
        return;
      }
      case 'python':
      case 'python3': {
        if (!(window as any).pyodide) {
          term.writeln('Loading Pyodide environment...');
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load pyodide script'));
            document.body.appendChild(script);
          });

          (window as any).pyodide = await (window as any).loadPyodide({
            stdout: (text: string) => {
              const data = textEncoder.encode(text + '\n');
              stdout.write(data);
            },
            stderr: (text: string) => {
              const data = textEncoder.encode(text + '\n');
              stdout.write(data);
            }
          });
          term.writeln('Python environment ready.');
        }

        const pyodide = (window as any).pyodide;
        // Refresh mounts from preOpens to ensure visibility of all mounted directories
        const mountPairs = Object.entries(preOpens)
          .map(([k, v]) => {
            const path = k.endsWith('/') && k.length > 1 ? k.slice(0, -1) : k;
            return [path, v] as [string, FileSystemDirectoryHandle];
          })
          .sort((a, b) => a[0].length - b[0].length);

        // Unmount in reverse order (deepest first)
        for (const [mountDir] of [...mountPairs].reverse()) {
          try { pyodide.FS.unmount(mountDir); } catch (e) { }
        }

        // Mount in forward order (parents first)
        for (const [mountDir, handle] of mountPairs) {
          // Create hierarchy if missing
          const parts = mountDir.split('/').filter(p => p);
          let current = '';
          for (const part of parts) {
            current += '/' + part;
            try {
              if (!pyodide.FS.analyzePath(current).exists) {
                pyodide.FS.mkdir(current);
              }
            } catch (e) { }
          }

          try {
            await pyodide.mountNativeFS(mountDir, handle);
          } catch (e) {
            term.writeln(`Warning: Failed to mount ${mountDir}: ${(e as Error).message}`);
          }
        }

        localEcho.detach();
        try {
          if (args[1] === '-c') {
            const code = args[2];
            await pyodide.runPythonAsync(code);
          } else if (args[1]) {
            let filename = args[1];
            let fullPath = filename.startsWith('/') ? filename : `${pwd}/${filename}`.replace('//', '/');
            const code = `
import sys
import runpy
sys.argv = ${JSON.stringify(args.slice(1))}
# Add sandbox to path so imports work
if '/sandbox' not in sys.path:
    sys.path.append('/sandbox')

try:
    runpy.run_path('${fullPath}', run_name='__main__')
except SystemExit as e:
    pass # Handle exit() gracefully
`;
            await pyodide.runPythonAsync(code);
          } else {
            term.writeln('Usage: python <file> or python -c "code"');
          }
        } catch (err) {
          term.writeln(`Python Error: ${(err as Error).message}`);
        } finally {
          localEcho.attach();
          // Cleanup: Unmount only
          for (const [mountDir] of [...mountPairs].reverse()) {
            try { pyodide.FS.unmount(mountDir); } catch (e) { }
          }
        }
        return;
      }
    }
    let openFiles = new OpenFiles(preOpens);
    let redirectedStdout;
    if (['>', '>>'].includes(args[args.length - 2])) {
      let path = args.pop()!;
      // Resolve against the current working dir.
      path = new URL(path, `file://${pwd}/`).pathname;
      let { preOpen, relativePath } = openFiles.findRelPath(path);
      let handle = await preOpen.getFileOrDir(
        relativePath,
        FileOrDir.File,
        OpenFlags.Create
      );
      if (args.pop() === '>') {
        // @ts-ignore
        redirectedStdout = await handle.createWritable();
      } else {
        // @ts-ignore
        redirectedStdout = await handle.createWritable({ keepExistingData: true });
        redirectedStdout.seek((await handle.getFile()).size);
      }
    }
    localEcho.detach();
    let cmdStdin = createStdin(term, textEncoder);
    let abortController = new AbortController();
    let ctrlCHandler = term.onData(s => {
      if (s === '\x03') {
        term.write('^C');
        abortController.abort();
      }
    });
    try {
      let statusCode = await new Bindings({
        abortSignal: abortController.signal,
        openFiles,
        stdin: cmdStdin,
        stdout: redirectedStdout ?? stdout,
        stderr: stdout,
        args: ['$', ...args],
        env: {
          RUST_BACKTRACE: '1',
          PWD: pwd
        }
      }).run(await module);
      if (statusCode !== 0) {
        term.writeln(`Exit code: ${statusCode}`);
      }
    } finally {
      cmdStdin.dispose();
      ctrlCHandler.dispose();
      localEcho.attach();
      if (redirectedStdout) {
        await redirectedStdout.close();
      }
    }
  }

  while (true) {
    let line: string = await localEcho.read(`${pwd}$ `);
    localEcho.history.rewind();
    localStorage.setItem(
      'command-history',
      localEcho.history.entries.join('\n')
    );
    try {
      await executeCommand(line);
    } catch (err) {
      term.writeln((err as Error).message);
    }
  }
})();
