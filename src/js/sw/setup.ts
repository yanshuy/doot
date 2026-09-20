import { PROXY_REQUEST_START } from "./sw";

export type RequestStreamHandler = (
  head: ArrayBuffer,
  port: MessagePort,
  hasBody: boolean
) => void;

export async function setupSW(
  onProxyRequest: RequestStreamHandler,
  statusEl?: HTMLElement | null,
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

  await navigator.serviceWorker.ready;
  if (statusEl) statusEl.innerText = "active";

  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === PROXY_REQUEST_START) {
      const { head, hasBody } = ev.data;
      const port = ev.ports[0];

      onProxyRequest(head, port, hasBody);
    }
  });
}
