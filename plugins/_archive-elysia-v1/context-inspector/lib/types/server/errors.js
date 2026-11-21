export class InspectionError extends Error {
    code;
    constructor(code) {
        super('Context inspection failed: ' + code);
        this.code = code;
        this.name = 'InspectionError';
    }
}
//# sourceMappingURL=errors.js.map