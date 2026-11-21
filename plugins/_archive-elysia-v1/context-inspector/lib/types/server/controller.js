var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { InspectionError } from "./errors.js";
import { SnapshotReader } from "./reader.js";
let ContextInspector = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _latest_decorators;
    let _read_decorators;
    return class ContextInspector extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _latest_decorators = [Remote({ resources: { session: (request) => request.sessionId } })];
            _read_decorators = [Remote({ resources: { session: (request) => request.sessionId } })];
            __esDecorate(this, null, _latest_decorators, { kind: "method", name: "latest", static: false, private: false, access: { has: obj => "latest" in obj, get: obj => obj.latest }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _read_decorators, { kind: "method", name: "read", static: false, private: false, access: { has: obj => "read" in obj, get: obj => obj.read }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['typert', 'remoteAccess', 'sessionController'];
        reader = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, config) {
            super(ctx, 'contextInspector', { namespace: 'contextInspector' });
            this.reader = new SnapshotReader(config.dir, config);
            ctx.effect(() => async () => { await this.reader.dispose(); }, 'context-inspector.reader');
        }
        /** Read the selected session's latest indexed archived request without activating an agent. */
        async latest(request, signal) {
            try {
                return await this.reader.latest(request?.sessionId, signal);
            }
            catch (error) {
                throw publicError(error);
            }
        }
        /** Read one immutable archived section with an exact UTF-8 continuation cursor. */
        async read(request, signal) {
            try {
                return await this.reader.read(request, signal);
            }
            catch (error) {
                throw publicError(error);
            }
        }
    };
})();
export { ContextInspector };
function publicError(error) {
    const code = error instanceof InspectionError ? error.code : 'archive-unavailable';
    return new RemoteError(`contextInspector/${code}`, 'Request archive inspection failed', {});
}
//# sourceMappingURL=controller.js.map