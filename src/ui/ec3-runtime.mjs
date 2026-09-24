/* @mediabunny/ac3 1.59.1; Copyright Vanilagy and contributors; MPL-2.0. See EC3-LICENSE.txt. */

async function Module(moduleArg = {}) {
    var moduleRtn;
    var Module = moduleArg;
    var ENVIRONMENT_IS_WEB = !!globalThis.window;
    var ENVIRONMENT_IS_WORKER = !!globalThis.WorkerGlobalScope;
    var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";
    var arguments_ = [];
    var thisProgram = "./this.program";
    var quit_ = (status, toThrow) => { throw toThrow; };
    var _scriptName = import.meta.url;
    var scriptDirectory = "";
    var readAsync, readBinary;
    if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
        try {
            scriptDirectory = new URL(".", _scriptName).href;
        }
        catch { }
        {
            if (ENVIRONMENT_IS_WORKER) {
                readBinary = url => { var xhr = new XMLHttpRequest; xhr.open("GET", url, false); xhr.responseType = "arraybuffer"; xhr.send(null); return new Uint8Array(xhr.response); };
            }
            readAsync = async (url) => { var response = await fetch(url, { credentials: "same-origin" }); if (response.ok) {
                return response.arrayBuffer();
            } throw new Error(response.status + " : " + response.url); };
        }
    }
    else { }
    var out = console.log.bind(console);
    var err = console.error.bind(console);
    var wasmBinary;
    var ABORT = false;
    var EXITSTATUS;
    function binaryDecode(bin) { for (var i = 0, l = bin.length, o = new Uint8Array(l), c; i < l; ++i) {
        c = bin.charCodeAt(i);
        o[i] = ~c >> 8 & c;
    } return o; }
    var readyPromiseResolve, readyPromiseReject;
    var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;
    var HEAP64, HEAPU64;
    var runtimeInitialized = false;
    function updateMemoryViews() { var b = wasmMemory.buffer; HEAP8 = new Int8Array(b); HEAP16 = new Int16Array(b); Module["HEAPU8"] = HEAPU8 = new Uint8Array(b); HEAPU16 = new Uint16Array(b); HEAP32 = new Int32Array(b); HEAPU32 = new Uint32Array(b); HEAPF32 = new Float32Array(b); HEAPF64 = new Float64Array(b); HEAP64 = new BigInt64Array(b); HEAPU64 = new BigUint64Array(b); }
    function preRun() { if (Module["preRun"]) {
        if (typeof Module["preRun"] == "function")
            Module["preRun"] = [Module["preRun"]];
        while (Module["preRun"].length) {
            addOnPreRun(Module["preRun"].shift());
        }
    } callRuntimeCallbacks(onPreRuns); }
    function initRuntime() { runtimeInitialized = true; wasmExports["s"](); }
    function postRun() { if (Module["postRun"]) {
        if (typeof Module["postRun"] == "function")
            Module["postRun"] = [Module["postRun"]];
        while (Module["postRun"].length) {
            addOnPostRun(Module["postRun"].shift());
        }
    } callRuntimeCallbacks(onPostRuns); }
    function abort(what) { Module["onAbort"]?.(what); what = "Aborted(" + what + ")"; err(what); ABORT = true; what += ". Build with -sASSERTIONS for more info."; var e = new WebAssembly.RuntimeError(what); readyPromiseReject?.(e); throw e; }
    var wasmBinaryFile;
    function findWasmBinary() { return Module["wasmBinary"]; }
    function getBinarySync(file) { return file; }
    async function getWasmBinary(binaryFile) { return getBinarySync(binaryFile); }
    async function instantiateArrayBuffer(binaryFile, imports) { try {
        var binary = await getWasmBinary(binaryFile);
        var instance = await WebAssembly.instantiate(binary, imports);
        return instance;
    }
    catch (reason) {
        err(`failed to asynchronously prepare wasm: ${reason}`);
        abort(reason);
    } }
    async function instantiateAsync(binary, binaryFile, imports) { return instantiateArrayBuffer(binaryFile, imports); }
    function getWasmImports() { var imports = { a: wasmImports }; return imports; }
    async function createWasm() { function receiveInstance(instance, module) { wasmExports = instance.exports; assignWasmExports(wasmExports); updateMemoryViews(); return wasmExports; } function receiveInstantiationResult(result) { return receiveInstance(result["instance"]); } var info = getWasmImports(); if (Module["instantiateWasm"]) {
        return new Promise((resolve, reject) => { Module["instantiateWasm"](info, (inst, mod) => { resolve(receiveInstance(inst, mod)); }); });
    } wasmBinaryFile ??= findWasmBinary(); var result = await instantiateAsync(wasmBinary, wasmBinaryFile, info); var exports = receiveInstantiationResult(result); return exports; }
    class ExitStatus {
        constructor(status) {
            this.name = "ExitStatus";
            this.message = `Program terminated with exit(${status})`;
            this.status = status;
        }
    }
    var callRuntimeCallbacks = callbacks => { while (callbacks.length > 0) {
        callbacks.shift()(Module);
    } };
    var onPostRuns = [];
    var addOnPostRun = cb => onPostRuns.push(cb);
    var onPreRuns = [];
    var addOnPreRun = cb => onPreRuns.push(cb);
    var noExitRuntime = true;
    var UTF8Decoder = new TextDecoder;
    var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => { var maxIdx = idx + maxBytesToRead; if (ignoreNul)
        return maxIdx; while (heapOrArray[idx] && !(idx >= maxIdx))
        ++idx; return idx; };
    var UTF8ToString = (ptr, maxBytesToRead, ignoreNul) => { if (!ptr)
        return ""; var end = findStringEnd(HEAPU8, ptr, maxBytesToRead, ignoreNul); return UTF8Decoder.decode(HEAPU8.subarray(ptr, end)); };
    var SYSCALLS = { varargs: undefined, getStr(ptr) { var ret = UTF8ToString(ptr); return ret; } };
    function ___syscall_fcntl64(fd, cmd, varargs) { SYSCALLS.varargs = varargs; return 0; }
    function ___syscall_ioctl(fd, op, varargs) { SYSCALLS.varargs = varargs; return 0; }
    function ___syscall_openat(dirfd, path, flags, varargs) { SYSCALLS.varargs = varargs; }
    var __abort_js = () => abort("");
    var runtimeKeepaliveCounter = 0;
    var __emscripten_runtime_keepalive_clear = () => { noExitRuntime = false; runtimeKeepaliveCounter = 0; };
    var timers = {};
    var handleException = e => { if (e instanceof ExitStatus || e == "unwind") {
        return EXITSTATUS;
    } quit_(1, e); };
    var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
    var _proc_exit = code => { EXITSTATUS = code; if (!keepRuntimeAlive()) {
        Module["onExit"]?.(code);
        ABORT = true;
    } quit_(code, new ExitStatus(code)); };
    var exitJS = (status, implicit) => { EXITSTATUS = status; _proc_exit(status); };
    var _exit = exitJS;
    var maybeExit = () => { if (!keepRuntimeAlive()) {
        try {
            _exit(EXITSTATUS);
        }
        catch (e) {
            handleException(e);
        }
    } };
    var callUserCallback = func => { if (ABORT) {
        return;
    } try {
        func();
        maybeExit();
    }
    catch (e) {
        handleException(e);
    } };
    var _emscripten_get_now = () => performance.now();
    var __setitimer_js = (which, timeout_ms) => { if (timers[which]) {
        clearTimeout(timers[which].id);
        delete timers[which];
    } if (!timeout_ms)
        return 0; var id = setTimeout(() => { delete timers[which]; callUserCallback(() => __emscripten_timeout(which, _emscripten_get_now())); }, timeout_ms); timers[which] = { id, timeout_ms }; return 0; };
    var _emscripten_date_now = () => Date.now();
    var nowIsMonotonic = 1;
    var checkWasiClock = clock_id => clock_id >= 0 && clock_id <= 3;
    var INT53_MAX = 9007199254740992;
    var INT53_MIN = -9007199254740992;
    var bigintToI53Checked = num => num < INT53_MIN || num > INT53_MAX ? NaN : Number(num);
    function _clock_time_get(clk_id, ignored_precision, ptime) { ignored_precision = bigintToI53Checked(ignored_precision); if (!checkWasiClock(clk_id)) {
        return 28;
    } var now; if (clk_id === 0) {
        now = _emscripten_date_now();
    }
    else if (nowIsMonotonic) {
        now = _emscripten_get_now();
    }
    else {
        return 52;
    } var nsec = Math.round(now * 1e3 * 1e3); HEAP64[ptime >> 3] = BigInt(nsec); return 0; }
    var getHeapMax = () => 2147483648;
    var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
    var growMemory = size => { var oldHeapSize = wasmMemory.buffer.byteLength; var pages = (size - oldHeapSize + 65535) / 65536 | 0; try {
        wasmMemory.grow(pages);
        updateMemoryViews();
        return 1;
    }
    catch (e) { } };
    var _emscripten_resize_heap = requestedSize => { var oldSize = HEAPU8.length; requestedSize >>>= 0; var maxHeapSize = getHeapMax(); if (requestedSize > maxHeapSize) {
        return false;
    } for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + .2 / cutDown);
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
        var replacement = growMemory(newSize);
        if (replacement) {
            return true;
        }
    } return false; };
    var ENV = {};
    var getExecutableName = () => thisProgram || "./this.program";
    var getEnvStrings = () => { if (!getEnvStrings.strings) {
        var lang = (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8";
        var env = { USER: "web_user", LOGNAME: "web_user", PATH: "/", PWD: "/", HOME: "/home/web_user", LANG: lang, _: getExecutableName() };
        for (var x in ENV) {
            if (ENV[x] === undefined)
                delete env[x];
            else
                env[x] = ENV[x];
        }
        var strings = [];
        for (var x in env) {
            strings.push(`${x}=${env[x]}`);
        }
        getEnvStrings.strings = strings;
    } return getEnvStrings.strings; };
    var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => { if (!(maxBytesToWrite > 0))
        return 0; var startIdx = outIdx; var endIdx = outIdx + maxBytesToWrite - 1; for (var i = 0; i < str.length; ++i) {
        var u = str.codePointAt(i);
        if (u <= 127) {
            if (outIdx >= endIdx)
                break;
            heap[outIdx++] = u;
        }
        else if (u <= 2047) {
            if (outIdx + 1 >= endIdx)
                break;
            heap[outIdx++] = 192 | u >> 6;
            heap[outIdx++] = 128 | u & 63;
        }
        else if (u <= 65535) {
            if (outIdx + 2 >= endIdx)
                break;
            heap[outIdx++] = 224 | u >> 12;
            heap[outIdx++] = 128 | u >> 6 & 63;
            heap[outIdx++] = 128 | u & 63;
        }
        else {
            if (outIdx + 3 >= endIdx)
                break;
            heap[outIdx++] = 240 | u >> 18;
            heap[outIdx++] = 128 | u >> 12 & 63;
            heap[outIdx++] = 128 | u >> 6 & 63;
            heap[outIdx++] = 128 | u & 63;
            i++;
        }
    } heap[outIdx] = 0; return outIdx - startIdx; };
    var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);
    var _environ_get = (__environ, environ_buf) => { var bufSize = 0; var envp = 0; for (var string of getEnvStrings()) {
        var ptr = environ_buf + bufSize;
        HEAPU32[__environ + envp >> 2] = ptr;
        bufSize += stringToUTF8(string, ptr, Infinity) + 1;
        envp += 4;
    } return 0; };
    var lengthBytesUTF8 = str => { var len = 0; for (var i = 0; i < str.length; ++i) {
        var c = str.charCodeAt(i);
        if (c <= 127) {
            len++;
        }
        else if (c <= 2047) {
            len += 2;
        }
        else if (c >= 55296 && c <= 57343) {
            len += 4;
            ++i;
        }
        else {
            len += 3;
        }
    } return len; };
    var _environ_sizes_get = (penviron_count, penviron_buf_size) => { var strings = getEnvStrings(); HEAPU32[penviron_count >> 2] = strings.length; var bufSize = 0; for (var string of strings) {
        bufSize += lengthBytesUTF8(string) + 1;
    } HEAPU32[penviron_buf_size >> 2] = bufSize; return 0; };
    var _fd_close = fd => 52;
    var _fd_fdstat_get = (fd, pbuf) => { var rightsBase = 0; var rightsInheriting = 0; var flags = 0; {
        var type = 2;
        if (fd == 0) {
            rightsBase = 2;
        }
        else if (fd == 1 || fd == 2) {
            rightsBase = 64;
        }
        flags = 1;
    } HEAP8[pbuf] = type; HEAP16[pbuf + 2 >> 1] = flags; HEAP64[pbuf + 8 >> 3] = BigInt(rightsBase); HEAP64[pbuf + 16 >> 3] = BigInt(rightsInheriting); return 0; };
    var _fd_read = (fd, iov, iovcnt, pnum) => 52;
    function _fd_seek(fd, offset, whence, newOffset) { offset = bigintToI53Checked(offset); return 70; }
    var printCharBuffers = [null, [], []];
    var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => { var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul); return UTF8Decoder.decode(heapOrArray.buffer ? heapOrArray.subarray(idx, endPtr) : new Uint8Array(heapOrArray.slice(idx, endPtr))); };
    var printChar = (stream, curr) => { var buffer = printCharBuffers[stream]; if (curr === 0 || curr === 10) {
        (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
        buffer.length = 0;
    }
    else {
        buffer.push(curr);
    } };
    var _fd_write = (fd, iov, iovcnt, pnum) => { var num = 0; for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[iov >> 2];
        var len = HEAPU32[iov + 4 >> 2];
        iov += 8;
        for (var j = 0; j < len; j++) {
            printChar(fd, HEAPU8[ptr + j]);
        }
        num += len;
    } HEAPU32[pnum >> 2] = num; return 0; };
    var getCFunc = ident => { var func = Module["_" + ident]; return func; };
    var writeArrayToMemory = (array, buffer) => { HEAP8.set(array, buffer); };
    var stackAlloc = sz => __emscripten_stack_alloc(sz);
    var stringToUTF8OnStack = str => { var size = lengthBytesUTF8(str) + 1; var ret = stackAlloc(size); stringToUTF8(str, ret, size); return ret; };
    var stackSave = () => _emscripten_stack_get_current();
    var stackRestore = val => __emscripten_stack_restore(val);
    var ccall = (ident, returnType, argTypes, args, opts) => { var toC = { string: str => { var ret = 0; if (str !== null && str !== undefined && str !== 0) {
            ret = stringToUTF8OnStack(str);
        } return ret; }, array: arr => { var ret = stackAlloc(arr.length); writeArrayToMemory(arr, ret); return ret; } }; function convertReturnValue(ret) { if (returnType === "string") {
        return UTF8ToString(ret);
    } if (returnType === "boolean")
        return Boolean(ret); return ret; } var func = getCFunc(ident); var cArgs = []; var stack = 0; if (args) {
        for (var i = 0; i < args.length; i++) {
            var converter = toC[argTypes[i]];
            if (converter) {
                if (stack === 0)
                    stack = stackSave();
                cArgs[i] = converter(args[i]);
            }
            else {
                cArgs[i] = args[i];
            }
        }
    } var ret = func(...cArgs); function onDone(ret) { if (stack !== 0)
        stackRestore(stack); return convertReturnValue(ret); } ret = onDone(ret); return ret; };
    var cwrap = (ident, returnType, argTypes, opts) => { var numericArgs = !argTypes || argTypes.every(type => type === "number" || type === "boolean"); var numericRet = returnType !== "string"; if (numericRet && numericArgs && !opts) {
        return getCFunc(ident);
    } return (...args) => ccall(ident, returnType, argTypes, args, opts); };
    for (var base64ReverseLookup = new Uint8Array(123), i = 25; i >= 0; --i) {
        base64ReverseLookup[48 + i] = 52 + i;
        base64ReverseLookup[65 + i] = i;
        base64ReverseLookup[97 + i] = 26 + i;
    }
    base64ReverseLookup[43] = 62;
    base64ReverseLookup[47] = 63;
    {
        if (Module["noExitRuntime"])
            noExitRuntime = Module["noExitRuntime"];
        if (Module["print"])
            out = Module["print"];
        if (Module["printErr"])
            err = Module["printErr"];
        if (Module["wasmBinary"])
            wasmBinary = Module["wasmBinary"];
        if (Module["arguments"])
            arguments_ = Module["arguments"];
        if (Module["thisProgram"])
            thisProgram = Module["thisProgram"];
        if (Module["preInit"]) {
            if (typeof Module["preInit"] == "function")
                Module["preInit"] = [Module["preInit"]];
            while (Module["preInit"].length > 0) {
                Module["preInit"].shift()();
            }
        }
    }
    Module["cwrap"] = cwrap;
    var _init_decoder, _malloc, _configure_decode_packet, _decode_packet, _get_decoded_format, _get_decoded_plane_ptr, _get_decoded_channels, _get_decoded_sample_rate, _get_decoded_sample_count, _get_decoded_pts, _flush_decoder, _close_decoder, _free, _init_encoder, _get_encoder_frame_size, _get_encode_input_ptr, _encode_frame, _flush_encoder, _get_encoded_data, _get_encoded_pts, _get_encoded_duration, _close_encoder, __emscripten_timeout, __emscripten_stack_restore, __emscripten_stack_alloc, _emscripten_stack_get_current, memory, __indirect_function_table, wasmMemory;
    function assignWasmExports(wasmExports) { _init_decoder = Module["_init_decoder"] = wasmExports["t"]; _malloc = Module["_malloc"] = wasmExports["u"]; _configure_decode_packet = Module["_configure_decode_packet"] = wasmExports["v"]; _decode_packet = Module["_decode_packet"] = wasmExports["w"]; _get_decoded_format = Module["_get_decoded_format"] = wasmExports["x"]; _get_decoded_plane_ptr = Module["_get_decoded_plane_ptr"] = wasmExports["y"]; _get_decoded_channels = Module["_get_decoded_channels"] = wasmExports["z"]; _get_decoded_sample_rate = Module["_get_decoded_sample_rate"] = wasmExports["A"]; _get_decoded_sample_count = Module["_get_decoded_sample_count"] = wasmExports["B"]; _get_decoded_pts = Module["_get_decoded_pts"] = wasmExports["C"]; _flush_decoder = Module["_flush_decoder"] = wasmExports["D"]; _close_decoder = Module["_close_decoder"] = wasmExports["E"]; _free = Module["_free"] = wasmExports["F"]; _init_encoder = Module["_init_encoder"] = wasmExports["G"]; _get_encoder_frame_size = Module["_get_encoder_frame_size"] = wasmExports["H"]; _get_encode_input_ptr = Module["_get_encode_input_ptr"] = wasmExports["I"]; _encode_frame = Module["_encode_frame"] = wasmExports["J"]; _flush_encoder = Module["_flush_encoder"] = wasmExports["K"]; _get_encoded_data = Module["_get_encoded_data"] = wasmExports["L"]; _get_encoded_pts = Module["_get_encoded_pts"] = wasmExports["M"]; _get_encoded_duration = Module["_get_encoded_duration"] = wasmExports["N"]; _close_encoder = Module["_close_encoder"] = wasmExports["O"]; __emscripten_timeout = wasmExports["P"]; __emscripten_stack_restore = wasmExports["Q"]; __emscripten_stack_alloc = wasmExports["R"]; _emscripten_stack_get_current = wasmExports["S"]; memory = wasmMemory = wasmExports["r"]; __indirect_function_table = wasmExports["__indirect_function_table"]; }
    var wasmImports = { a: ___syscall_fcntl64, q: ___syscall_ioctl, n: ___syscall_openat, f: __abort_js, k: __emscripten_runtime_keepalive_clear, l: __setitimer_js, e: _clock_time_get, d: _emscripten_date_now, m: _emscripten_resize_heap, b: _environ_get, c: _environ_sizes_get, i: _fd_close, p: _fd_fdstat_get, h: _fd_read, o: _fd_seek, g: _fd_write, j: _proc_exit };
    function run() { preRun(); function doRun() { Module["calledRun"] = true; if (ABORT)
        return; initRuntime(); readyPromiseResolve?.(Module); Module["onRuntimeInitialized"]?.(); postRun(); } if (Module["setStatus"]) {
        Module["setStatus"]("Running...");
        setTimeout(() => { setTimeout(() => Module["setStatus"](""), 1); doRun(); }, 1);
    }
    else {
        doRun();
    } }
    var wasmExports;
    wasmExports = await (createWasm());
    run();
    if (runtimeInitialized) {
        moduleRtn = Module;
    }
    else {
        moduleRtn = new Promise((resolve, reject) => { readyPromiseResolve = resolve; readyPromiseReject = reject; });
    }
    ;
    return moduleRtn;
}
export default Module;