export { CRLF, type RequestHead, parseRequestHead } from "./http";

export const BUFFER_LOW_THRESHOLD = 32 * 1024; // 32 KB
export const BUFFER_HIGH_THRESHOLD = 64 * 1024; // 64 KB

const drainEvents = ["bufferedamountlow", "close", "error"];

export function waitForDrain(dc: RTCDataChannel): Promise<void> {
    if (dc.readyState != "open" || dc.bufferedAmount <= dc.bufferedAmountLowThreshold) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const onDone = () => {
            drainEvents.forEach((event) => {
                dc.removeEventListener(event, onDone);
            });
            resolve();
        };

        drainEvents.forEach((event) => {
            dc.addEventListener(event, onDone);
        });
    });
}

export const MAX_CHUNK_SIZE = 64 * 1024; // 64 KB

export function createDataChannelSink(dc: RTCDataChannel): WritableStream<Uint8Array<ArrayBuffer>> {
    return new WritableStream<Uint8Array<ArrayBuffer>>({
        async write(chunk) {
            for (let offset = 0; offset < chunk.byteLength; offset += MAX_CHUNK_SIZE) {
                if (dc.bufferedAmount > BUFFER_HIGH_THRESHOLD) {
                    await waitForDrain(dc);
                    if (dc.readyState !== "open") {
                        throw new Error("RTCDataChannel closed during drain");
                    }
                }
                const slice = chunk.subarray(offset, offset + MAX_CHUNK_SIZE);
                dc.send(slice);
            }
        },

        abort: () => dc.close(),
    });
}