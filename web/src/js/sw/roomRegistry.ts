import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export const TUNNEL_PARAM = "__tunnel";

const DB_NAME = "doot_sw_db";
const DB_VERSION = 1;
const STORE_NAME = "client_rooms";

interface DootSWDB extends DBSchema {
  [STORE_NAME]: {
    key: string;
    value: string;
  };
}


let dbPromise: Promise<IDBPDatabase<DootSWDB>> | null = null;

const registry = new Map<string, string>();

function getDB(): Promise<IDBPDatabase<DootSWDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DootSWDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

export async function saveClientRoom(clientId: string, roomId: string): Promise<void> {
  registry.set(clientId, roomId);
  try {
    const db = await getDB();
    await db.put(STORE_NAME, roomId, clientId);
  } catch (err) {
    console.error("[SW RoomRegistry] Failed to save client room:", err);
  }
}


export async function getClientRoom(clientId: string): Promise<string | null> {
  if (registry.has(clientId)) {
    return registry.get(clientId)!;
  }

  try {
    const db = await getDB();
    const roomId = await db.get(STORE_NAME, clientId);
    if (roomId) {
      registry.set(clientId, roomId);
      return roomId;
    }
  } catch (err) {
    console.error("[SW RoomRegistry] Failed to get client room:", err);
  }

  return null;
}

export async function removeClientRoom(clientId: string): Promise<void> {
  registry.delete(clientId);
  try {
    const db = await getDB();
    await db.delete(STORE_NAME, clientId);
  } catch (err) {
    console.error("[SW RoomRegistry] Failed to remove client room:", err);
  }
}


export function extractTunnel(
  url: URL,
) {
  const room = url.searchParams.get(TUNNEL_PARAM);
  if (room) {
    const cleanParams = new URLSearchParams(url.search);
    cleanParams.delete(TUNNEL_PARAM);
    const queryStr = cleanParams.toString();
    const targetPath = url.pathname + (queryStr ? `?${queryStr}` : "");
    return { roomId: room, targetPath };
  }
  return null;
}
