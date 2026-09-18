export type RequestData = {
  id: number;
  method: string;
  url: string;
  headersList: [string, any][];
  hasBody: boolean;
  serialized: ArrayBuffer;
};

export async function setupSW(
  tunnel: (serialized: ArrayBuffer) => Promise<ArrayBuffer>,
  statusEl?: HTMLElement | null,
  requestsEl?: HTMLElement | null,
) {
  if (!("serviceWorker" in navigator)) {
    if (statusEl) statusEl.innerText = "Error: Not supported";
    console.warn("Service Workers are not supported in this browser environment.");
    return;
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    await registration.update();
  } catch (error) {
    if (statusEl) statusEl.innerText = "Registration failed";
    console.error("Failed to register Service Worker:", error);
    return;
  }

  const sw =
    registration.installing || registration.waiting || registration.active;

  if (sw && statusEl) {
    statusEl.innerText = sw.state;
    sw.addEventListener("statechange", (ev) => {
      statusEl.innerText = (ev.target as ServiceWorker).state;
    });
  }

  try {
    await navigator.serviceWorker.ready;
    if (statusEl) statusEl.innerText = "active";
  } catch (e) {}

  navigator.serviceWorker.addEventListener(
    "message",
    async (ev: MessageEvent<any>) => {
      if (ev.data && ev.data.type === "request") {
        const data = ev.data as RequestData;
        if (requestsEl) addToTable(data, requestsEl);

        let resp: ArrayBuffer;
        try {
          resp = await tunnel(data.serialized);
        } catch (ex) {
          if (ex instanceof ArrayBuffer) {
            resp = ex;
          } else {
            const encoder = new TextEncoder();
            resp = encoder.encode("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\n\r\n<h1>502 Bad Gateway</h1>").buffer;
          }
        }

        const messagePayload = {
          type: "response",
          id: data.id,
          serialized: resp,
        };

        if (ev.source && "postMessage" in ev.source) {
          (ev.source as any).postMessage(messagePayload, [resp]);
        } else if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage(messagePayload, [resp]);
        } else if (registration.active) {
          registration.active.postMessage(messagePayload, [resp]);
        }
      }
    },
  );
}

function addToTable(
  { id, method, url, headersList }: RequestData,
  requestsEl: HTMLElement,
) {
  const tbody = requestsEl.querySelector("tbody");
  if (!tbody) return;

  const urlObj = new URL(url);
  const path = urlObj.pathname + urlObj.search;

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="mono-font">#${id}</td>
    <td><span class="method-badge ${method.toLowerCase()}">${method}</span></td>
    <td class="mono-font url-cell" title="${url}">${path}</td>
    <td class="mono-font">${headersList.length} headers</td>
  `;
  tbody.prepend(tr);
}
