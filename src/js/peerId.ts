export const PEER_ID = (() => {
  if (typeof sessionStorage === "undefined") return crypto.randomUUID();
  let id = sessionStorage.getItem("peer_id");
  if (id == null) {
    id = crypto.randomUUID();
    sessionStorage.setItem("peer_id", id);
  }
  return id;
})();
