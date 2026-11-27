type ExceptionDefinition = readonly [number, string];

export default class APIException extends Error {
    readonly code: number;
    readonly httpStatusCode?: number;

    constructor([code, defaultMessage]: ExceptionDefinition, message = defaultMessage, httpStatusCode?: number) {
        super(message);
        this.code = code;
        this.httpStatusCode = httpStatusCode;
    }

    compare([code]: ExceptionDefinition) {
        return this.code === code;
    }
}
