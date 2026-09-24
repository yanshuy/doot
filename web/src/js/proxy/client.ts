import {
  REQUEST_BODY_CHUNK,
  REQUEST_END,
  REQUEST_ERROR,
  RESPONSE_BODY_CHUNK,
  RESPONSE_END,
  RESPONSE_ERROR,
  RESPONSE_HEADER,
} from "./http";
import { BUFFER_LOW_THRESHOLD, createDataChannelSink } from "./utils";

let reqCounter = 0;

export function handleClientProxyRequest(
  pc: RTCPeerConnection,
  head: ArrayBuffer,
  port: MessagePort,
  hasBody: boolean,
) {
  const dc = pc.createDataChannel(`req-${++reqCounter}`, { ordered: true });
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;

  let isClosed = false;
  const close = (responseType?: string) => {
    if (isClosed) return;
    isClosed = true;
    if (responseType) {
      port.postMessage({ type: responseType });
    }
    port.close();
    dc.close();
  };

  let requestStream: ReadableStream<Uint8Array<ArrayBuffer>> | null = null;
  if (hasBody) {
    requestStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        port.onmessage = (ev) => {
          switch (ev.data.type) {
            case REQUEST_BODY_CHUNK:
              controller.enqueue(new Uint8Array(ev.data.buffer));
              break;
            case REQUEST_END:
              controller.close();
              break;
            case REQUEST_ERROR:
              controller.error(new Error("Request stream failed"));
              close(RESPONSE_ERROR);
              break;
          }
        };
      },
    });
  }

  dc.onopen = async () => {
    try {
      dc.send(head);
      if (requestStream) {
        await requestStream.pipeTo(createDataChannelSink(dc));
        dc.send(new Uint8Array(0));
      }
    } catch (err) {
      console.error("[ProxyClient] Send error:", err);
      close(RESPONSE_ERROR);
    }
  };

  let isHeaderReceived = false;

  dc.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;

    if (!isHeaderReceived) {
      port.postMessage({ type: RESPONSE_HEADER, buffer: ev.data }, [ev.data]);
      isHeaderReceived = true;
    } else {
      port.postMessage({ type: RESPONSE_BODY_CHUNK, buffer: ev.data }, [ev.data]);
    }
  };

  dc.onclose = () => {
    if (!isHeaderReceived) {
      close(RESPONSE_ERROR);
    } else {
      close(RESPONSE_END);
    }
  };

  dc.onerror = (err) => {
    console.error(`[ProxyClient] DataChannel (${dc.label}) error:`, err);
    close(RESPONSE_ERROR);
  };
}
